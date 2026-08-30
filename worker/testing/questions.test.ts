// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { resolveEditorialRole } from "../src/lib/rbac";
import { handleEditorialQuestionsRequest } from "../src/routes/editorialQuestions";
import {
  approveQuestion,
  archiveQuestion,
  createQuestion,
  publishQuestion,
  requestChanges,
  submitForReview,
  updateQuestion,
} from "../src/services/questionService";

let db: FakeD1Database;

beforeEach(async () => {
  db = new FakeD1Database();
  // Usuários usados diretamente como actorUserId/autorId nos testes de
  // serviço (sem passar pela rota) — precisam existir por causa das FKs
  // reais (users.id) em questions.autor_id/revisor_id e question_history.user_id.
  for (const id of ["autor1", "editor1", "admin1"]) {
    await createUser(db as never, {
      id,
      name: "Usuária Teste",
      email: `${id}@teste.dev`,
      emailNormalized: `${id}@teste.dev`,
      passwordHash: await hashPassword("senha-original-123"),
    });
  }
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-2', 'PAD-02', 'padrao-2', 'Padrão 2', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
});

async function seedUser(id: string): Promise<void> {
  // Idempotente: alguns ids (autor1/editor1/admin1) já nascem no beforeEach
  // global (usados como FK direta em chamadas de serviço sem sessão) — os
  // testes de RBAC reaproveitam o MESMO id para logar de verdade com sessão,
  // então evitamos um segundo INSERT (violaria a PK) simplesmente pulando.
  const existing = db.sqlite.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (existing) return;
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

function grantRole(userId: string, role: "editor" | "admin"): void {
  db.sqlite.exec(`INSERT OR IGNORE INTO roles (id, name) VALUES ('role-${role}', '${role}')`);
  db.sqlite.exec(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id) VALUES ('ur-${userId}-${role}', '${userId}', 'role-${role}')`);
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(overrides: Partial<Env> = {}): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ...overrides };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}, origin = LOCAL_ORIGIN): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${origin}${path}`, { ...init, headers });
}

async function callRoute(path: string, token: string | null, init: RequestInit = {}, env: Env = localEnv()) {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  const response = await handleEditorialQuestionsRequest(request, env, url);
  return response!;
}

function questionRow(id: string): { editorial_status: string; version: number } {
  return db.sqlite.prepare("SELECT editorial_status, version FROM questions WHERE id = ?").get(id) as never;
}

function historyCount(id: string): number {
  return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_history WHERE question_id = ?").get(id) as { total: number }).total;
}

/* ---------------------------------------------------------------------- */
/* RBAC (11.1)                                                             */
/* ---------------------------------------------------------------------- */

describe("RBAC editorial", () => {
  it("resolveEditorialRole nunca confia em papel enviado pelo cliente — deriva do banco", async () => {
    await seedUser("u1");
    expect(await resolveEditorialRole(db as never, "u1")).toBeNull();
    grantRole("u1", "editor");
    expect(await resolveEditorialRole(db as never, "u1")).toBe("editor");
  });

  it("admin herda tudo do editor: se o usuário tem os dois papéis, resolve para admin", async () => {
    await seedUser("u1");
    grantRole("u1", "editor");
    grantRole("u1", "admin");
    expect(await resolveEditorialRole(db as never, "u1")).toBe("admin");
  });

  it("usuário sem papel recebe 403 na API editorial, sem vazar conteúdo", async () => {
    const token = await seedUserWithSession("aluno1");
    const response = await callRoute("/api/editorial/questions", token);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/enunciado|resolucao/i);
  });

  it("sem sessão nenhuma -> 401 (nunca 403, para não confirmar nem negar a existência de papel)", async () => {
    const response = await callRoute("/api/editorial/questions", null);
    expect(response.status).toBe(401);
  });

  it("editor consegue listar e criar, mas NÃO aprovar/publicar (403)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const list = await callRoute("/api/editorial/questions", token);
    expect(list.status).toBe(200);

    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "in_review", version: 2 });
    const approve = await callRoute(`/api/editorial/questions/${qId}/approve`, token, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(approve.status).toBe(403);
  });

  it("admin consegue aprovar e publicar", async () => {
    const token = await seedUserWithSession("admin1");
    grantRole("admin1", "admin");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "in_review", version: 2 });
    const approve = await callRoute(`/api/editorial/questions/${qId}/approve`, token, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    expect(approve.status).toBe(200);
  });
});

/* ---------------------------------------------------------------------- */
/* CRUD (11.3)                                                             */
/* ---------------------------------------------------------------------- */

// Compartilhado entre "CRUD de questões" e "Correção A — semântica parcial
// do PATCH" (module scope, não escopado a um describe específico).
const validAlternatives = [
  { letter: "A", text: "Alt A", isCorrect: false, distractorExplanation: null },
  { letter: "B", text: "Alt B", isCorrect: true, distractorExplanation: null },
  { letter: "C", text: "Alt C", isCorrect: false, distractorExplanation: null },
  { letter: "D", text: "Alt D", isCorrect: false, distractorExplanation: null },
  { letter: "E", text: "Alt E", isCorrect: false, distractorExplanation: null },
];
const validDna = {
  pista: "p",
  estrategia: "e",
  pegadinha: "peg",
  conteudoApoio: "c",
  resolucao: "r",
  atalho: null,
  aprendizadoErro: "a",
};

describe("CRUD de questões", () => {
  it("cria uma questão válida em draft", async () => {
    const result = await createQuestion(db as never, "autor1", {
      code: "NEW-1",
      enunciado: "Enunciado de teste suficientemente longo.",
      dificuldade: "media",
      origem: "autoral",
      alternativas: validAlternatives as never,
      dna: validDna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(result.ok).toBe(true);
    expect(questionRow(result.value!.id).editorial_status).toBe("draft");
    expect(historyCount(result.value!.id)).toBe(1);
  });

  it("rejeita código duplicado", async () => {
    seedQuestion(db.sqlite, { code: "DUP-1", patternId: "pat-1" });
    const result = await createQuestion(db as never, "autor1", {
      code: "DUP-1",
      enunciado: "Outro enunciado.",
      dificuldade: "media",
      origem: "autoral",
      alternativas: validAlternatives as never,
      dna: validDna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.code).toBeDefined();
  });

  it("rejeita fingerprint duplicada (enunciado equivalente)", async () => {
    const enunciado = "Enunciado idêntico para teste de fingerprint.";
    const first = await createQuestion(db as never, "autor1", {
      code: "FP-1",
      enunciado,
      dificuldade: "media",
      origem: "autoral",
      alternativas: validAlternatives as never,
      dna: validDna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(first.ok).toBe(true);

    const second = await createQuestion(db as never, "autor1", {
      code: "FP-2",
      enunciado,
      dificuldade: "media",
      origem: "autoral",
      alternativas: validAlternatives as never,
      dna: validDna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(second.ok).toBe(false);
    expect(second.fieldErrors?.enunciado).toMatch(/fingerprint/i);
  });

  it("mass assignment: campos fora do allow-list (ex.: editorial_status, id, version) são ignorados na criação", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const response = await callRoute("/api/editorial/questions", token, {
      method: "POST",
      body: JSON.stringify({
        id: "attacker-chosen-id",
        editorialStatus: "published",
        version: 999,
        code: "MASS-1",
        enunciado: "Enunciado de teste para mass assignment.",
        dificuldade: "media",
        origem: "autoral",
        alternativas: validAlternatives,
        dna: validDna,
        padroes: [{ patternId: "pat-1", role: "principal" }],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).not.toBe("attacker-chosen-id");
    expect(questionRow(body.id).editorial_status).toBe("draft");
    expect(questionRow(body.id).version).toBe(1);
  });

  it("409 quando expectedVersion está desatualizada num PATCH", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 999, {
      enunciado: "Novo enunciado.",
      alternativas: validAlternatives as never,
      dna: validDna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("questão publicada nunca pode ser editada por PATCH", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "published", version: 5 });
    const result = await updateQuestion(db as never, "autor1", qId, 5, {
      enunciado: "Tentativa de sobrescrever conteúdo publicado.",
      alternativas: validAlternatives as never,
      dna: validDna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.editorial_status).toMatch(/publicada/i);
    expect(questionRow(qId).editorial_status).toBe("published");
    expect(questionRow(qId).version).toBe(5);
  });

  it("isolamento: PATCH em id inexistente retorna notFound", async () => {
    const result = await updateQuestion(db as never, "autor1", "id-que-nao-existe", 1, {} as never);
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* Sprint 7 v1.1, Correção A — PATCH parcial de verdade                    */
/* ---------------------------------------------------------------------- */

describe("Correção A — semântica parcial do PATCH", () => {
  function tagCount(id: string): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_tags WHERE question_id = ?").get(id) as { total: number }).total;
  }
  function patternCount(id: string): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_patterns WHERE question_id = ?").get(id) as { total: number }).total;
  }
  function altCount(id: string): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_alternatives WHERE question_id = ?").get(id) as { total: number }).total;
  }
  function dnaRow(id: string): { pista: string } | undefined {
    return db.sqlite.prepare("SELECT pista FROM question_dna WHERE question_id = ?").get(id) as { pista: string } | undefined;
  }
  function imageCount(id: string): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(id) as { total: number }).total;
  }

  // 1. alterar apenas título/enunciado preserva todas as coleções.
  it("1. alterar apenas o enunciado preserva alternativas/DNA/padrões/tags/imagens", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, secondaryPatternIds: ["pat-2"] });
    db.sqlite.exec(`INSERT INTO question_tags (id, question_id, content, position) VALUES ('t1','${qId}','fixture',0)`);
    db.sqlite.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text) VALUES ('i1','${qId}','assets/questoes/x.png','alt')`);

    const before = { alt: altCount(qId), tag: tagCount(qId), pat: patternCount(qId) };
    const result = await updateQuestion(db as never, "autor1", qId, 1, { enunciado: "Novo enunciado bem diferente do original para teste A1." } as never);

    expect(result.ok).toBe(true);
    expect(altCount(qId)).toBe(before.alt);
    expect(tagCount(qId)).toBe(before.tag);
    expect(patternCount(qId)).toBe(before.pat);
    expect(imageCount(qId)).toBe(1);
    expect(dnaRow(qId)?.pista).toBe("Pista de teste");
    const row = db.sqlite.prepare("SELECT enunciado FROM questions WHERE id = ?").get(qId) as { enunciado: string };
    expect(row.enunciado).toBe("Novo enunciado bem diferente do original para teste A1.");
  });

  // 2. alterar apenas alternativas preserva DNA/padrões/tags/imagens.
  it("2. alterar apenas alternativas preserva DNA/padrões/tags/imagens", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.sqlite.exec(`INSERT INTO question_tags (id, question_id, content, position) VALUES ('t1','${qId}','fixture',0)`);

    const newAlternatives = validAlternatives.map((a) => (a.letter === "A" ? { ...a, text: "Alt A alterada" } : a));
    const result = await updateQuestion(db as never, "autor1", qId, 1, { alternativas: newAlternatives } as never);

    expect(result.ok).toBe(true);
    expect(tagCount(qId)).toBe(1);
    expect(patternCount(qId)).toBe(1);
    expect(dnaRow(qId)?.pista).toBe("Pista de teste");
    const alt = db.sqlite.prepare("SELECT text FROM question_alternatives WHERE question_id = ? AND letter = 'A'").get(qId) as { text: string };
    expect(alt.text).toBe("Alt A alterada");
  });

  // 3. omitir alternativas não as apaga (o caso que motivou a correção).
  it("3. omitir 'alternativas' do corpo NÃO apaga as alternativas existentes", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    expect(altCount(qId)).toBe(5);
    const result = await updateQuestion(db as never, "autor1", qId, 1, { conteudo: "Novo conteúdo" } as never);
    expect(result.ok).toBe(true);
    expect(altCount(qId)).toBe(5);
  });

  // 4. enviar alternatives: [] limpa somente quando o estado permitir.
  it("4. 'alternativas: []' limpa explicitamente enquanto a questão está em draft", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 1, { alternativas: [] } as never);
    expect(result.ok).toBe(true);
    expect(altCount(qId)).toBe(0);
  });

  it("4b. 'alternativas: []' é rejeitada (nada é apagado) quando a questão não está mais num status editável", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "published", version: 5 });
    const result = await updateQuestion(db as never, "autor1", qId, 5, { alternativas: [] } as never);
    expect(result.ok).toBe(false);
    expect(altCount(qId)).toBe(5);
  });

  // 5. campo obrigatório null retorna 400 sem escrever.
  it("5. enviar um campo obrigatório como null retorna erro de validação SEM escrever nada", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 1, { enunciado: null } as never);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.enunciado).toBeDefined();
    expect(questionRow(qId).version).toBe(1); // nada foi gravado
  });

  it("5b. campos ANULÁVEIS (ex.: prova) aceitam null explícito e limpam o campo", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.sqlite.exec(`UPDATE questions SET prova = 'ENEM 2024' WHERE id = '${qId}'`);
    const result = await updateQuestion(db as never, "autor1", qId, 1, { prova: null } as never);
    expect(result.ok).toBe(true);
    const row = db.sqlite.prepare("SELECT prova FROM questions WHERE id = ?").get(qId) as { prova: string | null };
    expect(row.prova).toBeNull();
  });

  // 6. falha forçada numa coleção reverte escalar e demais coleções.
  it("6. falha forçada no INSERT de uma coleção reverte TAMBÉM o UPDATE escalar e as outras coleções", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.failNextMatching(/INSERT INTO question_tags/);
    await expect(
      updateQuestion(db as never, "autor1", qId, 1, {
        enunciado: "Não deveria persistir de jeito nenhum.",
        tags: ["nova-tag"],
      } as never)
    ).rejects.toThrow();
    const row = db.sqlite.prepare("SELECT enunciado, version FROM questions WHERE id = ?").get(qId) as { enunciado: string; version: number };
    expect(row.enunciado).not.toBe("Não deveria persistir de jeito nenhum.");
    expect(row.version).toBe(1);
    expect(tagCount(qId)).toBe(0);
  });

  // 7. versão desatualizada não altera nada (nenhuma coleção tocada).
  it("7. versão desatualizada não altera NADA — nem escalar, nem coleções explicitamente enviadas", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 999, {
      enunciado: "Não deveria persistir.",
      tags: ["nao-deveria-persistir"],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(tagCount(qId)).toBe(0);
    expect(questionRow(qId).version).toBe(1);
  });

  // 8. mass assignment de status/papel/autor alheio é rejeitado.
  it("8. mass assignment via PATCH: editorialStatus/version/autorId/revisorId são ignorados", async () => {
    const token = await seedUserWithSession("editorA8");
    grantRole("editorA8", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const response = await callRoute(`/api/editorial/questions/${qId}`, token, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: 1,
        editorialStatus: "published",
        autorId: "outro-usuario",
        revisorId: "outro-usuario",
        conteudo: "Conteúdo legítimo alterado",
      }),
    });
    expect(response.status).toBe(200);
    const row = questionRow(qId);
    expect(row.editorial_status).toBe("draft");
    const full = db.sqlite.prepare("SELECT autor_id, revisor_id FROM questions WHERE id = ?").get(qId) as {
      autor_id: string | null;
      revisor_id: string | null;
    };
    expect(full.autor_id).not.toBe("outro-usuario");
    expect(full.revisor_id).not.toBe("outro-usuario");
  });

  // 9. repetição idempotente não duplica histórico/auditoria.
  it("9. repetir o MESMO PATCH (mesma expectedVersion já obsoleta) não duplica question_history", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const first = await updateQuestion(db as never, "autor1", qId, 1, { conteudo: "Conteúdo alterado uma vez." } as never);
    expect(first.ok).toBe(true);
    const historyAfterFirst = historyCount(qId);

    // Reenvio idempotente: mesma expectedVersion (1) da chamada original.
    const retry = await updateQuestion(db as never, "autor1", qId, 1, { conteudo: "Conteúdo alterado uma vez." } as never);
    expect(retry.ok).toBe(true);
    expect(historyCount(qId)).toBe(historyAfterFirst); // nunca duplica
  });

  it("histórico registra os NOMES dos grupos alterados, nunca o conteúdo integral", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    await updateQuestion(db as never, "autor1", qId, 1, { enunciado: "Enunciado sensível que não deve vazar no histórico." } as never);
    const hist = db.sqlite.prepare("SELECT metadata FROM question_history WHERE question_id = ? ORDER BY created_at DESC LIMIT 1").get(qId) as {
      metadata: string;
    };
    expect(hist.metadata).toContain("enunciado");
    expect(hist.metadata).not.toContain("Enunciado sensível");
  });

  it("nunca cria um db.batch() vazio: um PATCH sem nenhum campo/coleção ainda assim valida a versão de forma atômica", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 1, {} as never);
    expect(result.ok).toBe(true);
    expect(altCount(qId)).toBe(5); // nada foi apagado
  });
});

/* ---------------------------------------------------------------------- */
/* Workflow: transições válidas/proibidas, atomicidade, idempotência (11.3)*/
/* ---------------------------------------------------------------------- */

describe("Workflow editorial", () => {
  it("draft -> in_review exige alternativas completas, imagem com alt e padrão principal", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: undefined, withPrincipalPattern: false, status: "draft", version: 1 });
    const result = await submitForReview(db as never, "editor1", "editor", qId, 1);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.readiness).toMatch(/padrão principal/i);
    expect(questionRow(qId).editorial_status).toBe("draft");
  });

  it("draft -> in_review funciona quando tudo está completo", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await submitForReview(db as never, "editor1", "editor", qId, 1);
    expect(result.ok).toBe(true);
    expect(questionRow(qId).editorial_status).toBe("in_review");
    expect(questionRow(qId).version).toBe(2);
    expect(historyCount(qId)).toBe(1);
  });

  it("todas as transições da matriz são aceitas na ordem correta: draft -> in_review -> changes_requested -> in_review -> approved -> published", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, autorId: "autor1", titularDireitos: "T", baseLicenca: "B" });

    let r = await submitForReview(db as never, "editor1", "editor", qId, 1);
    expect(r.ok).toBe(true);

    r = await requestChanges(db as never, "admin1", "admin", qId, 2, "Corrigir X");
    expect(r.ok).toBe(true);
    expect(questionRow(qId).editorial_status).toBe("changes_requested");

    r = await submitForReview(db as never, "editor1", "editor", qId, 3);
    expect(r.ok).toBe(true);
    expect(questionRow(qId).editorial_status).toBe("in_review");

    r = await approveQuestion(db as never, "admin1", "admin", qId, 4);
    expect(r.ok).toBe(true);
    expect(questionRow(qId).editorial_status).toBe("approved");

    // Publicação exige revisor (setado em approve) + direitos completos.
    db.sqlite.exec(`UPDATE questions SET revisor_id = 'admin1' WHERE id = '${qId}'`);
    r = await publishQuestion(db as never, "admin1", "admin", qId, 5);
    expect(r.ok).toBe(true);
    expect(questionRow(qId).editorial_status).toBe("published");
    expect(historyCount(qId)).toBe(5);
  });

  it("pular estados é proibido: draft -> approved direto falha", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await approveQuestion(db as never, "admin1", "admin", qId, 1);
    expect(result.ok).toBe(false);
    expect(questionRow(qId).editorial_status).toBe("draft");
  });

  it("published -> qualquer coisa é proibido (estado terminal para transições)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "published", version: 5 });
    const result = await archiveQuestion(db as never, "admin1", "admin", qId, 5);
    expect(result.ok).toBe(false);
    expect(questionRow(qId).editorial_status).toBe("published");
  });

  it("archived é alcançável de draft/in_review/changes_requested/approved, mas nunca de published", async () => {
    for (const status of ["draft", "in_review", "changes_requested", "approved"]) {
      const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status, version: 1 });
      const result = await archiveQuestion(db as never, "admin1", "admin", qId, 1);
      expect(result.ok).toBe(true);
      expect(questionRow(qId).editorial_status).toBe("archived");
    }
  });

  it("409 quando expectedVersion não bate numa transição", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await submitForReview(db as never, "editor1", "editor", qId, 999);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("ATOMICIDADE: transição + histórico no mesmo db.batch() — falha forçada no UPDATE não deixa histórico órfão", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.failNextMatching(/UPDATE questions SET editorial_status/);
    await expect(submitForReview(db as never, "editor1", "editor", qId, 1)).rejects.toThrow();
    expect(questionRow(qId).editorial_status).toBe("draft");
    expect(questionRow(qId).version).toBe(1);
    expect(historyCount(qId)).toBe(0);
  });

  it("ATOMICIDADE: falha forçada no INSERT de histórico reverte também o UPDATE de status (mesmo lote)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.failNextMatching(/INSERT INTO question_history/);
    await expect(submitForReview(db as never, "editor1", "editor", qId, 1)).rejects.toThrow();
    expect(questionRow(qId).editorial_status).toBe("draft");
    expect(historyCount(qId)).toBe(0);
  });

  it("IDEMPOTÊNCIA: reenviar a mesma transição com expectedVersion já obsoleta (mas correta na época) não duplica histórico", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const first = await submitForReview(db as never, "editor1", "editor", qId, 1);
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);

    // Reenvio idempotente: mesmo expectedVersion (1) da chamada original,
    // simulando um retry de rede depois que a primeira já teve sucesso.
    const retry = await submitForReview(db as never, "editor1", "editor", qId, 1);
    expect(retry.ok).toBe(true);
    expect(retry.changed).toBe(false);
    expect(historyCount(qId)).toBe(1); // nunca 2
    expect(questionRow(qId).version).toBe(2);
  });

  it("aprovação exige DNA completo", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "in_review", version: 2, withDna: false });
    db.sqlite.exec(`INSERT INTO question_dna (question_id, pista) VALUES ('${qId}', '')`);
    const result = await approveQuestion(db as never, "admin1", "admin", qId, 2);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.readiness).toMatch(/DNA/i);
  });

  it("publicação exige direitos completos (titular, licença, autor, revisor)", async () => {
    const qId = seedQuestion(db.sqlite, {
      patternId: "pat-1",
      status: "approved",
      version: 3,
      autorId: null,
      titularDireitos: null,
      baseLicenca: null,
    });
    const result = await publishQuestion(db as never, "admin1", "admin", qId, 3);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.readiness).toMatch(/direitos/i);
  });
});
