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
import {
  buildCollectionMutationReceiptStatement,
  buildConditionalHistoryStatement,
  buildDeleteTagsStatement,
  buildMutationCheckStatement,
  buildUpdateQuestionCoreStatement,
} from "../src/repositories/questionRepository";

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
    const result = await updateQuestion(db as never, "autor1", qId, 999, crypto.randomUUID(), {
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
    const result = await updateQuestion(db as never, "autor1", qId, 5, crypto.randomUUID(), {
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
    const result = await updateQuestion(db as never, "autor1", "id-que-nao-existe", 1, crypto.randomUUID(), {} as never);
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* Sprint 7 v1.1, Correção A — PATCH parcial de verdade                    */
/* ---------------------------------------------------------------------- */

describe("Correção A — semântica parcial do PATCH (v1.1) + idempotência por mutationId (v1.2)", () => {
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
  function auditLogCount(questionId: string): number {
    return (
      db.sqlite
        .prepare("SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'editorial_question_updated' AND metadata LIKE ?")
        .get(`%${questionId}%`) as { total: number }
    ).total;
  }
  function mid(): string {
    return crypto.randomUUID();
  }

  // 1. alterar apenas título/enunciado preserva todas as coleções.
  it("1. alterar apenas o enunciado preserva alternativas/DNA/padrões/tags/imagens", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, secondaryPatternIds: ["pat-2"] });
    db.sqlite.exec(`INSERT INTO question_tags (id, question_id, content, position) VALUES ('t1','${qId}','fixture',0)`);
    db.sqlite.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text) VALUES ('i1','${qId}','assets/questoes/x.png','alt')`);

    const before = { alt: altCount(qId), tag: tagCount(qId), pat: patternCount(qId) };
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { enunciado: "Novo enunciado bem diferente do original para teste A1." } as never);

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
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
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { alternativas: newAlternatives } as never);

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
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Novo conteúdo" } as never);
    expect(result.ok).toBe(true);
    expect(altCount(qId)).toBe(5);
  });

  // 4. enviar alternatives: [] limpa somente quando o estado permitir.
  it("4. 'alternativas: []' limpa explicitamente enquanto a questão está em draft", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { alternativas: [] } as never);
    expect(result.ok).toBe(true);
    expect(altCount(qId)).toBe(0);
  });

  it("4b. 'alternativas: []' é rejeitada (nada é apagado) quando a questão não está mais num status editável", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "published", version: 5 });
    const result = await updateQuestion(db as never, "autor1", qId, 5, mid(), { alternativas: [] } as never);
    expect(result.ok).toBe(false);
    expect(altCount(qId)).toBe(5);
  });

  // 5. campo obrigatório null retorna 400 sem escrever.
  it("5. enviar um campo obrigatório como null retorna erro de validação SEM escrever nada", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { enunciado: null } as never);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.enunciado).toBeDefined();
    expect(questionRow(qId).version).toBe(1); // nada foi gravado
  });

  it("5b. campos ANULÁVEIS (ex.: prova) aceitam null explícito e limpam o campo", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.sqlite.exec(`UPDATE questions SET prova = 'ENEM 2024' WHERE id = '${qId}'`);
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { prova: null } as never);
    expect(result.ok).toBe(true);
    const row = db.sqlite.prepare("SELECT prova FROM questions WHERE id = ?").get(qId) as { prova: string | null };
    expect(row.prova).toBeNull();
  });

  // 6 / 12. falha forçada numa coleção reverte escalar e demais coleções.
  it("6/12. falha forçada no INSERT de uma coleção reverte TAMBÉM o UPDATE escalar e as outras coleções", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.failNextMatching(/INSERT INTO question_tags/);
    await expect(
      updateQuestion(db as never, "autor1", qId, 1, mid(), {
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
    const result = await updateQuestion(db as never, "autor1", qId, 999, mid(), {
      enunciado: "Não deveria persistir.",
      tags: ["nao-deveria-persistir"],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(tagCount(qId)).toBe(0);
    expect(questionRow(qId).version).toBe(1);
  });

  // 8 (mass assignment). de status/papel/autor alheio é rejeitado.
  it("8. mass assignment via PATCH: editorialStatus/version/autorId/revisorId são ignorados", async () => {
    const token = await seedUserWithSession("editorA8");
    grantRole("editorA8", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const response = await callRoute(`/api/editorial/questions/${qId}`, token, {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: 1,
        mutationId: mid(),
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

  it("histórico registra os NOMES dos grupos alterados, nunca o conteúdo integral", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    await updateQuestion(db as never, "autor1", qId, 1, mid(), { enunciado: "Enunciado sensível que não deve vazar no histórico." } as never);
    const hist = db.sqlite.prepare("SELECT metadata FROM question_history WHERE question_id = ? ORDER BY created_at DESC LIMIT 1").get(qId) as {
      metadata: string;
    };
    expect(hist.metadata).toContain("enunciado");
    expect(hist.metadata).not.toContain("Enunciado sensível");
  });

  /* ------------------------- Sprint 7 v1.2, Correção A --------------------- */
  /* Os 15 cenários exigidos pela ordem de correção final (seção 5).          */

  // 1. retry com mesma mutationId → sucesso sem nova escrita.
  it("v1.2-1. retry com a MESMA mutationId → sucesso idempotente, sem nova escrita/histórico", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const mutationId = mid();
    const first = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { conteudo: "Conteúdo alterado uma vez." } as never);
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    const historyAfterFirst = historyCount(qId);
    const versionAfterFirst = questionRow(qId).version;

    // Retry: MESMO mutationId, mesma expectedVersion original (1, já obsoleta).
    const retry = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { conteudo: "Conteúdo alterado uma vez." } as never);
    expect(retry.ok).toBe(true);
    expect(retry.changed).toBe(false);
    expect(historyCount(qId)).toBe(historyAfterFirst); // nunca duplica
    expect(questionRow(qId).version).toBe(versionAfterFirst); // nenhuma escrita nova
  });

  // 2. nova mutationId + versão antiga → 409.
  it("v1.2-2. mutationId NOVA com versão desatualizada → 409 (conflito real, não idempotência)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const first = await updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Primeira edição real." } as never);
    expect(first.ok).toBe(true);

    // mutationId DIFERENTE da primeira, mas expectedVersion=1 (já obsoleta).
    const second = await updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Segunda tentativa com versão velha." } as never);
    expect(second.ok).toBe(false);
    expect(second.conflict).toBe(true);
  });

  // 3. mesma mutationId usada por outra questão → 409.
  it("v1.2-3. a MESMA mutationId reutilizada para OUTRA questão → 409 (colisão, nunca retry)", async () => {
    const qId1 = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const qId2 = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const mutationId = mid();
    const first = await updateQuestion(db as never, "autor1", qId1, 1, mutationId, { conteudo: "Edição da questão 1." } as never);
    expect(first.ok).toBe(true);

    const collision = await updateQuestion(db as never, "autor1", qId2, 1, mutationId, { conteudo: "Edição da questão 2." } as never);
    expect(collision.ok).toBe(false);
    expect(collision.conflict).toBe(true);
    // A questão 2 nunca foi tocada.
    expect(questionRow(qId2).version).toBe(1);
  });

  // 4. mesma mutationId usada por outro ator → 409.
  it("v1.2-4. a MESMA mutationId reutilizada por OUTRO ator → 409 (colisão, nunca retry)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const mutationId = mid();
    const first = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { conteudo: "Edição pelo autor1." } as never);
    expect(first.ok).toBe(true);
    const versionAfterFirst = questionRow(qId).version;

    const collision = await updateQuestion(db as never, "editor1", qId, versionAfterFirst, mutationId, { conteudo: "Tentativa de outro ator com o mesmo ID." } as never);
    expect(collision.ok).toBe(false);
    expect(collision.conflict).toBe(true);
    expect(questionRow(qId).version).toBe(versionAfterFirst); // não tocado pela colisão
  });

  // 5/6/7. edição concorrente que muda SÓ tags/DNA/imagens-ou-direitos nunca
  // é confundida com um retry — exatamente o cenário que a heurística de
  // conteúdo da v1.1 acertava por acaso (por nunca comparar essas colunas) e
  // que, olhando de novo, ERA o bug: qualquer PATCH que só tocasse essas
  // coleções tinha `enunciado/conteudo/dificuldade/origem/fingerprint`
  // idênticos ao estado anterior — a v1.1 teria classificado uma tentativa
  // de PATCH com a MESMA versão-alvo e ESSES escalares iguais como "retry",
  // mesmo sendo uma tentativa síncrona real e válida. Com mutationId como
  // única prova, cada uma dessas chamadas (mutationId DIFERENTE) é tratada
  // como sua própria mutação — nunca aceita/rejeitada por parecença de conteúdo.
  it("v1.2-5. edição que muda SÓ tags nunca é confundida com retry (mutationId diferente = mutação própria)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const first = await updateQuestion(db as never, "autor1", qId, 1, mid(), { tags: ["primeira-tag"] } as never);
    expect(first.ok).toBe(true);
    const versionAfterFirst = questionRow(qId).version;

    // Segunda chamada: versão correta (não é um conflito de verdade), tags
    // DIFERENTES, mutationId NOVO — é uma segunda edição real, não um retry.
    const second = await updateQuestion(db as never, "autor1", qId, versionAfterFirst, mid(), { tags: ["segunda-tag-diferente"] } as never);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(true); // NUNCA seria aceita como idempotente
    const tags = db.sqlite.prepare("SELECT content FROM question_tags WHERE question_id = ?").all(qId) as Array<{ content: string }>;
    expect(tags.map((t) => t.content)).toEqual(["segunda-tag-diferente"]);
  });

  it("v1.2-6. edição que muda SÓ o DNA nunca é confundida com retry", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const first = await updateQuestion(db as never, "autor1", qId, 1, mid(), { dna: { ...validDna, pista: "Pista versão 1" } } as never);
    expect(first.ok).toBe(true);
    const versionAfterFirst = questionRow(qId).version;

    const second = await updateQuestion(db as never, "autor1", qId, versionAfterFirst, mid(), { dna: { ...validDna, pista: "Pista versão 2, bem diferente" } } as never);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(true);
    expect(dnaRow(qId)?.pista).toBe("Pista versão 2, bem diferente");
  });

  it("v1.2-7. edição que muda SÓ imagens/direitos nunca é confundida com retry", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const first = await updateQuestion(db as never, "autor1", qId, 1, mid(), { titularDireitos: "Titular A" } as never);
    expect(first.ok).toBe(true);
    const versionAfterFirst = questionRow(qId).version;

    const second = await updateQuestion(db as never, "autor1", qId, versionAfterFirst, mid(), {
      titularDireitos: "Titular B, completamente diferente",
      imagens: [{ assetRef: "assets/questoes/nova.png", altText: "Descrição da imagem", caption: null, position: 0 }],
    } as never);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(true);
    expect(imageCount(qId)).toBe(1);
  });

  // 8. PATCH vazio → 400, zero escrita.
  it("v1.2-8. corpo do PATCH sem NENHUM campo/coleção editável → 400, versão nunca incrementada", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), {} as never);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?._body).toBeDefined();
    expect(questionRow(qId).version).toBe(1);
    expect(historyCount(qId)).toBe(0);
  });

  // 9. no-op (valores idênticos ao atual) → changed:false, zero escrita.
  it("v1.2-9. PATCH com valores IDÊNTICOS ao estado atual → changed:false, sem nova versão/histórico/auditoria", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = questionRow(qId);
    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), {
      conteudo: "Conteúdo de teste", // mesmo valor já gravado por seedQuestion
      tags: [],
    } as never);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(questionRow(qId).version).toBe(before.version); // nenhuma escrita
    expect(historyCount(qId)).toBe(0);
    expect(auditLogCount(qId)).toBe(0);
  });

  // 10. histórico condicionado com changes=0 inesperado → operação não aceita sucesso.
  it("v1.2-10. um INSERT de question_history com changes=0 inesperado (guard NOT EXISTS já satisfeito por outra linha) nunca é aceito como sucesso", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    // Insere manualmente uma linha de histórico JÁ ocupando (question_id, version=2)
    // com um ID diferente do mutationId desta chamada — simula a anomalia:
    // o UPDATE escalar iria suceder e levar a questão à version=2, mas o
    // guard `NOT EXISTS(question_id, version)` do INSERT condicionado da
    // Correção A falha porque ESSA versão já tem um histórico (de outra
    // origem), então o INSERT do mutationId desta chamada afetaria 0 linhas
    // SILENCIOSAMENTE.
    //
    // v1.6 — desde a introdução do trigger de IDENTIDADE
    // (migrations/0012_editorial_mutation_identity.sql), este cenário
    // específico passou a ser capturado ANTES do commit pelo próprio banco
    // (o histórico QUE ESTA mutationId deveria ter inserido nunca existe,
    // mas `last_mutation_id` seria setado para ela pelo UPDATE central) —
    // uma proteção estritamente mais forte que a checagem em JS pós-commit
    // da Correção B (`validateBatchResults`), que ainda existe como defesa
    // em profundidade mas nunca mais precisa disparar para ESTE cenário.
    // A prova agora é por ESTADO DO BANCO (nada foi commitado), não mais só
    // pela mensagem de erro.
    const before = questionRow(qId);
    db.sqlite.exec(
      `INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('${mid()}','${qId}','autor1','updated','draft','draft',2)`
    );
    const historyBefore = historyCount(qId);
    await expect(updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Nova tentativa de conteúdo." } as never)).rejects.toThrow(
      /invariante violada/i
    );
    const after = questionRow(qId);
    expect(after.version).toBe(before.version); // nunca chegou a version=2
    const row = db.sqlite.prepare("SELECT conteudo FROM questions WHERE id = ?").get(qId) as { conteudo: string };
    expect(row.conteudo).not.toBe("Nova tentativa de conteúdo.");
    expect(historyCount(qId)).toBe(historyBefore); // nenhum histórico A MAIS desta tentativa
  });

  // 11. falha forçada no histórico → rollback.
  it("v1.2-11. falha forçada no INSERT de question_history reverte TAMBÉM o UPDATE escalar", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.failNextMatching(/INSERT INTO question_history/);
    await expect(updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Não deveria persistir." } as never)).rejects.toThrow();
    const row = db.sqlite.prepare("SELECT conteudo, version FROM questions WHERE id = ?").get(qId) as { conteudo: string; version: number };
    expect(row.conteudo).not.toBe("Não deveria persistir.");
    expect(row.version).toBe(1);
  });

  // 13. audit_log só em changed:true.
  it("v1.2-13. audit_log só é gravado quando changed:true — nunca em no-op nem em retry idempotente", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const mutationId = mid();

    // No-op: sem audit_log.
    await updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Conteúdo de teste" } as never);
    expect(auditLogCount(qId)).toBe(0);

    // Mudança real: COM audit_log.
    const real = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { conteudo: "Conteúdo realmente novo." } as never);
    expect(real.changed).toBe(true);
    expect(auditLogCount(qId)).toBe(1);

    // Retry idempotente da mesma mutação: audit_log NÃO duplica.
    const retryVersion = questionRow(qId).version;
    const retry = await updateQuestion(db as never, "autor1", qId, retryVersion - 1, mutationId, { conteudo: "Conteúdo realmente novo." } as never);
    expect(retry.changed).toBe(false);
    expect(auditLogCount(qId)).toBe(1); // continua 1, nunca 2
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

/* ---------------------------------------------------------------------- */
/* Sprint 7 v1.3 — invariante transacional CORE+HISTÓRICO (migration 0009) */
/* Cenários A-G: cada um consulta o banco DIRETAMENTE depois da chamada,   */
/* nunca só o retorno da função/HTTP.                                      */
/* ---------------------------------------------------------------------- */

describe("Sprint 7 v1.3 — invariante core+histórico indivisível (trigger 0009)", () => {
  function coreSnapshot(id: string): { version: number; updated_at: string; enunciado: string; conteudo: string; editorial_status: string } {
    return db.sqlite
      .prepare("SELECT version, updated_at, enunciado, conteudo, editorial_status FROM questions WHERE id = ?")
      .get(id) as never;
  }
  function altTexts(id: string): string[] {
    return (db.sqlite.prepare("SELECT text FROM question_alternatives WHERE question_id = ? ORDER BY letter").all(id) as Array<{ text: string }>).map(
      (r) => r.text
    );
  }
  function tagContents(id: string): string[] {
    return (db.sqlite.prepare("SELECT content FROM question_tags WHERE question_id = ? ORDER BY content").all(id) as Array<{ content: string }>).map(
      (r) => r.content
    );
  }
  function auditLogCount(questionId: string): number {
    return (
      db.sqlite
        .prepare("SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'editorial_question_updated' AND metadata LIKE ?")
        .get(`%${questionId}%`) as { total: number }
    ).total;
  }
  function mid(): string {
    return crypto.randomUUID();
  }

  // A — o INSERT condicionado de question_history silenciosamente não
  // insere (guard falso, SEM lançar exceção) enquanto um UPDATE que muda
  // `version` roda no MESMO lote → o trigger 0009 aborta a transação
  // INTEIRA. Testado no nível do BATCH diretamente (não via updateQuestion)
  // porque, por construção do serviço (guards idênticos entre histórico e
  // core), o serviço nunca produz este cenário sozinho — o trigger existe
  // como rede de segurança de banco contra exatamente esta classe de bug,
  // mesmo que introduzida por um código futuro diferente do atual.
  it("A. histórico condicionado com guard falso (0 linhas, sem exceção) + UPDATE que muda version → transação INTEIRA abortada", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    // Statement de histórico com guard que NUNCA bate ("WHERE 1 = 0") —
    // simula o guard condicional falhando por algum motivo inesperado:
    // insere 0 linhas, sem lançar exceção alguma.
    const neverMatchingHistory = db.sqlite
      .prepare(
        `INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version)
         SELECT ?, ?, ?, 'updated', 'draft', 'draft', 2 WHERE 1 = 0`
      );
    const realCoreUpdate = db.sqlite.prepare(`UPDATE questions SET version = version + 1, updated_at = datetime('now') WHERE id = ? AND version = 1`);

    expect(() => {
      db.sqlite.exec("BEGIN");
      try {
        neverMatchingHistory.run(crypto.randomUUID(), qId, "autor1");
        realCoreUpdate.run(qId);
        db.sqlite.exec("COMMIT");
      } catch (error) {
        db.sqlite.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/invariante violada/i);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version); // rollback comprovado
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.enunciado).toBe(before.enunciado);
    expect(altTexts(qId)).toEqual(["Alternativa A de teste", "Alternativa B de teste", "Alternativa C de teste", "Alternativa D de teste", "Alternativa E de teste"]);
    expect(historyCount(qId)).toBe(historyBefore);
    expect(auditLogCount(qId)).toBe(0);
  });

  // B — uma operação de coleção obrigatória produz um resultado
  // inválido/inesperado (forçado via exceção real numa das linhas) →
  // rollback completo: núcleo E TODAS as coleções continuam com os valores
  // PRÉVIOS, zero histórico, zero auditoria — verificado diretamente no banco.
  it("B. falha numa operação de coleção obrigatória → rollback completo (núcleo e TODAS as coleções inalterados)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.sqlite.exec(`INSERT INTO question_tags (id, question_id, content, position) VALUES ('t-pre','${qId}','tag-original',0)`);
    const before = coreSnapshot(qId);
    const altsBefore = altTexts(qId);
    const tagsBefore = tagContents(qId);
    const historyBefore = historyCount(qId);

    db.failNextMatching(/INSERT INTO question_tags/);
    await expect(
      updateQuestion(db as never, "autor1", qId, 1, mid(), {
        enunciado: "Enunciado que não deveria persistir de jeito nenhum.",
        alternativas: validAlternatives as never,
        tags: ["tag-nova-que-nao-deveria-existir"],
      } as never)
    ).rejects.toThrow();

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.enunciado).toBe(before.enunciado);
    expect(altTexts(qId)).toEqual(altsBefore); // alternativas (outra coleção do MESMO lote) também intactas
    expect(tagContents(qId)).toEqual(tagsBefore); // a própria coleção que falhou também não mudou nada
    expect(historyCount(qId)).toBe(historyBefore);
    expect(auditLogCount(qId)).toBe(0);
  });

  // C — falha SQL real (forçada) no INSERT de question_history → rollback
  // completo, provado diretamente no banco.
  it("C. falha forçada no INSERT de question_history → rollback completo provado no banco", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    db.failNextMatching(/INSERT INTO question_history/);
    await expect(updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Não deveria persistir." } as never)).rejects.toThrow();

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);
    const row = db.sqlite.prepare("SELECT conteudo FROM questions WHERE id = ?").get(qId) as { conteudo: string };
    expect(row.conteudo).not.toBe("Não deveria persistir.");
    expect(historyCount(qId)).toBe(historyBefore);
    expect(auditLogCount(qId)).toBe(0);
  });

  // D — caminho normal: exatamente uma mudança no núcleo, exatamente uma
  // linha de histórico, exatamente uma linha de auditoria.
  it("D. caminho normal: exatamente 1 mudança de núcleo, 1 histórico, 1 auditoria", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);

    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Conteúdo genuinamente novo." } as never);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version + 1); // exatamente 1 mudança de núcleo
    expect(after.conteudo).toBe("Conteúdo genuinamente novo.");
    expect(historyCount(qId)).toBe(1);
    expect(auditLogCount(qId)).toBe(1);
  });

  // E — retry com a MESMA mutationId → changed:false, version inalterada,
  // nenhum histórico/auditoria ADICIONAL.
  it("E. retry com a MESMA mutationId → changed:false, version inalterada, zero histórico/auditoria adicionais", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const mutationId = mid();
    const first = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { conteudo: "Conteúdo alterado." } as never);
    expect(first.ok).toBe(true);
    const afterFirst = coreSnapshot(qId);
    const historyAfterFirst = historyCount(qId);
    const auditAfterFirst = auditLogCount(qId);

    const retry = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { conteudo: "Conteúdo alterado." } as never);
    expect(retry.ok).toBe(true);
    expect(retry.changed).toBe(false);

    const afterRetry = coreSnapshot(qId);
    expect(afterRetry.version).toBe(afterFirst.version); // inalterada
    expect(afterRetry.updated_at).toBe(afterFirst.updated_at);
    expect(historyCount(qId)).toBe(historyAfterFirst); // nenhum adicional
    expect(auditLogCount(qId)).toBe(auditAfterFirst); // nenhum adicional
  });

  // F — colisão de mutationId → 409, zero mudanças.
  it("F. colisão de mutationId (outra questão) → 409, zero mudanças no banco", async () => {
    const qId1 = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const qId2 = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const mutationId = mid();
    await updateQuestion(db as never, "autor1", qId1, 1, mutationId, { conteudo: "Edição legítima da questão 1." } as never);

    const before2 = coreSnapshot(qId2);
    const historyBefore2 = historyCount(qId2);
    const collision = await updateQuestion(db as never, "autor1", qId2, 1, mutationId, { conteudo: "Tentativa de colisão na questão 2." } as never);
    expect(collision.ok).toBe(false);
    expect(collision.conflict).toBe(true);

    const after2 = coreSnapshot(qId2);
    expect(after2.version).toBe(before2.version);
    expect(after2.conteudo).not.toBe("Tentativa de colisão na questão 2.");
    expect(historyCount(qId2)).toBe(historyBefore2);
    expect(auditLogCount(qId2)).toBe(0);
  });

  // G — no-op com mutationId NOVA (nunca usada antes) → changed:false, zero
  // escrita, version/histórico/auditoria todos inalterados.
  it("G. no-op com mutationId NOVA → changed:false, zero escrita, version/histórico/auditoria inalterados", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { conteudo: "Conteúdo de teste" } as never); // mesmo valor já gravado
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);
    expect(historyCount(qId)).toBe(historyBefore);
    expect(auditLogCount(qId)).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* Sprint 7 v1.4 — invariante BIDIRECIONAL núcleo<->histórico (migration    */
/* 0010): cobre a direção que o trigger de 0009 NÃO cobre — histórico       */
/* condicionado bate seu próprio guard e insere de verdade, mas o UPDATE    */
/* central de `questions` é construído com uma versão deliberadamente       */
/* ERRADA (bypass do serviço, direto no repositório) e afeta 0 linhas       */
/* SILENCIOSAMENTE, sem lançar exceção alguma — cenário que jamais dispara  */
/* o `AFTER UPDATE` de 0009 (só reage a uma linha que de fato mudou).       */
/* Prova exigida: db.batch() lança, e o banco é consultado DIRETAMENTE      */
/* depois da falha para confirmar ausência de QUALQUER resíduo — núcleo,    */
/* histórico E a própria tabela de checagem (editorial_mutation_checks).    */
/* ---------------------------------------------------------------------- */
describe("Sprint 7 v1.4 — invariante bidirecional núcleo<->histórico (trigger 0010)", () => {
  function coreSnapshot(id: string): { version: number; updated_at: string; enunciado: string; editorial_status: string } {
    return db.sqlite.prepare("SELECT version, updated_at, enunciado, editorial_status FROM questions WHERE id = ?").get(id) as never;
  }
  function mutationChecksCount(): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number }).total;
  }
  function auditLogCount(questionId: string): number {
    return (
      db.sqlite
        .prepare("SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'editorial_question_updated' AND metadata LIKE ?")
        .get(`%${questionId}%`) as { total: number }
    ).total;
  }

  it("histórico condicionado bate seu PRÓPRIO guard e insere de verdade, mas o UPDATE central usa uma versão deliberadamente ERRADA e afeta 0 linhas silenciosamente → o marcador final aborta a transação INTEIRA, sem exceção prévia de nenhum statement individual", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);
    const auditBefore = auditLogCount(qId);
    const markerBefore = mutationChecksCount();

    // Histórico: guard usa a versão REAL/atual (1) — bate de verdade,
    // insere 1 linha para (question_id=qId, version=2). v1.6 — MESMA
    // identidade (`thisMutationId`) do UPDATE central abaixo: simula um bug
    // interno que desalinha o guard de VERSÃO do core do guard do
    // histórico, DENTRO da mesma mutação — nunca uma mutação diferente
    // (esse é o cenário do teste de conflito B, describe "Sprint 7 v1.6").
    const thisMutationId = crypto.randomUUID();
    const historyStatement = buildConditionalHistoryStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      userId: "autor1",
      action: "updated",
      fromStatus: "draft",
      toStatus: "draft",
      guardVersion: 1,
      versionAfter: 2,
      guardStatuses: ["draft", "changes_requested"],
      metadata: null,
    });

    // UPDATE central: construído com expectedVersion = 999 (DELIBERADAMENTE
    // errado, simulando um bug num código futuro que desalinhe o guard do
    // core do guard do histórico) — o guard não bate, afeta 0 linhas, SEM
    // lançar exceção alguma. `last_mutation_id` nunca chega a ser setado
    // para `thisMutationId` porque este UPDATE nunca afeta nenhuma linha.
    const coreUpdateWithWrongVersion = buildUpdateQuestionCoreStatement(db as never, qId, 999, thisMutationId, {
      enunciado: before.enunciado,
      resolucaoComentada: "",
      conteudo: "",
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade: "media",
      origem: "autoral",
      prova: null,
      ano: null,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: 0,
      titularDireitos: null,
      baseLicenca: null,
      textoAtribuicao: null,
      fingerprint: "fp-nao-deveria-persistir",
    });

    // Marcador final e incondicional: MESMA identidade (`thisMutationId`) —
    // é isso que permite ao trigger de 0012 perguntar "o histórico QUE ESTA
    // MUTAÇÃO deveria ter inserido existe?" (sim) contra "o núcleo avançou
    // POR CAUSA DESTA MUTAÇÃO?" (não, seu UPDATE nunca afetou nenhuma
    // linha) — divergência real, aborta corretamente.
    const mutationCheck = buildMutationCheckStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      expectedVersion: 2,
      alternativesExpectedCount: null,
      dnaExpectedCount: null,
      patternsExpectedCount: null,
      tagsExpectedCount: null,
      imagesExpectedCount: null,
    });

    await expect(db.batch([historyStatement, coreUpdateWithWrongVersion, mutationCheck])).rejects.toThrow(/invariante violada/i);

    // Nenhum resíduo de NENHUM tipo: nem núcleo, nem histórico (mesmo tendo
    // seu PRÓPRIO guard satisfeito e "conseguido" inserir dentro da
    // transação), nem a própria linha-marcador, nem auditoria.
    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.enunciado).toBe(before.enunciado);
    expect(historyCount(qId)).toBe(historyBefore);
    expect(auditLogCount(qId)).toBe(auditBefore);
    expect(mutationChecksCount()).toBe(markerBefore);
  });
});

/* ---------------------------------------------------------------------- */
/* Sprint 7 v1.5 — recibo de mutação por coleção (migration 0011): fecha o  */
/* buraco que 0010 sozinha deixava para coleções ESVAZIADAS. Cenários A-F,  */
/* cada um consultando o banco DIRETAMENTE, nunca só o retorno da função.   */
/* ---------------------------------------------------------------------- */
describe("Sprint 7 v1.5 — recibo de mutação por coleção (trigger 0011)", () => {
  function coreSnapshot(id: string): { version: number; updated_at: string; editorial_status: string } {
    return db.sqlite.prepare("SELECT version, updated_at, editorial_status FROM questions WHERE id = ?").get(id) as never;
  }
  function tagContents(id: string): string[] {
    return (db.sqlite.prepare("SELECT content FROM question_tags WHERE question_id = ? ORDER BY content").all(id) as Array<{ content: string }>).map(
      (r) => r.content
    );
  }
  function auditLogCount(questionId: string): number {
    return (
      db.sqlite
        .prepare("SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'editorial_question_updated' AND metadata LIKE ?")
        .get(`%${questionId}%`) as { total: number }
    ).total;
  }
  function mutationChecksCount(): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number }).total;
  }
  function receiptsCount(): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_collection_mutation_receipts").get() as { total: number }).total;
  }
  function seedTag(questionId: string, id: string, content: string, position: number): void {
    db.sqlite
      .prepare("INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES (?, ?, ?, ?, ?)")
      .run(id, questionId, content, position, 1);
  }
  function mid(): string {
    return crypto.randomUUID();
  }

  // A — limpeza VÁLIDA de uma coleção não vazia para vazia, pelo caminho
  // normal do serviço: coleção termina vazia, núcleo avança, exatamente 1
  // histórico, exatamente 1 auditoria, zero resíduo técnico (marcador E
  // recibo).
  it("A. PATCH com tags:[] limpa uma coleção não vazia de verdade — núcleo avança, 1 histórico, 1 auditoria, zero resíduo técnico", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    seedTag(qId, "t1", "tag-antiga-1", 0);
    seedTag(qId, "t2", "tag-antiga-2", 1);
    const before = coreSnapshot(qId);

    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { tags: [] } as never);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version + 1);
    expect(tagContents(qId)).toEqual([]); // coleção genuinamente vazia
    expect(historyCount(qId)).toBe(1);
    expect(auditLogCount(qId)).toBe(1);
    expect(mutationChecksCount()).toBe(0); // v1.5 — sem resíduo do marcador
    expect(receiptsCount()).toBe(0); // v1.5 — sem resíduo do recibo
  });

  // B — falha silenciosa forçada no DELETE de uma coleção que deveria ficar
  // vazia (construído diretamente pelo repositório, bypassando o serviço,
  // igual ao teste adversarial v1.4): núcleo e histórico usam o guard
  // CORRETO (sucesso genuíno), mas o DELETE de tags é construído com uma
  // versão deliberadamente ERRADA — afeta 0 linhas, SEM lançar. O recibo,
  // construído com a MESMA versão errada (replicando fielmente como o
  // serviço sempre usa o mesmo guardVersion para DELETE e recibo), também
  // não é gravado. O trigger de 0011 detecta a divergência (núcleo mudou,
  // recibo ausente) e aborta TUDO — inclusive o núcleo e o histórico, que
  // tinham "conseguido" no resto da transação.
  it("B. DELETE guardado de uma coleção afeta 0 linhas silenciosamente (versão errada) enquanto núcleo e histórico usam o guard correto → trigger 0011 aborta a transação INTEIRA; as linhas antigas da coleção sobrevivem intocadas", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    seedTag(qId, "t1", "tag-antiga", 0);
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);
    const auditBefore = auditLogCount(qId);

    // v1.6 — MESMA identidade (`thisMutationId`) em histórico/núcleo/
    // recibo/marcador — fiel ao que o serviço real sempre faz. O DELETE de
    // tags abaixo é construído com uma versão ERRADA de propósito
    // (simulando um bug futuro), mas a IDENTIDADE (thisMutationId) é a
    // mesma em todo o resto — é exatamente esse cenário (mesma identidade,
    // guard divergente só no DELETE/recibo) que prova a invariante,
    // distinto do cenário de CONFLITO ENTRE MUTAÇÕES (describe "Sprint 7
    // v1.6"), que usa identidades DIFERENTES.
    const thisMutationId = crypto.randomUUID();
    const historyStatement = buildConditionalHistoryStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      userId: "autor1",
      action: "updated",
      fromStatus: "draft",
      toStatus: "draft",
      guardVersion: 1,
      versionAfter: 2,
      guardStatuses: ["draft", "changes_requested"],
      metadata: null,
    });
    const coreUpdate = buildUpdateQuestionCoreStatement(db as never, qId, 1, thisMutationId, {
      enunciado: "Enunciado inalterado.",
      resolucaoComentada: "",
      conteudo: "",
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade: "media",
      origem: "autoral",
      prova: null,
      ano: null,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: 0,
      titularDireitos: null,
      baseLicenca: null,
      textoAtribuicao: null,
      fingerprint: "fp-b-nao-deveria-persistir",
    });
    // Versão deliberadamente ERRADA (999) — simula o guard do DELETE não
    // avaliando como esperado; afeta 0 linhas, sem lançar.
    const brokenDeleteTags = buildDeleteTagsStatement(db as never, qId, 999);
    // Recibo construído com a MESMA versão errada — fiel ao fato de que, no
    // serviço real, DELETE e recibo SEMPRE recebem o mesmo `guardVersion` —
    // e com a MESMA identidade (thisMutationId) no id composto.
    const receipt = buildCollectionMutationReceiptStatement(db as never, {
      id: `${thisMutationId}:question_tags`,
      questionId: qId,
      collection: "question_tags",
      guardVersion: 999,
      expectedVersion: 2,
    });
    const mutationCheck = buildMutationCheckStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      expectedVersion: 2,
      alternativesExpectedCount: null,
      dnaExpectedCount: null,
      patternsExpectedCount: null,
      tagsExpectedCount: 0,
      imagesExpectedCount: null,
    });

    await expect(db.batch([historyStatement, coreUpdate, brokenDeleteTags, receipt, mutationCheck])).rejects.toThrow(/invariante violada/i);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version); // núcleo revertido
    expect(after.updated_at).toBe(before.updated_at);
    expect(tagContents(qId)).toEqual(["tag-antiga"]); // linha antiga sobreviveu — prova que o abort preveniu mutação parcial
    expect(historyCount(qId)).toBe(historyBefore); // histórico revertido, mesmo tendo "conseguido" inserir
    expect(auditLogCount(qId)).toBe(auditBefore);
    expect(mutationChecksCount()).toBe(0);
    expect(receiptsCount()).toBe(0);
  });

  // C — núcleo E o DELETE da coleção têm sucesso genuíno (tags realmente
  // ficam vazias), mas o statement de RECIBO é OMITIDO inteiramente do lote
  // (simula uma regressão futura que esqueceu de gravá-lo para algum tipo
  // de coleção) — o trigger de 0011 ainda assim aborta, porque a garantia
  // não depende de "o resultado por acaso está certo", e sim da PROVA
  // (recibo) de que o guard rodou. Rollback completo, inclusive do DELETE
  // que genuinamente funcionou.
  it("C. núcleo e DELETE da coleção têm sucesso genuíno, mas o recibo é OMITIDO do lote → trigger 0011 aborta mesmo assim, revertendo inclusive o DELETE que funcionou de verdade", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    seedTag(qId, "t1", "tag-antiga", 0);
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);
    const auditBefore = auditLogCount(qId);

    const thisMutationId = crypto.randomUUID();
    const historyStatement = buildConditionalHistoryStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      userId: "autor1",
      action: "updated",
      fromStatus: "draft",
      toStatus: "draft",
      guardVersion: 1,
      versionAfter: 2,
      guardStatuses: ["draft", "changes_requested"],
      metadata: null,
    });
    const coreUpdate = buildUpdateQuestionCoreStatement(db as never, qId, 1, thisMutationId, {
      enunciado: "Enunciado inalterado.",
      resolucaoComentada: "",
      conteudo: "",
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade: "media",
      origem: "autoral",
      prova: null,
      ano: null,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: 0,
      titularDireitos: null,
      baseLicenca: null,
      textoAtribuicao: null,
      fingerprint: "fp-c-nao-deveria-persistir",
    });
    // DELETE com o guard CORRETO — de fato limpa as tags.
    const realDeleteTags = buildDeleteTagsStatement(db as never, qId, 1);
    const mutationCheck = buildMutationCheckStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      expectedVersion: 2,
      alternativesExpectedCount: null,
      dnaExpectedCount: null,
      patternsExpectedCount: null,
      tagsExpectedCount: 0,
      imagesExpectedCount: null,
    });

    // SEM nenhum statement de recibo — omitido de propósito.
    await expect(db.batch([historyStatement, coreUpdate, realDeleteTags, mutationCheck])).rejects.toThrow(/invariante violada/i);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version);
    expect(tagContents(qId)).toEqual(["tag-antiga"]); // o DELETE que funcionou também foi revertido
    expect(historyCount(qId)).toBe(historyBefore);
    expect(auditLogCount(qId)).toBe(auditBefore);
    expect(mutationChecksCount()).toBe(0);
    expect(receiptsCount()).toBe(0);
  });

  // D — retry idempotente (mesma mutationId): zero escrita de negócio,
  // zero resíduo técnico.
  it("D. retry idempotente com a MESMA mutationId → zero escrita de negócio, zero resíduo técnico (marcador e recibo)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    seedTag(qId, "t1", "tag-1", 0);
    const mutationId = mid();

    const first = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { tags: [] } as never);
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(mutationChecksCount()).toBe(0);
    expect(receiptsCount()).toBe(0);

    const afterFirst = coreSnapshot(qId);
    const historyAfterFirst = historyCount(qId);
    const auditAfterFirst = auditLogCount(qId);

    const retry = await updateQuestion(db as never, "autor1", qId, 1, mutationId, { tags: [] } as never);
    expect(retry.ok).toBe(true);
    expect(retry.changed).toBe(false);

    const afterRetry = coreSnapshot(qId);
    expect(afterRetry.version).toBe(afterFirst.version);
    expect(historyCount(qId)).toBe(historyAfterFirst);
    expect(auditLogCount(qId)).toBe(auditAfterFirst);
    expect(mutationChecksCount()).toBe(0);
    expect(receiptsCount()).toBe(0);
  });

  // E — conflito de versão (expectedVersion desatualizada) tocando uma
  // coleção: zero escrita de negócio, zero resíduo técnico — a mesma classe
  // de correção que 0010 já precisou para a contagem também se aplica aqui,
  // para o recibo.
  it("E. conflito de versão tocando uma coleção → 409, zero escrita de negócio, zero resíduo técnico (marcador e recibo)", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    seedTag(qId, "t1", "tag-1", 0);
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    const result = await updateQuestion(db as never, "autor1", qId, 999, mid(), { tags: [] } as never);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version);
    expect(tagContents(qId)).toEqual(["tag-1"]); // intocada
    expect(historyCount(qId)).toBe(historyBefore);
    expect(mutationChecksCount()).toBe(0);
    expect(receiptsCount()).toBe(0);
  });

  // F — mutação normal com uma coleção terminando NÃO vazia (comportamento
  // v1.3/v1.4 já coberto alhures): a NOVA asserção aqui é que a limpeza
  // técnica também se aplica ao caso N>0, não só ao caso recém-corrigido
  // (vazio).
  it("F. mutação normal com coleção terminando NÃO vazia → comportamento v1.3/v1.4 preservado, e zero resíduo técnico também neste caso", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);

    const result = await updateQuestion(db as never, "autor1", qId, 1, mid(), { tags: ["tag-nova-1", "tag-nova-2"] } as never);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version + 1);
    expect(tagContents(qId)).toEqual(["tag-nova-1", "tag-nova-2"]);
    expect(historyCount(qId)).toBe(1);
    expect(auditLogCount(qId)).toBe(1);
    expect(mutationChecksCount()).toBe(0); // v1.5 — sem resíduo, também no caso N>0
    expect(receiptsCount()).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* Sprint 7 v1.6 — reprodução do conflito real de concorrência otimista    */
/* (marcador/recibo indexados por VERSÃO, não pela mutação específica):     */
/* mutação B, construída contra uma expectedVersion já obsoleta porque A    */
/* avançou primeiro, insere seu próprio marcador declarando                 */
/* expected_version=2 (o alvo que B CALCULOU, 1+1) — mas quem realmente     */
/* está em version=2 é A, não B. Os triggers de 0010/0011 (chave por        */
/* question_id+version) enxergam "núcleo em v2 = true" (graças a A) contra  */
/* "recibo de B para aquela coleção em v2 = false" (B nunca escreveu, A não */
/* tocou a mesma coleção) → abortam um conflito de versão LEGÍTIMO como se  */
/* fosse uma corrupção real. Este teste PRECISA falhar contra o código      */
/* anterior à correção (commit 820196e) — reprodução mandatória antes do    */
/* fix, não um teste vindo já verde.                                        */
/* ---------------------------------------------------------------------- */
describe("Sprint 7 v1.6 — reprodução: conflito de versão real vira exceção não tratada (bug pré-fix)", () => {
  function coreSnapshot(id: string): { version: number; updated_at: string } {
    return db.sqlite.prepare("SELECT version, updated_at FROM questions WHERE id = ?").get(id) as never;
  }
  function tagContents(id: string): string[] {
    return (db.sqlite.prepare("SELECT content FROM question_tags WHERE question_id = ? ORDER BY content").all(id) as Array<{ content: string }>).map(
      (r) => r.content
    );
  }
  function auditLogCount(questionId: string): number {
    return (
      db.sqlite
        .prepare("SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'editorial_question_updated' AND metadata LIKE ?")
        .get(`%${questionId}%`) as { total: number }
    ).total;
  }
  function mutationChecksCount(): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number }).total;
  }
  function receiptsCount(): number {
    return (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_collection_mutation_receipts").get() as { total: number }).total;
  }
  function mid(): string {
    return crypto.randomUUID();
  }

  it("mutação A (mutationId A) avança v1->v2 tocando tags; mutação B (mutationId B, DIFERENTE, expectedVersion=1 já obsoleta) também toca tags → B deve devolver 409 gracioso, nunca uma exceção de banco", async () => {
    const token = await seedUserWithSession("autorB1");
    grantRole("autorB1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });

    // Mutação A: sucesso genuíno, v1 -> v2, grava tags.
    const mutationIdA = mid();
    const resultA = await updateQuestion(db as never, "autorB1", qId, 1, mutationIdA, { tags: ["tag-de-A"] } as never);
    expect(resultA.ok).toBe(true);
    expect(resultA.changed).toBe(true);
    const afterA = coreSnapshot(qId);
    expect(afterA.version).toBe(2);

    // Mutação B: mutationId DIFERENTE, expectedVersion=1 (correta na época
    // em que B foi construída, mas já obsoleta agora que A avançou) — B
    // também toca tags (mesma coleção que A já tocou, mas com um payload
    // DIFERENTE e um mutationId PRÓPRIO). Isto é um conflito de versão
    // ORDINÁRIO — nunca deveria produzir nada além de um 409 limpo.
    const mutationIdB = mid();
    const historyBeforeB = historyCount(qId);
    const auditBeforeB = auditLogCount(qId);
    const markerBeforeB = mutationChecksCount();
    const receiptBeforeB = receiptsCount();

    // Nível de serviço: deve ser {ok:false, conflict:true} — nunca lançar.
    let serviceThrew = false;
    let serviceThrownMessage = "";
    let resultB: Awaited<ReturnType<typeof updateQuestion>> | null = null;
    try {
      resultB = await updateQuestion(db as never, "autorB1", qId, 1, mutationIdB, { tags: ["tag-de-B"] } as never);
    } catch (error) {
      serviceThrew = true;
      serviceThrownMessage = error instanceof Error ? error.message : String(error);
    }

    // Nível de rota (HTTP): deve ser um Response 409 — nunca uma promise
    // rejeitada / exceção crua propagando até o chamador da rota.
    let routeThrew = false;
    let routeThrownMessage = "";
    let routeStatus: number | null = null;
    try {
      const response = await callRoute(`/api/editorial/questions/${qId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, mutationId: crypto.randomUUID(), tags: ["tag-de-B-via-rota"] }),
      });
      routeStatus = response.status;
    } catch (error) {
      routeThrew = true;
      routeThrownMessage = error instanceof Error ? error.message : String(error);
    }

    console.log("[v1.6 repro] serviceThrew=%s message=%s | routeThrew=%s routeStatus=%s message=%s", serviceThrew, serviceThrownMessage, routeThrew, routeStatus, routeThrownMessage);

    expect(serviceThrew).toBe(false);
    expect(resultB).not.toBeNull();
    expect(resultB!.ok).toBe(false);
    expect(resultB!.conflict).toBe(true);

    expect(routeThrew).toBe(false);
    expect(routeStatus).toBe(409);

    // Estado do banco: intocado por B — A permanece a única fonte de verdade.
    const after = coreSnapshot(qId);
    expect(after.version).toBe(2);
    expect(tagContents(qId)).toEqual(["tag-de-A"]);
    expect(historyCount(qId)).toBe(historyBeforeB);
    expect(auditLogCount(qId)).toBe(auditBeforeB);
    expect(mutationChecksCount()).toBe(markerBeforeB);
    expect(receiptsCount()).toBe(receiptBeforeB);
  });

  // B — RISCO RESIDUAL FECHADO: A avança v1->v2 SEM tocar imagens; B
  // (identidade diferente, expectedVersion=1 obsoleta) tenta tocar imagens
  // — a coleção que A NUNCA tocou. Antes da consolidação (trigger de
  // contagem de 0010, por versão), isto poderia abortar por engano (ou
  // passar por coincidência) dependendo da contagem declarada. Agora,
  // atrelado a identidade, deve SEMPRE ser um 409 limpo.
  it("B. mutação A avança sem tocar imagens; mutação B (identidade diferente, versão obsoleta) tenta tocar imagens (coleção que A nunca tocou) → 409 limpo, imagens exatamente como estavam antes de B", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const imagesBefore = db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(qId) as { total: number };

    const mutationIdA = mid();
    const resultA = await updateQuestion(db as never, "autor1", qId, 1, mutationIdA, { tags: ["tag-de-A"] } as never);
    expect(resultA.ok).toBe(true);
    const afterA = coreSnapshot(qId);
    expect(afterA.version).toBe(2);

    const markerBeforeB = mutationChecksCount();
    const receiptBeforeB = receiptsCount();
    const historyBeforeB = historyCount(qId);

    const resultB = await updateQuestion(db as never, "autor1", qId, 1, mid(), {
      imagens: [{ assetRef: "assets/questoes/img-de-b.png", altText: "Imagem de B", caption: null, position: 0, titularDireitos: null, baseLicenca: null }],
    } as never);
    expect(resultB.ok).toBe(false);
    expect(resultB.conflict).toBe(true);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(2); // ainda o de A
    const imagesAfter = db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(qId) as { total: number };
    expect(imagesAfter.total).toBe(imagesBefore.total); // nunca tocadas por B
    expect(historyCount(qId)).toBe(historyBeforeB);
    expect(mutationChecksCount()).toBe(markerBeforeB);
    expect(receiptsCount()).toBe(receiptBeforeB);
  });

  // C — mesmo cenário de B, mas B tenta ESVAZIAR (expected_count=0) uma
  // coleção que A nunca tocou — o caso N=0 tem sua própria história
  // (0011/v1.5), então testado separadamente.
  it("C. mutação A avança sem tocar tags; mutação B (identidade diferente, versão obsoleta) tenta ESVAZIAR tags (coleção que A nunca tocou, terminando vazia) → 409 limpo, zero resíduo técnico", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    db.sqlite
      .prepare("INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES (?, ?, ?, ?, ?)")
      .run("t-preexistente", qId, "tag-preexistente", 0, 1);

    const mutationIdA = mid();
    // A só toca DNA/patterns — nunca tags.
    const resultA = await updateQuestion(db as never, "autor1", qId, 1, mutationIdA, { conteudo: "Conteúdo de A." } as never);
    expect(resultA.ok).toBe(true);
    const afterA = coreSnapshot(qId);
    expect(afterA.version).toBe(2);

    const markerBeforeB = mutationChecksCount();
    const receiptBeforeB = receiptsCount();

    const resultB = await updateQuestion(db as never, "autor1", qId, 1, mid(), { tags: [] } as never);
    expect(resultB.ok).toBe(false);
    expect(resultB.conflict).toBe(true);

    expect(coreSnapshot(qId).version).toBe(2);
    expect(tagContents(qId)).toEqual(["tag-preexistente"]); // intocada por B
    expect(mutationChecksCount()).toBe(markerBeforeB);
    expect(receiptsCount()).toBe(receiptBeforeB);
  });

  // D — anomalia Classe-1 (v1.4), re-verificada sob o mecanismo de
  // identidade consolidado: núcleo e recibo usam a IDENTIDADE certa, mas a
  // inserção de itens da coleção está incompleta (uma linha a menos do que
  // o esperado) — rollback completo.
  it("D. núcleo e recibo com a identidade correta, mas a coleção tem uma linha A MENOS do que o esperado (INSERT incompleto) → rollback completo, provado no banco", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    const thisMutationId = crypto.randomUUID();
    const historyStatement = buildConditionalHistoryStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      userId: "autor1",
      action: "updated",
      fromStatus: "draft",
      toStatus: "draft",
      guardVersion: 1,
      versionAfter: 2,
      guardStatuses: ["draft", "changes_requested"],
      metadata: null,
    });
    const coreUpdate = buildUpdateQuestionCoreStatement(db as never, qId, 1, thisMutationId, {
      enunciado: "Enunciado inalterado.",
      resolucaoComentada: "",
      conteudo: "",
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade: "media",
      origem: "autoral",
      prova: null,
      ano: null,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: 0,
      titularDireitos: null,
      baseLicenca: null,
      textoAtribuicao: null,
      fingerprint: "fp-d-nao-deveria-persistir",
    });
    // Recibo com a identidade CERTA (prova que o "guard" desta mutação
    // rodou) — mas só 1 tag é de fato inserida, quando o marcador vai
    // declarar 2 esperadas (INSERT incompleto, ex. um bug num loop que
    // parou cedo).
    const receipt = buildCollectionMutationReceiptStatement(db as never, {
      id: `${thisMutationId}:question_tags`,
      questionId: qId,
      collection: "question_tags",
      guardVersion: 1,
      expectedVersion: 2,
    });
    const incompleteTagInsert = db
      .prepare("INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES (?, ?, ?, ?, ?)")
      .bind("t-so-uma", qId, "tag-unica", 0, 2);
    const mutationCheck = buildMutationCheckStatement(db as never, {
      id: thisMutationId,
      questionId: qId,
      expectedVersion: 2,
      alternativesExpectedCount: null,
      dnaExpectedCount: null,
      patternsExpectedCount: null,
      tagsExpectedCount: 2, // declara 2, mas só 1 foi de fato inserida
      imagesExpectedCount: null,
    });

    await expect(
      db.batch([historyStatement, coreUpdate, receipt, incompleteTagInsert as never, mutationCheck])
    ).rejects.toThrow(/invariante violada/i);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version); // rollback completo
    expect(after.updated_at).toBe(before.updated_at);
    expect(historyCount(qId)).toBe(historyBefore);
    const tags = db.sqlite.prepare("SELECT COUNT(*) as total FROM question_tags WHERE question_id = ?").get(qId) as { total: number };
    expect(tags.total).toBe(0); // até a tag única que "conseguiu" foi revertida
    expect(mutationChecksCount()).toBe(0);
    expect(receiptsCount()).toBe(0);
  });

  // E — o histórico é gravado com uma identidade (X), mas o núcleo é
  // atualizado (com sucesso genuíno, guard correto) usando uma identidade
  // DIFERENTE (Y) como `mutationId` — simula um bug de código que desalinha
  // qual identidade é passada para cada statement dentro da MESMA
  // transação. O marcador usa a identidade do histórico (X). Mesmo com o
  // núcleo tendo avançado de verdade, `last_mutation_id` ficou gravado como
  // Y, não X — divergência real, deve abortar.
  it("E. histórico gravado com identidade X, núcleo avançado com sucesso mas carimbado com identidade Y (DIFERENTE) → rollback completo, provado no banco", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    const identityX = crypto.randomUUID();
    const identityY = crypto.randomUUID();
    const historyStatement = buildConditionalHistoryStatement(db as never, {
      id: identityX,
      questionId: qId,
      userId: "autor1",
      action: "updated",
      fromStatus: "draft",
      toStatus: "draft",
      guardVersion: 1,
      versionAfter: 2,
      guardStatuses: ["draft", "changes_requested"],
      metadata: null,
    });
    // UPDATE central usa o guard CORRETO (versão 1, bate de verdade) mas é
    // carimbado com a identidade Y — DIFERENTE da identidade X do
    // histórico. O UPDATE tem sucesso genuíno (afeta 1 linha).
    const coreUpdate = buildUpdateQuestionCoreStatement(db as never, qId, 1, identityY, {
      enunciado: "Enunciado inalterado.",
      resolucaoComentada: "",
      conteudo: "",
      subconteudo: "",
      habilidade: "",
      competencia: "",
      dificuldade: "media",
      origem: "autoral",
      prova: null,
      ano: null,
      tempoEstimadoSegundos: null,
      tipoCalculo: "misto",
      necessitaCalculadora: 0,
      titularDireitos: null,
      baseLicenca: null,
      textoAtribuicao: null,
      fingerprint: "fp-e-nao-deveria-persistir",
    });
    // Marcador usa a identidade do HISTÓRICO (X) — a convenção real do
    // serviço (marker.id = mutationId = mesma identidade do histórico).
    const mutationCheck = buildMutationCheckStatement(db as never, {
      id: identityX,
      questionId: qId,
      expectedVersion: 2,
      alternativesExpectedCount: null,
      dnaExpectedCount: null,
      patternsExpectedCount: null,
      tagsExpectedCount: null,
      imagesExpectedCount: null,
    });

    await expect(db.batch([historyStatement, coreUpdate, mutationCheck])).rejects.toThrow(/invariante violada/i);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version); // núcleo revertido, mesmo tendo "conseguido"
    expect(after.updated_at).toBe(before.updated_at);
    expect(historyCount(qId)).toBe(historyBefore); // histórico revertido também
    expect(mutationChecksCount()).toBe(0);
  });

  // F — workflow editorial normal (draft -> in_review) via applyTransition,
  // não updateQuestion: confirma que o mecanismo de identidade consolidado
  // também funciona para transições (que usam um id de histórico gerado
  // internamente como identidade, nunca um mutationId de cliente).
  it("F. transição normal draft->in_review via applyTransition → sucesso, núcleo/histórico com identidade coerente, zero resíduo técnico", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, withDna: true, withAlternatives: true, withPrincipalPattern: true });
    // Imagens exigem alt-text para submeter à revisão — a fixture padrão
    // não cria nenhuma, então nenhuma pendência de alt-text existe.
    const before = coreSnapshot(qId);
    const historyBefore = historyCount(qId);

    const result = await submitForReview(db as never, "autor1", "editor", qId, 1);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const after = coreSnapshot(qId);
    expect(after.version).toBe(before.version + 1);
    const row = db.sqlite.prepare("SELECT editorial_status, last_mutation_id FROM questions WHERE id = ?").get(qId) as {
      editorial_status: string;
      last_mutation_id: string | null;
    };
    expect(row.editorial_status).toBe("in_review");
    expect(row.last_mutation_id).not.toBeNull();
    // O histórico gravado tem exatamente o id que ficou carimbado em last_mutation_id.
    const history = db.sqlite.prepare("SELECT id FROM question_history WHERE question_id = ? ORDER BY created_at DESC LIMIT 1").get(qId) as {
      id: string;
    };
    expect(history.id).toBe(row.last_mutation_id);
    expect(historyCount(qId)).toBe(historyBefore + 1);
    expect(mutationChecksCount()).toBe(0); // zero resíduo técnico
    expect(receiptsCount()).toBe(0); // transições nunca tocam coleções
  });
});
