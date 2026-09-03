// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedPatterns, TEST_DRAFT_PATTERN, TEST_PATTERNS } from "./patternFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import { isLocalPatternFixturesAllowed, type Env } from "../src/env";
import {
  isValidPatternSlug,
  validatePatternEvidenceFilter,
  validatePatternLimit,
  validatePatternPage,
  validatePatternSearch,
  validatePatternSort,
  PATTERNS_MAX_LIMIT,
} from "../src/lib/patternsValidation";
import { getPatternDetail, getPatternProgress, listPatterns } from "../src/services/patternsService";
import { handlePatternsRequest } from "../src/routes/patterns";

/* Sprint 6 v1.0 — seções 6.2 e 6.3 da ordem. Mesmo padrão de
   worker/testing/schedule.test.ts: SQLite real por trás do FakeD1Database,
   sessão real criada pelos repositórios de produção, rota exercitada de
   ponta a ponta com Request/Response reais. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  seedPatterns(db.sqlite);
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
}

async function seedUserWithSession(id: string): Promise<string> {
  await seedUser(id);
  const rawToken = `session-token-${id}`;
  await createSession(db as never, {
    id: `${id}-session`,
    userId: id,
    tokenHash: await sha256Hex(rawToken),
    sessionVersion: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userAgent: null,
  });
  return rawToken;
}

/** Insere progresso REAL de um aluno num padrão — só nos testes que precisam
 *  provar o caminho "com evidência". Nenhum código de produção faz isso. */
function seedProgress(
  userId: string,
  patternId: string,
  values: { recognition?: number | null; resolution?: number | null; mastery?: number | null; lastPracticedAt?: string } = {}
): void {
  db.sqlite
    .prepare(
      `INSERT INTO student_pattern_progress
         (user_id, pattern_id, last_practiced_at, raw_evidence_count, recognition_index, resolution_index, mastery_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      patternId,
      values.lastPracticedAt ?? null,
      3,
      values.recognition ?? null,
      values.resolution ?? null,
      values.mastery ?? null
    );
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db as never,
    ASSETS: {} as never,
    ENVIRONMENT: "development",
    ENABLE_LOCAL_PATTERN_FIXTURES: "true",
    ...overrides,
  };
}

function requestWithCookie(path: string, token: string | null, origin = LOCAL_ORIGIN): Request {
  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  return new Request(`${origin}${path}`, { method: "GET", headers });
}

async function callRoute(path: string, token: string | null, env: Env = localEnv(), origin = LOCAL_ORIGIN) {
  const request = requestWithCookie(path, token, origin);
  const url = new URL(request.url);
  const response = await handlePatternsRequest(request, env, url);
  return response!;
}

function countRows(table: string): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number }).total;
}

/* ---------------------------------------------------------------------- */
/* 6.2 — matriz do gate local                                              */
/* ---------------------------------------------------------------------- */

describe("isLocalPatternFixturesAllowed — três condições obrigatórias (ambiente + flag local + hostname)", () => {
  function envWith(overrides: Partial<Env>): Env {
    return { DB: {} as never, ASSETS: {} as never, ...overrides };
  }

  it.each([
    ["development + true + localhost", "development", "true", "http://localhost:8793", true],
    ["test + true + 127.0.0.1", "test", "true", "http://127.0.0.1:8793", true],
    ["development + true + [::1]", "development", "true", "http://[::1]:8793", true],
    ["development + flag ausente + localhost", "development", undefined, "http://localhost:8793", false],
    ['development + "false" + localhost', "development", "false", "http://localhost:8793", false],
    ["test + flag ausente + localhost", "test", undefined, "http://localhost:8793", false],
    ["production + true + localhost", "production", "true", "http://localhost:8793", false],
    ["ambiente ausente + true + localhost", undefined, "true", "http://localhost:8793", false],
    [
      "development + true + workers.dev",
      "development",
      "true",
      "https://matematica-delicada.proffandreia5.workers.dev",
      false,
    ],
    ["development + true + domínio arbitrário", "development", "true", "https://exemplo.com", false],
  ])("%s -> habilitado? %s", (_label, environment, flag, urlStr, expectedEnabled) => {
    const env = envWith({ ENVIRONMENT: environment, ENABLE_LOCAL_PATTERN_FIXTURES: flag });
    expect(isLocalPatternFixturesAllowed(env, new URL(urlStr))).toBe(expectedEnabled);
  });

  it("X-Forwarded-Host alegando localhost NÃO transforma uma URL remota em local", () => {
    const env = envWith({ ENVIRONMENT: "development", ENABLE_LOCAL_PATTERN_FIXTURES: "true" });
    const remoteUrl = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/patterns");
    expect(isLocalPatternFixturesAllowed(env, remoteUrl)).toBe(false);
  });

  it("produção real (sem flag, sem ENVIRONMENT local, hostname público) nunca serve conteúdo de fixture", () => {
    const productionEnv = envWith({});
    const productionUrl = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/patterns");
    expect(isLocalPatternFixturesAllowed(productionEnv, productionUrl)).toBe(false);
  });
});

describe("gate desligado — a API responde acolhedora sem tocar nas tabelas pattern_*", () => {
  it.each([
    ["flag ausente", { ENABLE_LOCAL_PATTERN_FIXTURES: undefined }],
    ["flag falsa", { ENABLE_LOCAL_PATTERN_FIXTURES: "false" }],
    ["ambiente de produção", { ENVIRONMENT: "production" }],
  ])("%s -> available:false, nunca conteúdo", async (_label, overrides) => {
    const token = await seedUserWithSession("u-gate");
    const response = await callRoute("/api/patterns", token, localEnv(overrides));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false });
    expect(body.message).toBe("Ainda não há padrões publicados neste catálogo.");
    expect(body.patterns).toBeUndefined();
  });

  it("host remoto com flag ligada também responde indisponível na ficha", async () => {
    const token = await seedUserWithSession("u-gate-remoto");
    const response = await callRoute(
      "/api/patterns/razao-em-grafico",
      token,
      localEnv(),
      "https://matematica-delicada.proffandreia5.workers.dev"
    );
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false });
    expect(body.pattern).toBeUndefined();
  });

  it("gate desligado também bloqueia o endpoint de progresso", async () => {
    const token = await seedUserWithSession("u-gate-prog");
    const response = await callRoute(
      "/api/patterns/razao-em-grafico/progress",
      token,
      localEnv({ ENABLE_LOCAL_PATTERN_FIXTURES: undefined })
    );
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, available: false });
    expect(body.progress).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------- */
/* Validação pura                                                          */
/* ---------------------------------------------------------------------- */

describe("validação de parâmetros do catálogo", () => {
  it.each([
    ["razao-em-grafico", true],
    ["escala", true],
    ["Razao-Em-Grafico", false],
    ["-comeca-com-hifen", false],
    ["termina-com-hifen-", false],
    ["hifens--duplos", false],
    ["com espaco", false],
    ["", false],
    ["../../etc/passwd", false],
  ])("isValidPatternSlug(%s) === %s", (slug, expected) => {
    expect(isValidPatternSlug(slug)).toBe(expected);
  });

  it("limite acima do teto do Worker é rejeitado (nunca saturado silenciosamente)", () => {
    expect(validatePatternLimit(String(PATTERNS_MAX_LIMIT)).ok).toBe(true);
    expect(validatePatternLimit(String(PATTERNS_MAX_LIMIT + 1)).ok).toBe(false);
    expect(validatePatternLimit("0").ok).toBe(false);
    expect(validatePatternLimit("-3").ok).toBe(false);
    expect(validatePatternLimit("abc").ok).toBe(false);
    expect(validatePatternLimit("2.5").ok).toBe(false);
  });

  it("página inválida é rejeitada; ausente vira 1", () => {
    expect(validatePatternPage(null).value).toBe(1);
    expect(validatePatternPage("0").ok).toBe(false);
    expect(validatePatternPage("x").ok).toBe(false);
    expect(validatePatternPage("3").value).toBe(3);
  });

  it("ordenação e filtro de evidência aceitam só o enum fechado", () => {
    expect(validatePatternSort("nome").ok).toBe(true);
    expect(validatePatternSort("id_interno").ok).toBe(false);
    expect(validatePatternEvidenceFilter("com_evidencia").ok).toBe(true);
    expect(validatePatternEvidenceFilter("qualquer_coisa").ok).toBe(false);
    expect(validatePatternEvidenceFilter(null).value).toBe("todos");
  });

  it("busca só de espaços equivale a sem busca", () => {
    expect(validatePatternSearch("   ").value).toBeNull();
    expect(validatePatternSearch("escala").value).toBe("escala");
  });
});

/* ---------------------------------------------------------------------- */
/* 6.3 — API                                                               */
/* ---------------------------------------------------------------------- */

const ALL_FILTERS = { search: null, content: null, tag: null, evidence: "todos", sort: "codigo" } as const;

describe("GET /api/patterns — catálogo", () => {
  it("sem sessão responde 401 nos três endpoints", async () => {
    for (const path of ["/api/patterns", "/api/patterns/escala", "/api/patterns/escala/progress"]) {
      const response = await callRoute(path, null);
      expect(response.status).toBe(401);
    }
  });

  it("lista só os padrões publicados — o rascunho editorial nunca aparece", async () => {
    const token = await seedUserWithSession("u-lista");
    const response = await callRoute("/api/patterns?limite=50", token);
    const body = await response.json();
    expect(body.total).toBe(TEST_PATTERNS.length);
    const slugs = body.patterns.map((pattern: { slug: string }) => pattern.slug);
    expect(slugs).not.toContain(TEST_DRAFT_PATTERN.slug);
  });

  it("não vaza nenhum campo interno (id, status editorial, versão, datas, user_id, contador bruto)", async () => {
    const token = await seedUserWithSession("u-vazamento");
    seedProgress("u-vazamento", "fixture-pat-01", { recognition: 0.5 });
    const response = await callRoute("/api/patterns?limite=50", token);
    const raw = await response.text();

    for (const forbidden of [
      "editorial_status",
      "editorialStatus",
      "raw_evidence_count",
      "rawEvidenceCount",
      "user_id",
      "userId",
      "fixture-pat-01",
      "created_at",
      "updated_at",
    ]) {
      expect(raw).not.toContain(forbidden);
    }

    const body = JSON.parse(raw);
    for (const pattern of body.patterns) {
      expect(pattern.id).toBeUndefined();
      expect(pattern.version).toBeUndefined();
    }
  });

  it("busca textual encontra pelo nome e não devolve quem não corresponde", async () => {
    const token = await seedUserWithSession("u-busca");
    const response = await callRoute("/api/patterns?busca=Escala&limite=50", token);
    const body = await response.json();
    expect(body.patterns.map((p: { slug: string }) => p.slug)).toEqual(["escala"]);
  });

  it("busca textual encontra pelo código", async () => {
    const token = await seedUserWithSession("u-busca-codigo");
    const response = await callRoute("/api/patterns?busca=PAD-04&limite=50", token);
    const body = await response.json();
    expect(body.patterns.map((p: { code: string }) => p.code)).toEqual(["PAD-04"]);
  });

  it("busca sem correspondência devolve lista vazia acolhedora, nunca padrões fabricados", async () => {
    const token = await seedUserWithSession("u-busca-vazia");
    const response = await callRoute("/api/patterns?busca=zzzzznaoexiste", token);
    const body = await response.json();
    expect(body.total).toBe(0);
    expect(body.patterns).toEqual([]);
    expect(body.totalPages).toBe(0);
  });

  it("filtro por conteúdo devolve exatamente os padrões que têm aquele conteúdo", async () => {
    const token = await seedUserWithSession("u-conteudo");
    const response = await callRoute("/api/patterns?conteudo=Porcentagem&limite=50", token);
    const body = await response.json();
    expect(body.patterns.map((p: { slug: string }) => p.slug)).toEqual(["porcentagem-direta"]);
  });

  it("filtro por tag devolve todos os padrões marcados com aquela tag", async () => {
    const token = await seedUserWithSession("u-tag");
    const response = await callRoute("/api/patterns?tag=proporcionalidade&limite=50", token);
    const body = await response.json();
    expect(body.patterns.map((p: { code: string }) => p.code)).toEqual(["PAD-01", "PAD-02", "PAD-03"]);
  });

  it("filtro por disponibilidade de evidência separa com/sem evidência real", async () => {
    const token = await seedUserWithSession("u-evidencia");
    seedProgress("u-evidencia", "fixture-pat-02", { recognition: 0.4 });

    const withEvidence = await (await callRoute("/api/patterns?evidencia=com_evidencia&limite=50", token)).json();
    expect(withEvidence.patterns.map((p: { slug: string }) => p.slug)).toEqual(["escala"]);

    const withoutEvidence = await (await callRoute("/api/patterns?evidencia=sem_evidencia&limite=50", token)).json();
    expect(withoutEvidence.total).toBe(TEST_PATTERNS.length - 1);
    expect(withoutEvidence.patterns.map((p: { slug: string }) => p.slug)).not.toContain("escala");
  });

  it("uma linha de progresso SEM nenhum índice não conta como evidência disponível", async () => {
    const token = await seedUserWithSession("u-evidencia-nula");
    // Linha existe (prática registrada), mas os três índices continuam NULL.
    seedProgress("u-evidencia-nula", "fixture-pat-02", { lastPracticedAt: "2026-08-01T10:00:00.000Z" });
    const body = await (await callRoute("/api/patterns?evidencia=com_evidencia&limite=50", token)).json();
    expect(body.total).toBe(0);
  });

  it("combinação de filtros aplica todos ao mesmo tempo", async () => {
    const token = await seedUserWithSession("u-combo");
    const body = await (
      await callRoute("/api/patterns?tag=proporcionalidade&conteudo=Razão%20e%20proporção&busca=Escala&limite=50", token)
    ).json();
    expect(body.patterns.map((p: { slug: string }) => p.slug)).toEqual(["escala"]);
  });

  it("paginação: primeira, intermediária e última página são estáveis e não se sobrepõem", async () => {
    const token = await seedUserWithSession("u-paginacao");
    const first = await (await callRoute("/api/patterns?limite=2&pagina=1", token)).json();
    const middle = await (await callRoute("/api/patterns?limite=2&pagina=2", token)).json();
    const last = await (await callRoute("/api/patterns?limite=2&pagina=3", token)).json();

    expect(first.total).toBe(5);
    expect(first.totalPages).toBe(3);
    expect(first.patterns.map((p: { code: string }) => p.code)).toEqual(["PAD-01", "PAD-02"]);
    expect(middle.patterns.map((p: { code: string }) => p.code)).toEqual(["PAD-03", "PAD-04"]);
    expect(last.patterns.map((p: { code: string }) => p.code)).toEqual(["PAD-05"]);

    const allCodes = [...first.patterns, ...middle.patterns, ...last.patterns].map(
      (p: { code: string }) => p.code
    );
    expect(new Set(allCodes).size).toBe(5);
  });

  it("página além do fim devolve lista vazia com o total correto, nunca 404", async () => {
    const token = await seedUserWithSession("u-pagina-alem");
    const response = await callRoute("/api/patterns?limite=2&pagina=99", token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.patterns).toEqual([]);
    expect(body.total).toBe(5);
  });

  it("limite inválido responde 400 com o campo apontado", async () => {
    const token = await seedUserWithSession("u-limite");
    const response = await callRoute(`/api/patterns?limite=${PATTERNS_MAX_LIMIT + 1}`, token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.fields.limite).toBeTruthy();
  });

  it.each([
    ["pagina=0", "pagina"],
    ["ordenar=id_interno", "ordenar"],
    ["evidencia=talvez", "evidencia"],
  ])("parâmetro inválido (%s) responde 400", async (query, field) => {
    const token = await seedUserWithSession(`u-invalido-${field}`);
    const response = await callRoute(`/api/patterns?${query}`, token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.fields[field]).toBeTruthy();
  });

  it("ordenação é determinística e independente da ordem de inserção", async () => {
    const token = await seedUserWithSession("u-ordem");
    const porCodigo = await (await callRoute("/api/patterns?limite=50", token)).json();
    expect(porCodigo.patterns.map((p: { code: string }) => p.code)).toEqual([
      "PAD-01",
      "PAD-02",
      "PAD-03",
      "PAD-04",
      "PAD-05",
    ]);

    const porNome = await (await callRoute("/api/patterns?ordenar=nome&limite=50", token)).json();
    const nomes = porNome.patterns.map((p: { name: string }) => p.name);
    expect(nomes).toEqual([...nomes].sort());

    // Duas chamadas idênticas devolvem exatamente a mesma ordem.
    const repetida = await (await callRoute("/api/patterns?limite=50", token)).json();
    expect(repetida.patterns.map((p: { code: string }) => p.code)).toEqual(
      porCodigo.patterns.map((p: { code: string }) => p.code)
    );
  });

  it("um curinga de LIKE na busca é tratado como texto literal, não como curinga", async () => {
    const token = await seedUserWithSession("u-like");
    const body = await (await callRoute("/api/patterns?busca=%25&limite=50", token)).json();
    expect(body.total).toBe(0);
  });
});

describe("GET /api/patterns/:slug — ficha", () => {
  it("devolve a ficha completa de um padrão publicado", async () => {
    const token = await seedUserWithSession("u-ficha");
    const response = await callRoute("/api/patterns/razao-em-grafico", token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pattern.code).toBe("PAD-01");
    expect(body.pattern.name).toBe("Razão em Gráfico");
    expect(body.pattern.frequentClues.length).toBeGreaterThan(0);
    expect(body.pattern.recurringPhrases.length).toBeGreaterThan(0);
    expect(body.pattern.commonMistakes.length).toBeGreaterThan(0);
    expect(body.pattern.availableQuestionCount).toBe(0);
  });

  it("as relações trazem código, slug e nome do padrão de destino", async () => {
    const token = await seedUserWithSession("u-relacoes");
    const body = await (await callRoute("/api/patterns/razao-em-grafico", token)).json();
    const tipos = body.pattern.relations.map((relation: { relationType: string }) => relation.relationType);
    expect(tipos).toContain("related");
    expect(tipos).toContain("prerequisite");
    for (const relation of body.pattern.relations) {
      expect(relation.code).toMatch(/^PAD-\d+$/);
      expect(relation.slug).toBeTruthy();
      expect(relation.name).toBeTruthy();
    }
  });

  it("padrão NÃO publicado responde exatamente o mesmo 404 de slug inexistente", async () => {
    const token = await seedUserWithSession("u-404");
    const draft = await callRoute(`/api/patterns/${TEST_DRAFT_PATTERN.slug}`, token);
    const inexistente = await callRoute("/api/patterns/slug-que-nunca-existiu", token);

    expect(draft.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(await draft.text()).toBe(await inexistente.text());
  });

  it("slug malformado responde 404 (mesma resposta), nunca 400 nem 500", async () => {
    const token = await seedUserWithSession("u-slug-ruim");
    const response = await callRoute("/api/patterns/SLUG_INVALIDO", token);
    expect(response.status).toBe(404);
  });

  it("uma relação apontando para um padrão não publicado nunca aparece na ficha", async () => {
    const token = await seedUserWithSession("u-relacao-rascunho");
    db.sqlite
      .prepare("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES (?, ?, ?, ?)")
      .run("rel-para-rascunho", "fixture-pat-01", TEST_DRAFT_PATTERN.id, "related");

    const body = await (await callRoute("/api/patterns/razao-em-grafico", token)).json();
    const slugs = body.pattern.relations.map((relation: { slug: string }) => relation.slug);
    expect(slugs).not.toContain(TEST_DRAFT_PATTERN.slug);
  });
});

describe("índices indisponíveis — NULL nunca vira zero", () => {
  it("aluno sem progresso: os três índices vêm available:false / value:null", async () => {
    const token = await seedUserWithSession("u-sem-progresso");
    const body = await (await callRoute("/api/patterns/escala", token)).json();
    const { recognition, resolution, mastery } = body.pattern.progress.indices;
    expect(body.pattern.progress.hasProgress).toBe(false);
    for (const index of [recognition, resolution, mastery]) {
      expect(index).toEqual({ available: false, value: null });
      expect(index.value).not.toBe(0);
    }
  });

  it("progresso parcial: só o índice com valor fica disponível; os outros continuam nulos", async () => {
    const token = await seedUserWithSession("u-progresso-parcial");
    seedProgress("u-progresso-parcial", "fixture-pat-02", { recognition: 0.42 });
    const body = await (await callRoute("/api/patterns/escala", token)).json();
    expect(body.pattern.progress.indices.recognition).toEqual({ available: true, value: 0.42 });
    expect(body.pattern.progress.indices.resolution).toEqual({ available: false, value: null });
    expect(body.pattern.progress.indices.mastery).toEqual({ available: false, value: null });
  });

  it("o serviço preserva NULL de ponta a ponta (nenhuma camada converte para 0)", async () => {
    await seedUser("u-servico");
    const result = await getPatternDetail(db as never, "u-servico", "escala", true);
    expect(result!.progress.indices.mastery.value).toBeNull();
    const listed = await listPatterns(db as never, "u-servico", { ...ALL_FILTERS }, 1, 50, true);
    for (const pattern of listed.patterns) {
      expect(pattern.progress.indices.mastery.value).toBeNull();
    }
  });
});

describe("Sprint 8 v1.1 — 'Treinar este padrão' (trainableQuestionId, seção 13 da ordem)", () => {
  it("sem nenhuma questão publicada ligada ao padrão, trainableQuestionId é null (nunca inventa um caminho)", async () => {
    await seedUser("u-treinar-1");
    const result = await getPatternDetail(db as never, "u-treinar-1", "escala", true);
    expect(result!.trainableQuestionId).toBeNull();
  });

  it("com uma questão PUBLICADA cujo padrão principal é este, trainableQuestionId aponta para ela — escolha determinística, nunca um algoritmo pedagógico", async () => {
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, editorial_status, fingerprint)
       VALUES ('q-trein-1', 'TREIN-01', 'Enunciado técnico', 'media', 'autoral', 'published', 'fp-trein-1')`
    );
    db.sqlite.exec(
      `INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp-trein-1', 'q-trein-1', 'fixture-pat-04', 'principal')`
    );
    await seedUser("u-treinar-2");
    const result = await getPatternDetail(db as never, "u-treinar-2", "mediana-e-frequencia", true);
    expect(result!.trainableQuestionId).toBe("q-trein-1");
  });

  it("uma questão RASCUNHO (não publicada) ligada ao padrão nunca é oferecida", async () => {
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, editorial_status, fingerprint)
       VALUES ('q-trein-draft', 'TREIN-02', 'Enunciado técnico', 'media', 'autoral', 'draft', 'fp-trein-2')`
    );
    db.sqlite.exec(
      `INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp-trein-draft', 'q-trein-draft', 'fixture-pat-01', 'principal')`
    );
    await seedUser("u-treinar-3");
    const result = await getPatternDetail(db as never, "u-treinar-3", "razao-em-grafico", true);
    expect(result!.trainableQuestionId).toBeNull();
  });
});

describe("GET /api/patterns/:slug/progress — isolamento por usuário", () => {
  it("cada aluno vê apenas o próprio progresso", async () => {
    const tokenA = await seedUserWithSession("u-aluna-a");
    const tokenB = await seedUserWithSession("u-aluna-b");
    seedProgress("u-aluna-a", "fixture-pat-01", { recognition: 0.9, lastPracticedAt: "2026-08-20T12:00:00.000Z" });

    const bodyA = await (await callRoute("/api/patterns/razao-em-grafico/progress", tokenA)).json();
    expect(bodyA.progress.hasProgress).toBe(true);
    expect(bodyA.progress.indices.recognition).toEqual({ available: true, value: 0.9 });

    const bodyB = await (await callRoute("/api/patterns/razao-em-grafico/progress", tokenB)).json();
    expect(bodyB.progress.hasProgress).toBe(false);
    expect(bodyB.progress.indices.recognition).toEqual({ available: false, value: null });
    expect(bodyB.progress.lastPracticedAt).toBeNull();
  });

  it("o isolamento está no SQL (user_id no WHERE), não só na aplicação", async () => {
    await seedUser("u-sql-a");
    await seedUser("u-sql-b");
    seedProgress("u-sql-a", "fixture-pat-03", { mastery: 0.6 });

    const forA = await getPatternProgress(db as never, "u-sql-a", "porcentagem-direta", true);
    const forB = await getPatternProgress(db as never, "u-sql-b", "porcentagem-direta", true);
    expect(forA!.progress.indices.mastery.value).toBe(0.6);
    expect(forB!.progress.indices.mastery.value).toBeNull();
  });

  it("o filtro de evidência de um aluno não enxerga o progresso de outro", async () => {
    const tokenB = await seedUserWithSession("u-filtro-b");
    await seedUser("u-filtro-a");
    seedProgress("u-filtro-a", "fixture-pat-01", { recognition: 0.7 });

    const body = await (await callRoute("/api/patterns?evidencia=com_evidencia&limite=50", tokenB)).json();
    expect(body.total).toBe(0);
  });

  it("progresso de um slug não publicado/inexistente responde 404", async () => {
    const token = await seedUserWithSession("u-prog-404");
    expect((await callRoute(`/api/patterns/${TEST_DRAFT_PATTERN.slug}/progress`, token)).status).toBe(404);
    expect((await callRoute("/api/patterns/nao-existe/progress", token)).status).toBe(404);
  });
});

describe("GET é estritamente somente leitura", () => {
  it("repetir os três GETs não altera NENHUMA tabela nem gera auditoria", async () => {
    const token = await seedUserWithSession("u-somente-leitura");
    const TABLES = [
      "patterns",
      "pattern_attributes",
      "pattern_relations",
      "student_pattern_progress",
      "audit_log",
      "schedule_activity_assignments",
      "diagnostic_attempts",
    ];
    const snapshot = () => Object.fromEntries(TABLES.map((table) => [table, countRows(table)]));
    const before = snapshot();

    for (let round = 0; round < 3; round++) {
      await callRoute("/api/patterns?limite=50", token);
      await callRoute("/api/patterns?busca=escala&evidencia=sem_evidencia", token);
      await callRoute("/api/patterns/razao-em-grafico", token);
      await callRoute("/api/patterns/razao-em-grafico/progress", token);
      await callRoute("/api/patterns/nao-existe", token);
    }

    expect(snapshot()).toEqual(before);
    // Em particular: nenhuma linha de progresso foi criada automaticamente.
    expect(countRows("student_pattern_progress")).toBe(0);
  });

  it("abrir a ficha de um padrão nunca cria a linha de progresso do aluno", async () => {
    const token = await seedUserWithSession("u-sem-autocriacao");
    await callRoute("/api/patterns/mediana-e-frequencia", token);
    await callRoute("/api/patterns/mediana-e-frequencia/progress", token);
    const rows = db.sqlite
      .prepare("SELECT COUNT(*) as total FROM student_pattern_progress WHERE user_id = 'u-sem-autocriacao'")
      .get() as { total: number };
    expect(rows.total).toBe(0);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "%s sob /api/patterns responde 405 — não existe endpoint editorial nesta sprint",
    async (method) => {
      const token = await seedUserWithSession(`u-metodo-${method}`);
      const request = new Request(`${LOCAL_ORIGIN}/api/patterns`, {
        method,
        headers: new Headers({ Cookie: `md_session=${token}` }),
      });
      const response = await handlePatternsRequest(request, localEnv(), new URL(request.url));
      expect(response!.status).toBe(405);
      expect(countRows("patterns")).toBe(TEST_PATTERNS.length + 1);
    }
  );
});

describe("Correção B (v1.1) — prova de leitura pura, separada por endpoint, ≥5 repetições", () => {
  /* Seção 3 da ordem de correção v1.1: as cinco tabelas exigidas literalmente,
     nem mais nem menos, consultadas DIRETO no banco (não busca textual no
     código) antes e depois de cada rodada. */
  const REQUIRED_TABLES = ["patterns", "pattern_attributes", "pattern_relations", "student_pattern_progress", "audit_log"];

  function snapshot(): Record<string, number> {
    return Object.fromEntries(REQUIRED_TABLES.map((table) => [table, countRows(table)]));
  }

  it("GET /api/patterns — 5 repetições, incluindo busca/filtro/paginação variados: contagens idênticas, sem auditoria", async () => {
    const token = await seedUserWithSession("u-b-lista");
    const before = snapshot();

    const queries = [
      "/api/patterns",
      "/api/patterns?busca=Escala",
      "/api/patterns?tag=proporcionalidade&limite=10",
      "/api/patterns?evidencia=sem_evidencia&ordenar=nome",
      "/api/patterns?limite=2&pagina=2",
    ];
    const bodies: string[] = [];
    for (const query of queries) {
      const response = await callRoute(query, token);
      expect(response.status).toBe(200);
      bodies.push(await response.text());
    }

    // Determinismo: repetir a MESMA query duas vezes devolve o MESMO corpo.
    const repeatFirst = await (await callRoute(queries[0], token)).text();
    expect(repeatFirst).toBe(bodies[0]);
    const repeatLast = await (await callRoute(queries[queries.length - 1], token)).text();
    expect(repeatLast).toBe(bodies[bodies.length - 1]);

    expect(snapshot()).toEqual(before);
  });

  it("GET /api/patterns/:slug — 5 repetições, incluindo slug inexistente e não publicado: contagens idênticas, sem auditoria", async () => {
    const token = await seedUserWithSession("u-b-ficha");
    const before = snapshot();

    const slugs = [
      "razao-em-grafico",
      "razao-em-grafico",
      TEST_DRAFT_PATTERN.slug, // não publicado -> 404
      "slug-que-nunca-existiu", // inexistente -> mesmo 404
      "escala",
    ];
    const bodies: string[] = [];
    for (const slug of slugs) {
      const response = await callRoute(`/api/patterns/${slug}`, token);
      bodies.push(await response.text());
    }
    // As duas chamadas a "razao-em-grafico" são idênticas entre si...
    expect(bodies[0]).toBe(bodies[1]);
    // ...e o 404 do rascunho é byte a byte igual ao 404 do inexistente.
    expect(bodies[2]).toBe(bodies[3]);

    expect(snapshot()).toEqual(before);
  });

  it("GET /api/patterns/:slug/progress — 5 repetições: nunca cria a linha, nunca audita", async () => {
    const token = await seedUserWithSession("u-b-progresso");
    const before = snapshot();

    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await callRoute("/api/patterns/mediana-e-frequencia/progress", token);
      expect(response.status).toBe(200);
      bodies.push(await response.text());
    }
    // Cinco chamadas idênticas ao mesmo recurso devolvem exatamente o mesmo corpo.
    expect(new Set(bodies).size).toBe(1);

    expect(snapshot()).toEqual(before);
    expect(countRows("student_pattern_progress")).toBe(0);
  });

  it("os três GETs repetidos 5x cada FORA do gate local: contagens idênticas, sem auditoria, sem vestígio de conteúdo", async () => {
    const token = await seedUserWithSession("u-b-gate-desligado");
    const gateOffEnv = localEnv({ ENABLE_LOCAL_PATTERN_FIXTURES: undefined });
    const before = snapshot();

    for (let i = 0; i < 5; i++) {
      const list = await callRoute("/api/patterns?busca=escala&limite=3", token, gateOffEnv);
      expect((await list.json()).available).toBe(false);

      const detail = await callRoute("/api/patterns/razao-em-grafico", token, gateOffEnv);
      expect((await detail.json()).available).toBe(false);

      const progress = await callRoute("/api/patterns/razao-em-grafico/progress", token, gateOffEnv);
      expect((await progress.json()).available).toBe(false);
    }

    expect(snapshot()).toEqual(before);
  });
});

describe("roteamento", () => {
  it("caminhos fora de /api/patterns não são tratados por esta rota", async () => {
    const request = new Request(`${LOCAL_ORIGIN}/api/schedule/summary`, { method: "GET" });
    const response = await handlePatternsRequest(request, localEnv(), new URL(request.url));
    expect(response).toBeNull();
  });

  it("um caminho mais profundo e desconhecido sob /api/patterns responde 404", async () => {
    const token = await seedUserWithSession("u-rota-profunda");
    const response = await callRoute("/api/patterns/escala/progress/extra", token);
    expect(response.status).toBe(404);
  });
});
