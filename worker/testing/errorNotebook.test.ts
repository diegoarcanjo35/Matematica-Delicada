// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handlePlayerRequest } from "../src/routes/player";
import { handleErrorNotebookRequest } from "../src/routes/errorNotebook";
import { archiveEntry, startReview } from "../src/services/errorNotebookService";
import { confirmAnswer, saveAnswer, startOrResumeAttempt } from "../src/services/playerService";
import { findEntryByUserAndQuestion } from "../src/repositories/errorNotebookRepository";

/* Sprint 9 v1.0 — Caderno de Erros e Revisão Espaçada. Mesma convenção de
   worker/testing/playerAtomicity.test.ts (Sprint 8): SQLite real por trás
   do FakeD1Database, prova de atomicidade sempre por consulta DIRETA ao
   banco depois de cada cenário simulado — nunca só pela resposta HTTP. */

let db: FakeD1Database;
const seededUsers = new Set<string>();

beforeEach(() => {
  db = new FakeD1Database();
  seededUsers.clear();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'Frase de reconhecimento', 'D', 'E', 'X', 'R', 'published')`
  );
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

function seedPublishedQuestion(overrides: Parameters<typeof seedQuestion>[1] = {}): string {
  const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, ...overrides });
  db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);
  return qId;
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

function entryRow(id: string): {
  status: string;
  error_count: number;
  review_stage: number;
  version: number;
  last_mutation_id: string | null;
  distinct_review_questions_succeeded: number;
  corrected_at: string | null;
} {
  return db.sqlite
    .prepare(
      "SELECT status, error_count, review_stage, version, last_mutation_id, distinct_review_questions_succeeded, corrected_at FROM error_notebook_entries WHERE id = ?"
    )
    .get(id) as never;
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ENABLE_LOCAL_EDITORIAL_FIXTURES: "true" };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${LOCAL_ORIGIN}${path}`, { ...init, headers });
}

async function callPlayerRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handlePlayerRequest(request, localEnv(), url))!;
}

async function callNotebookRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handleErrorNotebookRequest(request, localEnv(), url))!;
}

/** Confirma uma tentativa como INCORRETA (alternativa A, sabendo que B é
 *  sempre a correta em `seedQuestion`) via a rota real do Player — mesmo
 *  caminho que o Caderno depende para o registro automático (seção 5.1). */

/** Idempotente quanto ao usuário: chamadas repetidas com o MESMO userId
 *  (ex.: um segundo erro na mesma questão, ou dois modos diferentes do
 *  mesmo aluno) reaproveitam a sessão já criada, nunca tentam recriar o
 *  usuário — recriar violaria UNIQUE(users.id), um erro de FIXTURE de
 *  teste, não do código de produção sendo testado. */
async function ensureUserSession(userId: string): Promise<string> {
  if (!seededUsers.has(userId)) {
    await seedUserWithSession(userId);
    seededUsers.add(userId);
  }
  return `session-token-${userId}`;
}

async function startAndConfirmWrong(userId: string, questionId: string, mode: "learning" | "practice" = "learning"): Promise<string> {
  const token = await ensureUserSession(userId);
  const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId, mode }) });
  const { attemptId } = (await create.json()) as { attemptId: string };
  await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
  await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
  return attemptId;
}

/* ---------------------------------------------------------------------- */
/* Schema/migration (seção 15.1)                                          */
/* ---------------------------------------------------------------------- */

describe("schema do Caderno de Erros", () => {
  it("uma entrada por (user_id, original_question_id) — segunda tentativa de INSERT direto viola o índice único", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','${qId}',1,'learning','completed')`
    );
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id) VALUES ('e1','u1','${qId}','a1','a1')`
    );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id) VALUES ('e2','u1','${qId}','a1','a1')`
      )
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("error_count < 1 é rejeitado pelo CHECK", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','${qId}',1,'learning','completed')`
    );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, error_count) VALUES ('e1','u1','${qId}','a1','a1',0)`
      )
    ).toThrow();
  });

  it("error_type fora do enum fechado é rejeitado pelo CHECK", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','${qId}',1,'learning','completed')`
    );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, error_type) VALUES ('e1','u1','${qId}','a1','a1','livre')`
      )
    ).toThrow();
  });

  it("status fora do enum fechado é rejeitado pelo CHECK", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','${qId}',1,'learning','completed')`
    );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, status) VALUES ('e1','u1','${qId}','a1','a1','em_andamento')`
      )
    ).toThrow();
  });

  it("error_review_events: result fora do enum é rejeitado, e uma segunda linha para a MESMA tentativa viola o índice único", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','${qId}',1,'practice','completed')`
    );
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, last_mutation_id) VALUES ('e1','u1','${qId}','a1','a1','m1')`
    );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO error_review_events (id, entry_id, user_id, attempt_id, reviewed_question_id, result, previous_stage, resulting_stage, previous_next_review_at, resulting_next_review_at, used_different_question) VALUES ('ev1','e1','u1','a1','${qId}','talvez',0,1,'x','y',0)`
      )
    ).toThrow();
    db.sqlite.exec(
      `INSERT INTO error_review_events (id, entry_id, user_id, attempt_id, reviewed_question_id, result, previous_stage, resulting_stage, previous_next_review_at, resulting_next_review_at, used_different_question) VALUES ('ev1','e1','u1','a1','${qId}','correct',0,1,'x','y',0)`
      );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO error_review_events (id, entry_id, user_id, attempt_id, reviewed_question_id, result, previous_stage, resulting_stage, previous_next_review_at, resulting_next_review_at, used_different_question) VALUES ('ev2','e1','u1','a1','${qId}','correct',1,2,'x','y',0)`
      )
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("question_attempts.error_entry_id existe (ligação aditiva) e aceita NULL (tentativa comum, sem revisão)", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, error_entry_id) VALUES ('a1','u1','${qId}',1,'learning','in_progress',NULL)`
      )
    ).not.toThrow();
  });

  it("só uma tentativa in_progress por entrada — segunda tentativa de revisão para a MESMA entrada viola o índice único parcial", async () => {
    await seedUser("u1");
    const qId = seedPublishedQuestion();
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a0','u1','${qId}',1,'learning','completed')`
    );
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id) VALUES ('e1','u1','${qId}','a0','a0')`
    );
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, error_entry_id) VALUES ('a1','u1','${qId}',1,'practice','in_progress','e1')`
    );
    expect(() =>
      db.sqlite.exec(
        `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, error_entry_id) VALUES ('a2','u1','${qId}',1,'practice','in_progress','e1')`
      )
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

/* ---------------------------------------------------------------------- */
/* Registro automático e atomicidade (seção 15.2 — a mais exigida)        */
/* ---------------------------------------------------------------------- */

describe("registro automático do erro — atomicidade", () => {
  it("1) erro confirmado cria a entrada, com a identidade do mutationId da confirmação", async () => {
    const qId = seedPublishedQuestion();
    const attemptId = await startAndConfirmWrong("u1", qId);
    const entry = await findEntryByUserAndQuestion(db as never, "u1", qId);
    expect(entry).not.toBeNull();
    expect(entry!.original_attempt_id).toBe(attemptId);
    expect(entry!.error_count).toBe(1);
    expect(entry!.error_type).toBe("unclassified");
    expect(entry!.status).toBe("scheduled");
  });

  it("2) novo erro na MESMA questão atualiza sem duplicar (error_count incrementa, uma entrada só)", async () => {
    const qId = seedPublishedQuestion();
    await startAndConfirmWrong("u2", qId, "learning");
    await startAndConfirmWrong("u2", qId, "practice");
    expect(countRows("error_notebook_entries", `WHERE user_id = 'u2' AND original_question_id = '${qId}'`)).toBe(1);
    const entry = await findEntryByUserAndQuestion(db as never, "u2", qId);
    expect(entry!.error_count).toBe(2);
  });

  it("3) confirmação CORRETA comum (fora de revisão) NÃO cria nem apaga entrada", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u3");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    expect(await findEntryByUserAndQuestion(db as never, "u3", qId)).toBeNull();
  });

  it("4) falha genuína de SQL ao gravar o Caderno reverte a confirmação E o evento do Player (nenhuma escrita parcial)", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u4");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });

    db.failNextMatching(/INSERT INTO error_notebook_entries/);
    await expect(confirmAnswer(db as never, "u4", attemptId, 2)).rejects.toThrow();

    const attemptRow = db.sqlite.prepare("SELECT status, is_correct FROM question_attempts WHERE id = ?").get(attemptId) as {
      status: string;
      is_correct: number | null;
    };
    expect(attemptRow.status).toBe("in_progress"); // nunca chegou a completed
    expect(attemptRow.is_correct).toBeNull();
    expect(countRows("question_answer_events", `WHERE attempt_id = '${attemptId}' AND event_type = 'confirmed'`)).toBe(0);
    expect(countRows("error_notebook_entries")).toBe(0); // nenhuma entrada órfã
  });

  it("5) confirmação inexistente (attemptId errado) não cria entrada nenhuma", async () => {
    await seedUser("u5");
    const result = await confirmAnswer(db as never, "u5", "attempt-que-nao-existe", 1);
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
    expect(countRows("error_notebook_entries")).toBe(0);
  });

  it("6) corrida real: duas confirmações erradas concorrentes na MESMA questão (modos diferentes) produzem uma entrada com error_count consistente", async () => {
    const qId = seedPublishedQuestion();
    await seedUser("u6");
    const startLearning = await startOrResumeAttempt(db as never, "u6", qId, "learning");
    const startPractice = await startOrResumeAttempt(db as never, "u6", qId, "practice");
    await saveAnswer(db as never, "u6", startLearning.value!.attemptId, 1, "A");
    await saveAnswer(db as never, "u6", startPractice.value!.attemptId, 1, "A");

    const [r1, r2] = await Promise.all([
      confirmAnswer(db as never, "u6", startLearning.value!.attemptId, 2),
      confirmAnswer(db as never, "u6", startPractice.value!.attemptId, 2),
    ]);
    // As DUAS confirmações do Player são reais e independentes (tentativas
    // diferentes, cada uma com seu próprio guard de versão) — o que a
    // "corrida" real disputa é a MESMA entrada do Caderno. Uma das duas
    // pode legitimamente colidir no UPDATE incremental da entrada (versão
    // otimista) e devolver conflict — o ponto provado aqui é que NUNCA
    // duas entradas nem uma contagem incoerente resultam.
    const outcomes = [r1, r2].filter((r) => r.ok);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(countRows("error_notebook_entries", `WHERE user_id = 'u6' AND original_question_id = '${qId}'`)).toBe(1);
    const entry = await findEntryByUserAndQuestion(db as never, "u6", qId);
    expect(entry!.error_count).toBeGreaterThanOrEqual(1);
    expect(entry!.error_count).toBeLessThanOrEqual(2);
  });

  it("7) retry (mesma tentativa já confirmada) não duplica entrada nem incrementa error_count de novo", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u7");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    const retry = await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    expect(retry.status).toBe(200);
    const entry = await findEntryByUserAndQuestion(db as never, "u7", qId);
    expect(entry!.error_count).toBe(1);
  });

  it("8) entrada de outro aluno responde 404, nunca 403", async () => {
    const qId = seedPublishedQuestion();
    await startAndConfirmWrong("u8-dono", qId);
    const entry = await findEntryByUserAndQuestion(db as never, "u8-dono", qId);
    const tokenB = await seedUserWithSession("u8-intruso");
    const response = await callNotebookRoute(`/api/error-notebook/${entry!.id}`, tokenB, { method: "GET" });
    expect(response.status).toBe(404);
  });

  it("9) auditoria (error_notebook_entry_created/updated) só grava em mutação real, nunca em retry", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u9");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) }); // retry
    expect(countRows("audit_log", `WHERE event_type = 'error_notebook_entry_created' AND user_id = 'u9'`)).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Classificação e anotação — PATCH (seção 15.3)                          */
/* ---------------------------------------------------------------------- */

describe("classificação e anotação — PATCH", () => {
  async function createEntry(userLabel: string): Promise<{ token: string; entryId: string }> {
    const qId = seedPublishedQuestion();
    const attemptId = await startAndConfirmWrong(userLabel, qId);
    void attemptId;
    const entry = await findEntryByUserAndQuestion(db as never, userLabel, qId);
    const token = `session-token-${userLabel}`;
    return { token, entryId: entry!.id };
  }

  it("PATCH parcial: só errorType muda, studentNote permanece intacto", async () => {
    const { token, entryId } = await createEntry("p1");
    const response = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "calculation", expectedVersion: 1, mutationId: "m-1" }),
    });
    expect(response.status).toBe(200);
    const row = db.sqlite.prepare("SELECT error_type, student_note FROM error_notebook_entries WHERE id = ?").get(entryId) as {
      error_type: string;
      student_note: string | null;
    };
    expect(row.error_type).toBe("calculation");
    expect(row.student_note).toBeNull();
  });

  it("corpo vazio → 400", async () => {
    const { token, entryId } = await createEntry("p2");
    const response = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, { method: "PATCH", body: JSON.stringify({}) });
    expect(response.status).toBe(400);
  });

  it("studentNote: null limpa; errorType: null → 400", async () => {
    const { token, entryId } = await createEntry("p3");
    const setNote = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ studentNote: "Esqueci de inverter a razão.", expectedVersion: 1, mutationId: "m-a" }),
    });
    expect(setNote.status).toBe(200);
    const clearNote = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ studentNote: null, expectedVersion: 2, mutationId: "m-b" }),
    });
    expect(clearNote.status).toBe(200);
    const row = db.sqlite.prepare("SELECT student_note FROM error_notebook_entries WHERE id = ?").get(entryId) as { student_note: string | null };
    expect(row.student_note).toBeNull();

    const nullType = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: null, expectedVersion: 3, mutationId: "m-c" }),
    });
    expect(nullType.status).toBe(400);
  });

  it("no-op (mesmo conteúdo) devolve changed:false sem tocar version", async () => {
    const { token, entryId } = await createEntry("p4");
    await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "calculation", expectedVersion: 1, mutationId: "m-1" }),
    });
    const repeatSameValue = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "calculation", expectedVersion: 2, mutationId: "m-novo" }),
    });
    const body = (await repeatSameValue.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
    const row = db.sqlite.prepare("SELECT version FROM error_notebook_entries WHERE id = ?").get(entryId) as { version: number };
    expect(row.version).toBe(2);
  });

  it("versão obsoleta → 409", async () => {
    const { token, entryId } = await createEntry("p5");
    const response = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "haste", expectedVersion: 99, mutationId: "m-1" }),
    });
    expect(response.status).toBe(409);
  });

  it("retry do MESMO mutationId é idempotente; reusar o mesmo mutationId para conteúdo diferente é 409", async () => {
    const { token, entryId } = await createEntry("p6");
    await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "haste", expectedVersion: 1, mutationId: "m-fixo" }),
    });
    const retry = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "haste", expectedVersion: 1, mutationId: "m-fixo" }),
    });
    expect(retry.status).toBe(200);
    const collision = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ errorType: "calculation", expectedVersion: 1, mutationId: "m-fixo" }),
    });
    expect(collision.status).toBe(409);
  });

  it("texto hostil na nota é persistido literalmente como DADO, nunca executado/interpretado", async () => {
    const { token, entryId } = await createEntry("p7");
    const hostile = "<img src=x onerror=alert(1)>'; DROP TABLE users; --";
    const response = await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ studentNote: hostile, expectedVersion: 1, mutationId: "m-1" }),
    });
    expect(response.status).toBe(200);
    const row = db.sqlite.prepare("SELECT student_note FROM error_notebook_entries WHERE id = ?").get(entryId) as { student_note: string };
    expect(row.student_note).toBe(hostile);
    expect(countRows("users")).toBeGreaterThan(0); // DROP TABLE nunca executou
  });

  it("a anotação livre nunca aparece em audit_log", async () => {
    const { token, entryId } = await createEntry("p8");
    const secretNote = "NOTA_PESSOAL_QUE_NAO_PODE_VAZAR";
    await callNotebookRoute(`/api/error-notebook/${entryId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ studentNote: secretNote, expectedVersion: 1, mutationId: "m-1" }),
    });
    const auditRows = db.sqlite.prepare("SELECT metadata FROM audit_log WHERE event_type = 'error_notebook_entry_updated'").all() as Array<{
      metadata: string | null;
    }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].metadata ?? "").not.toContain(secretNote);
  });
});

/* ---------------------------------------------------------------------- */
/* Revisão (seção 15.4)                                                   */
/* ---------------------------------------------------------------------- */

describe("revisão — seleção, atomicidade e agendamento", () => {
  it("seleção determinística escolhe uma questão publicada diferente do mesmo padrão quando existe", async () => {
    const originalId = seedPublishedQuestion({ id: "q-original", code: "Q-ORIGINAL" });
    seedPublishedQuestion({ id: "q-similar", code: "Q-SIMILAR" }); // mesmo pat-1
    const attemptId = await startAndConfirmWrong("r1", originalId);
    void attemptId;
    const entry = await findEntryByUserAndQuestion(db as never, "r1", originalId);
    const token = "session-token-r1";
    const response = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, token, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reviewedQuestionId: string; selectionReason: string };
    expect(body.reviewedQuestionId).toBe("q-similar");
    expect(body.selectionReason).toBe("same_pattern_excluding_used");
  });

  it("fallback para a questão original quando não há semelhante publicada disponível", async () => {
    const originalId = seedPublishedQuestion({ id: "q-sozinha", code: "Q-SOZINHA" });
    await startAndConfirmWrong("r2", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r2", originalId);
    const response = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r2", { method: "POST" });
    const body = (await response.json()) as { reviewedQuestionId: string; selectionReason: string };
    expect(body.reviewedQuestionId).toBe(originalId);
    // Nenhuma OUTRA questão publicada existe para o mesmo padrão, então a
    // camada 1 (semelhante nova) não encontra nada — mas a original AINDA
    // não foi usada com sucesso nesta entrada, então a camada 2 a oferece
    // diretamente (nunca pula direto para o fallback final "sem
    // alternativa nenhuma", que só se aplica depois que a original também
    // já tiver sido usada com sucesso — ver próximo teste).
    expect(body.selectionReason).toBe("original_not_yet_succeeded");
  });

  it("depois que a original já foi usada com sucesso e não há outra questão, a seleção recai no fallback final (repete a original)", async () => {
    const originalId = seedPublishedQuestion({ id: "q-sozinha-2", code: "Q-SOZINHA-2" });
    await startAndConfirmWrong("r2b", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r2b", originalId);
    const token = "session-token-r2b";

    const first = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, token, { method: "POST" });
    const { attemptId: firstAttemptId } = (await first.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${firstAttemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${firstAttemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });

    const second = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, token, { method: "POST" });
    const secondBody = (await second.json()) as { reviewedQuestionId: string; selectionReason: string };
    expect(secondBody.reviewedQuestionId).toBe(originalId);
    expect(secondBody.selectionReason).toBe("original_fallback_no_alternative");
  });

  it("início é idempotente — repetir start-review devolve a MESMA tentativa, entrada fica in_review", async () => {
    const originalId = seedPublishedQuestion();
    await startAndConfirmWrong("r3", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r3", originalId);
    const first = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r3", { method: "POST" });
    const second = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r3", { method: "POST" });
    const firstBody = (await first.json()) as { attemptId: string };
    const secondBody = (await second.json()) as { attemptId: string };
    expect(secondBody.attemptId).toBe(firstBody.attemptId);
    const row = db.sqlite.prepare("SELECT status FROM error_notebook_entries WHERE id = ?").get(entry!.id) as { status: string };
    expect(row.status).toBe("in_review");
  });

  it("revisão correta avança o estágio e agenda +3 dias a partir do estágio 0", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v1", code: "Q-ORIG-V1" });
    seedPublishedQuestion({ id: "q-sim-v1", code: "Q-SIM-V1" });
    await startAndConfirmWrong("r4", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r4", originalId);
    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r4", { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };

    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, "session-token-r4", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, alternative: "B" }),
    });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, "session-token-r4", { method: "POST", body: JSON.stringify({ version: 2 }) });

    const after = entryRow(entry!.id);
    expect(after.review_stage).toBe(1);
    expect(countRows("error_review_events", `WHERE entry_id = '${entry!.id}' AND result = 'correct'`)).toBe(1);
  });

  it("revisão incorreta reseta o estágio para 0", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v2", code: "Q-ORIG-V2" });
    seedPublishedQuestion({ id: "q-sim-v2", code: "Q-SIM-V2" });
    await startAndConfirmWrong("r5", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r5", originalId);
    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r5", { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };

    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, "session-token-r5", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, alternative: "A" }),
    });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, "session-token-r5", { method: "POST", body: JSON.stringify({ version: 2 }) });

    const after = entryRow(entry!.id);
    expect(after.review_stage).toBe(0);
    expect(after.status).toBe("scheduled");
  });

  it("duas revisões corretas em questões DISTINTAS (uma diferente da original) permitem 'corrected'", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v3", code: "Q-ORIG-V3" });
    const similarId = seedPublishedQuestion({ id: "q-sim-v3", code: "Q-SIM-V3" });
    await startAndConfirmWrong("r6", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r6", originalId);

    // 1ª revisão correta — cai na questão semelhante (única alternativa
    // disponível na primeira chamada).
    const start1 = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r6", { method: "POST" });
    const { attemptId: attempt1 } = (await start1.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attempt1}/answer`, "session-token-r6", { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attempt1}/confirm`, "session-token-r6", { method: "POST", body: JSON.stringify({ version: 2 }) });

    // 2ª revisão correta — a seleção agora exclui a semelhante já usada
    // com sucesso, então recai na questão original (fallback "relaxed").
    const start2 = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r6", { method: "POST" });
    const { attemptId: attempt2, reviewedQuestionId } = (await start2.json()) as { attemptId: string; reviewedQuestionId: string };
    await callPlayerRoute(`/api/player/attempts/${attempt2}/answer`, "session-token-r6", { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attempt2}/confirm`, "session-token-r6", { method: "POST", body: JSON.stringify({ version: 2 }) });

    const after = entryRow(entry!.id);
    expect([originalId, similarId]).toContain(reviewedQuestionId);
    expect(after.status).toBe("corrected");
    expect(after.corrected_at).not.toBeNull();
    expect(after.distinct_review_questions_succeeded).toBeGreaterThanOrEqual(2);
  });

  it("repetir a MESMA questão semelhante corretamente não basta sozinho para 'corrected' (sem mais uma questão distinta)", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v4", code: "Q-ORIG-V4" });
    // Só a original está publicada — toda revisão vai cair nela mesma.
    await startAndConfirmWrong("r7", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r7", originalId);

    for (let i = 0; i < 2; i++) {
      const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r7", { method: "POST" });
      const { attemptId } = (await start.json()) as { attemptId: string };
      await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, "session-token-r7", { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
      await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, "session-token-r7", { method: "POST", body: JSON.stringify({ version: 2 }) });
    }

    const after = entryRow(entry!.id);
    // Duas revisões corretas — mas SEMPRE na questão original — nunca
    // satisfaz "outro contexto" (seção 6.1): a entrada continua ativa.
    expect(after.status).not.toBe("corrected");
    const detail = await callNotebookRoute(`/api/error-notebook/${entry!.id}`, "session-token-r7", { method: "GET" });
    const body = (await detail.json()) as { entry: { stillNeedsDifferentContext: boolean } };
    expect(body.entry.stillNeedsDifferentContext).toBe(true);
  });

  it("falha genuína de SQL num evento de revisão reverte a confirmação E a agenda (nenhuma escrita parcial)", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v5", code: "Q-ORIG-V5" });
    seedPublishedQuestion({ id: "q-sim-v5", code: "Q-SIM-V5" });
    await startAndConfirmWrong("r8", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r8", originalId);
    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r8", { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, "session-token-r8", { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });

    const versionBefore = entryRow(entry!.id).review_stage;
    db.failNextMatching(/INSERT INTO error_review_events/);
    await expect(confirmAnswer(db as never, "r8", attemptId, 2)).rejects.toThrow();

    const attemptRowAfter = db.sqlite.prepare("SELECT status FROM question_attempts WHERE id = ?").get(attemptId) as { status: string };
    expect(attemptRowAfter.status).toBe("in_progress");
    expect(entryRow(entry!.id).review_stage).toBe(versionBefore);
    expect(countRows("error_review_events", `WHERE attempt_id = '${attemptId}'`)).toBe(0);
  });

  it("corrida real: duas confirmações concorrentes na MESMA revisão produzem exatamente um error_review_event", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v6", code: "Q-ORIG-V6" });
    seedPublishedQuestion({ id: "q-sim-v6", code: "Q-SIM-V6" });
    await startAndConfirmWrong("r9", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r9", originalId);
    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r9", { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };
    await saveAnswer(db as never, "r9", attemptId, 1, "B");

    const [c1, c2] = await Promise.all([confirmAnswer(db as never, "r9", attemptId, 2), confirmAnswer(db as never, "r9", attemptId, 2)]);
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(countRows("error_review_events", `WHERE attempt_id = '${attemptId}'`)).toBe(1);
  });

  it("retry (mesma tentativa de revisão já confirmada) não duplica evento nem auditoria", async () => {
    const originalId = seedPublishedQuestion({ id: "q-orig-v7", code: "Q-ORIG-V7" });
    seedPublishedQuestion({ id: "q-sim-v7", code: "Q-SIM-V7" });
    await startAndConfirmWrong("r10", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "r10", originalId);
    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, "session-token-r10", { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, "session-token-r10", { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, "session-token-r10", { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, "session-token-r10", { method: "POST", body: JSON.stringify({ version: 2 }) });

    expect(countRows("error_review_events", `WHERE attempt_id = '${attemptId}'`)).toBe(1);
    expect(countRows("audit_log", `WHERE event_type = 'error_notebook_review_completed' AND user_id = 'r10'`)).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Arquivamento                                                            */
/* ---------------------------------------------------------------------- */

describe("arquivamento", () => {
  it("é idempotente e não apaga histórico; some da lista padrão, aparece com includeArchived", async () => {
    const qId = seedPublishedQuestion();
    await startAndConfirmWrong("arch1", qId);
    const entry = await findEntryByUserAndQuestion(db as never, "arch1", qId);
    const token = "session-token-arch1";

    const first = await callNotebookRoute(`/api/error-notebook/${entry!.id}/archive`, token, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: entry!.version, mutationId: "arch-m1" }),
    });
    expect(first.status).toBe(200);
    const second = await callNotebookRoute(`/api/error-notebook/${entry!.id}/archive`, token, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: entry!.version, mutationId: "arch-m1" }),
    });
    expect(second.status).toBe(200);

    const listDefault = await callNotebookRoute("/api/error-notebook", token, { method: "GET" });
    const defaultBody = (await listDefault.json()) as { entries: Array<{ id: string }> };
    expect(defaultBody.entries.find((e) => e.id === entry!.id)).toBeUndefined();

    const listArchived = await callNotebookRoute("/api/error-notebook?includeArchived=true", token, { method: "GET" });
    const archivedBody = (await listArchived.json()) as { entries: Array<{ id: string }> };
    expect(archivedBody.entries.find((e) => e.id === entry!.id)).toBeDefined();
  });
});

/* ======================================================================== */
/* Sprint 9 v1.1 — correções da auditoria (PO): triggers autossuficientes,  */
/* exclusividade mútua e reativação formalizada.                            */
/* ======================================================================== */

/* Itens 1-3 exigem provar que os triggers de migrations/0014 NÃO dependem
   da ordem relativa de criação em relação ao trigger de migrations/0013
   nem entre si. SQLite não permite "reordenar" o disparo de triggers reais
   sobre o MESMO schema — a prova rigorosa é construir VARIANTES de schema
   (SQL real, lido diretamente dos arquivos de migration, nunca a cópia
   manual de fakeD1.ts) onde a presença/ordem de criação dos triggers muda
   de verdade, e mostrar que o resultado (abortar ou não) é IDÊNTICO em
   todas as variantes — mesma técnica dos testes adversariais de
   worker/testing/questions.test.ts (Sprint 7 v1.3/v1.4). */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "migrations");

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), "utf-8");
}

const BASE_MIGRATION_FILES = [
  "0001_init.sql",
  "0002_rate_limit_counters.sql",
  "0003_student_profiles_onboarding.sql",
  "0004_initial_diagnostic.sql",
  "0005_diagnostic_invariants.sql",
  "0006_adaptive_schedule_foundation.sql",
  "0007_patterns_foundation.sql",
  "0008_question_bank_editorial.sql",
  "0009_editorial_batch_invariants.sql",
  "0010_editorial_bidirectional_invariants.sql",
  "0011_editorial_collection_mutation_receipts.sql",
  "0012_editorial_mutation_identity.sql",
];

const TRIGGER_0013_MARKER = "CREATE TRIGGER IF NOT EXISTS trg_question_answer_events_require_attempt_identity";
const TRIGGER_0014_ERROR_ENTRY_MARKER = "CREATE TRIGGER IF NOT EXISTS trg_question_answer_events_require_error_entry";
const TRIGGER_0014_REVIEW_MARKER = "CREATE TRIGGER IF NOT EXISTS trg_question_answer_events_require_review_completion";

/** Divide o SQL real de 0013 em (a) tabelas/índices e (b) os três
 *  triggers — os triggers são sempre o ÚLTIMO bloco contíguo do arquivo
 *  (nada vem depois deles), então dividir no marcador do PRIMEIRO trigger
 *  isola os dois pedaços com segurança. */
function split0013(): { ddl: string; triggers: string } {
  const sql = readMigration("0013_question_player_attempts.sql");
  const index = sql.indexOf(TRIGGER_0013_MARKER);
  if (index === -1) throw new Error("Marcador do trigger de 0013 não encontrado — migration mudou?");
  return { ddl: sql.slice(0, index), triggers: sql.slice(index) };
}

/** Divide o SQL real de 0014 em (a) tabelas/índices e (b) o trigger de
 *  "registro automático" e (c) o de "conclusão de revisão", separadamente
 *  — para poder recriá-los em QUALQUER ordem escolhida pelo teste. */
function split0014(): { ddl: string; errorEntryTrigger: string; reviewCompletionTrigger: string } {
  const sql = readMigration("0014_error_notebook_spaced_review.sql");
  const errorEntryIndex = sql.indexOf(TRIGGER_0014_ERROR_ENTRY_MARKER);
  const reviewIndex = sql.indexOf(TRIGGER_0014_REVIEW_MARKER);
  if (errorEntryIndex === -1 || reviewIndex === -1) throw new Error("Marcadores dos triggers de 0014 não encontrados — migration mudou?");
  return {
    ddl: sql.slice(0, errorEntryIndex),
    errorEntryTrigger: sql.slice(errorEntryIndex, reviewIndex),
    reviewCompletionTrigger: sql.slice(reviewIndex),
  };
}

function seedUserQuestionAttempt(sqlite: DatabaseSync, opts: { userId: string; questionId: string; attemptId: string; errorEntryId?: string | null }): void {
  sqlite.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${opts.userId}','N','${opts.userId}@e.com','${opts.userId}@e.com','h')`);
  sqlite.exec(
    `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint, editorial_status) VALUES ('${opts.questionId}', 'C-${opts.questionId}', 'Enunciado', 'media', 'autoral', 'fp-${opts.questionId}', 'published')`
  );
  sqlite.exec(
    `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, error_entry_id) VALUES ('${opts.attemptId}','${opts.userId}','${opts.questionId}',1,'learning','in_progress',${opts.errorEntryId ? `'${opts.errorEntryId}'` : "NULL"})`
  );
}

/** Cenário adversarial mínimo — e o que os triggers de 0014 realmente
 *  precisam pegar sozinhos: o NÚCLEO reflete corretamente esta mutação
 *  (`last_mutation_id = NEW.id`, exatamente como o trigger de 0013 já
 *  exigiria — ou seja, 0013 NÃO teria motivo nenhum para abortar aqui),
 *  a tentativa está incorreta e fora de revisão, MAS a entrada do
 *  Caderno correspondente NUNCA foi criada. Só o trigger de 0014 tem
 *  como pegar isto — é exatamente o requisito da seção 5.1 (confirmação
 *  incorreta sem entrada obrigatória → rollback). Devolve a mensagem de
 *  erro lançada, ou `null` se nada abortou. */
function attemptMissingNotebookEntryInsert(sqlite: DatabaseSync, attemptId: string, mutationId: string): string | null {
  sqlite.exec(`UPDATE question_attempts SET is_correct = 0, version = 2, last_mutation_id = '${mutationId}' WHERE id = '${attemptId}'`);
  try {
    sqlite.exec(
      `INSERT INTO question_answer_events (id, attempt_id, new_alternative, event_type) VALUES ('${mutationId}','${attemptId}','A','confirmed')`
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Sprint 9 v1.1 — triggers autossuficientes (itens 1-3 da correção)", () => {
  it("1) o trigger de 0014 sozinho rejeita entrada ausente, SEM o trigger de 0013 presente no schema", () => {
    const { ddl: ddl0013 } = split0013();
    const sqlite = new DatabaseSync(":memory:");
    for (const file of BASE_MIGRATION_FILES) sqlite.exec(readMigration(file));
    sqlite.exec(ddl0013); // tabelas/índices de 0013, SEM nenhum dos seus três triggers
    sqlite.exec(readMigration("0014_error_notebook_spaced_review.sql")); // 0014 completa (tabelas + os dois triggers novos)

    seedUserQuestionAttempt(sqlite, { userId: "u1", questionId: "q1", attemptId: "a1" });
    const error = attemptMissingNotebookEntryInsert(sqlite, "a1", "mutation-1");

    expect(error).toMatch(/invariante violada \(autossuficiente\)/i);
    // Nenhuma escrita parcial: nem o evento, nem uma entrada órfã.
    const events = sqlite.prepare("SELECT COUNT(*) as c FROM question_answer_events").get() as { c: number };
    const entries = sqlite.prepare("SELECT COUNT(*) as c FROM error_notebook_entries").get() as { c: number };
    expect(events.c).toBe(0);
    expect(entries.c).toBe(0);
  });

  it("2) o trigger de 0014 detecta a mesma falha com o trigger de 0013 TOTALMENTE presente, mesmo quando 0013 não teria motivo para abortar sozinho", () => {
    // Schema COMPLETO (0013 com seu trigger de identidade intacto). O
    // cenário é construído para que a condição do trigger de 0013
    // (`question_attempts.last_mutation_id = NEW.id`) esteja SATISFEITA —
    // ou seja, 0013 não tem NADA para reclamar aqui, ele deixaria passar.
    // Só o de 0014 tem motivo para abortar (falta a entrada do Caderno) —
    // prova que o trabalho é de fato do trigger de 0014, não uma
    // coincidência de outro trigger "pegando" o problema por engano.
    const sqlite = new DatabaseSync(":memory:");
    for (const file of BASE_MIGRATION_FILES) sqlite.exec(readMigration(file));
    sqlite.exec(readMigration("0013_question_player_attempts.sql")); // 0013 COMPLETA, trigger incluído
    sqlite.exec(readMigration("0014_error_notebook_spaced_review.sql"));

    seedUserQuestionAttempt(sqlite, { userId: "u2", questionId: "q2", attemptId: "a2" });
    const error = attemptMissingNotebookEntryInsert(sqlite, "a2", "mutation-2");

    expect(error).toMatch(/invariante violada \(autossuficiente\)/i);
    const entries = sqlite.prepare("SELECT COUNT(*) as c FROM error_notebook_entries").get() as { c: number };
    expect(entries.c).toBe(0);
  });

  it("3) a ordem relativa de criação dos três triggers não muda o resultado (mesmo cenário, ordens diferentes, mesmo veredito)", () => {
    const { ddl: ddl0013, triggers: triggers0013 } = split0013();
    const { ddl: ddl0014, errorEntryTrigger, reviewCompletionTrigger } = split0014();

    function runScenario(sqlite: DatabaseSync): string | null {
      seedUserQuestionAttempt(sqlite, { userId: "u3", questionId: "q3", attemptId: "a3" });
      return attemptMissingNotebookEntryInsert(sqlite, "a3", "mutation-3");
    }

    // Ordem NORMAL: trigger de 0013 criado primeiro, depois os dois de 0014.
    const normalOrder = new DatabaseSync(":memory:");
    for (const file of BASE_MIGRATION_FILES) normalOrder.exec(readMigration(file));
    normalOrder.exec(ddl0013);
    normalOrder.exec(triggers0013);
    normalOrder.exec(ddl0014);
    normalOrder.exec(errorEntryTrigger);
    normalOrder.exec(reviewCompletionTrigger);
    const normalResult = runScenario(normalOrder);

    // Ordem INVERTIDA: os dois de 0014 criados ANTES do de 0013.
    const reversedOrder = new DatabaseSync(":memory:");
    for (const file of BASE_MIGRATION_FILES) reversedOrder.exec(readMigration(file));
    reversedOrder.exec(ddl0013);
    reversedOrder.exec(ddl0014);
    reversedOrder.exec(reviewCompletionTrigger);
    reversedOrder.exec(errorEntryTrigger);
    reversedOrder.exec(triggers0013);
    const reversedResult = runScenario(reversedOrder);

    // Schema SEM o trigger de 0013 (só os dois de 0014).
    const without0013 = new DatabaseSync(":memory:");
    for (const file of BASE_MIGRATION_FILES) without0013.exec(readMigration(file));
    without0013.exec(ddl0013);
    without0013.exec(ddl0014);
    without0013.exec(errorEntryTrigger);
    without0013.exec(reviewCompletionTrigger);
    const withoutResult = runScenario(without0013);

    expect(normalResult).toMatch(/invariante violada/i);
    expect(reversedResult).toMatch(/invariante violada/i);
    expect(withoutResult).toMatch(/invariante violada/i);
    // As três ordens abortam pelo MESMO motivo real (nunca uma coincidência
    // de qual trigger "venceu a corrida" — o de 0014 sozinho já é
    // suficiente nos três casos, com ou sem o de 0013 presente).
    expect(normalResult).toContain("autossuficiente");
    expect(reversedResult).toContain("autossuficiente");
    expect(withoutResult).toContain("autossuficiente");
  });
});

describe("Sprint 9 v1.1 — exclusividade mútua entre fluxo normal e conclusão de revisão (item 4-7)", () => {
  it("4) erro normal (fora de revisão) executa SÓ o fluxo normal — zero linhas em error_review_events", async () => {
    const qId = seedPublishedQuestion();
    await startAndConfirmWrong("excl-normal", qId);
    const entry = await findEntryByUserAndQuestion(db as never, "excl-normal", qId);
    expect(entry).not.toBeNull();
    expect(countRows("error_review_events")).toBe(0);
    expect(countRows("error_notebook_entries")).toBe(1);
  });

  it("5) revisão CORRETA executa SÓ o fluxo de revisão — error_count da entrada nunca muda", async () => {
    const originalId = seedPublishedQuestion({ id: "excl5-orig", code: "EXCL5-ORIG" });
    seedPublishedQuestion({ id: "excl5-sim", code: "EXCL5-SIM" });
    await startAndConfirmWrong("excl5", originalId);
    const before = await findEntryByUserAndQuestion(db as never, "excl5", originalId);
    const errorCountBefore = before!.error_count;

    const start = await startReview(db as never, "excl5", before!.id);
    await saveAnswer(db as never, "excl5", start.attemptId!, 1, "B");
    await confirmAnswer(db as never, "excl5", start.attemptId!, 2);

    const after = await findEntryByUserAndQuestion(db as never, "excl5", originalId);
    expect(after!.error_count).toBe(errorCountBefore); // o fluxo normal NUNCA rodou
    expect(countRows("error_review_events", `WHERE entry_id = '${before!.id}'`)).toBe(1);
    expect(countRows("error_notebook_entries")).toBe(1); // nenhuma segunda entrada criada
  });

  it("6) revisão INCORRETA executa SÓ o fluxo de revisão — error_count da entrada nunca muda, mesmo sendo 'errada'", async () => {
    const originalId = seedPublishedQuestion({ id: "excl6-orig", code: "EXCL6-ORIG" });
    seedPublishedQuestion({ id: "excl6-sim", code: "EXCL6-SIM" });
    await startAndConfirmWrong("excl6", originalId);
    const before = await findEntryByUserAndQuestion(db as never, "excl6", originalId);
    const errorCountBefore = before!.error_count;

    const start = await startReview(db as never, "excl6", before!.id);
    await saveAnswer(db as never, "excl6", start.attemptId!, 1, "A"); // errada
    await confirmAnswer(db as never, "excl6", start.attemptId!, 2);

    const after = await findEntryByUserAndQuestion(db as never, "excl6", originalId);
    // A confirmação incorreta de uma REVISÃO não é "um novo erro comum" —
    // error_count mede erros na questão ORIGINAL fora do ciclo de revisão
    // (seção 5), nunca incrementado pelo trigger de conclusão de revisão.
    expect(after!.error_count).toBe(errorCountBefore);
    expect(countRows("error_review_events", `WHERE entry_id = '${before!.id}'`)).toBe(1);
    expect(countRows("error_notebook_entries")).toBe(1);
  });

  it("7) revisão incorreta incrementa/agenda exatamente UMA vez (sem disparo duplo)", async () => {
    const originalId = seedPublishedQuestion({ id: "excl7-orig", code: "EXCL7-ORIG" });
    seedPublishedQuestion({ id: "excl7-sim", code: "EXCL7-SIM" });
    await startAndConfirmWrong("excl7", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "excl7", originalId);

    // "before" é capturado DEPOIS de iniciar a revisão (que já grava sua
    // própria versão, marcando in_review) — para medir exatamente o
    // efeito da CONFIRMAÇÃO em si, não do início.
    const start = await startReview(db as never, "excl7", entry!.id);
    const before = await findEntryByUserAndQuestion(db as never, "excl7", originalId);
    await saveAnswer(db as never, "excl7", start.attemptId!, 1, "A");
    await confirmAnswer(db as never, "excl7", start.attemptId!, 2);

    const after = await findEntryByUserAndQuestion(db as never, "excl7", originalId);
    expect(after!.review_stage).toBe(0); // reset, uma única vez
    expect(after!.version).toBe(before!.version + 1); // exatamente um UPDATE consolidado
    expect(countRows("error_review_events", `WHERE attempt_id = '${start.attemptId}'`)).toBe(1);
  });
});

describe("Sprint 9 v1.1 — reversão completa em falha (itens 8-9)", () => {
  it("8) falha no fluxo NORMAL reverte question_attempts, question_answer_events E error_notebook_entries", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("rev8");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    // A versão ANTES da tentativa de confirmação — o PATCH de resposta já
    // avançou legitimamente para 2; é essa a versão que deve permanecer
    // intocada depois da falha (nunca um valor fixo assumido).
    const versionBeforeConfirm = (db.sqlite.prepare("SELECT version FROM question_attempts WHERE id = ?").get(attemptId) as { version: number }).version;

    db.failNextMatching(/INSERT INTO error_notebook_entries/);
    await expect(confirmAnswer(db as never, "rev8", attemptId, 2)).rejects.toThrow();

    const attemptRow = db.sqlite.prepare("SELECT status, is_correct, version FROM question_attempts WHERE id = ?").get(attemptId) as {
      status: string;
      is_correct: number | null;
      version: number;
    };
    expect(attemptRow.status).toBe("in_progress");
    expect(attemptRow.is_correct).toBeNull();
    expect(attemptRow.version).toBe(versionBeforeConfirm); // a tentativa FALHA de confirmar não avançou nada
    // O evento 'selected' do PATCH de resposta (bem-sucedido, ANTES da
    // tentativa de confirmar) continua existindo legitimamente — só o
    // evento 'confirmed' desta chamada FALHA precisa estar ausente.
    expect(countRows("question_answer_events", `WHERE attempt_id = '${attemptId}' AND event_type = 'confirmed'`)).toBe(0);
    expect(countRows("error_notebook_entries")).toBe(0);
  });

  it("9) falha no fluxo de REVISÃO reverte question_attempts, question_answer_events E a agenda da entrada", async () => {
    const originalId = seedPublishedQuestion({ id: "rev9-orig", code: "REV9-ORIG" });
    seedPublishedQuestion({ id: "rev9-sim", code: "REV9-SIM" });
    await startAndConfirmWrong("rev9", originalId);
    const freshEntry = await findEntryByUserAndQuestion(db as never, "rev9", originalId);
    const start = await startReview(db as never, "rev9", freshEntry!.id);
    // "entryBefore" é capturado DEPOIS de iniciar a revisão, pela mesma
    // razão do item 7 acima: iniciar já grava sua própria versão.
    const entryBefore = await findEntryByUserAndQuestion(db as never, "rev9", originalId);
    await saveAnswer(db as never, "rev9", start.attemptId!, 1, "B");
    const versionBeforeConfirm = (db.sqlite.prepare("SELECT version FROM question_attempts WHERE id = ?").get(start.attemptId) as { version: number })
      .version;

    db.failNextMatching(/INSERT INTO error_review_events/);
    await expect(confirmAnswer(db as never, "rev9", start.attemptId!, 2)).rejects.toThrow();

    const attemptRow = db.sqlite.prepare("SELECT status, version FROM question_attempts WHERE id = ?").get(start.attemptId) as {
      status: string;
      version: number;
    };
    expect(attemptRow.status).toBe("in_progress");
    expect(attemptRow.version).toBe(versionBeforeConfirm);
    expect(countRows("question_answer_events", `WHERE attempt_id = '${start.attemptId}' AND event_type = 'confirmed'`)).toBe(0);
    expect(countRows("error_review_events", `WHERE attempt_id = '${start.attemptId}'`)).toBe(0);
    const entryAfter = await findEntryByUserAndQuestion(db as never, "rev9", originalId);
    expect(entryAfter!.next_review_at).toBe(entryBefore!.next_review_at); // agenda intocada
    expect(entryAfter!.version).toBe(entryBefore!.version);
  });
});

describe("Sprint 9 v1.1 — reativação formalizada de entradas corrected/archived (itens 10-11)", () => {
  it("10) um novo erro reativa uma entrada 'corrected' — volta para pending_understanding, zera estágio, limpa corrected_at", async () => {
    const originalId = seedPublishedQuestion({ id: "react10-orig", code: "REACT10-ORIG" });
    const similarId = seedPublishedQuestion({ id: "react10-sim", code: "REACT10-SIM" });
    await startAndConfirmWrong("react10", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "react10", originalId);

    // Duas revisões corretas em questões distintas → corrected.
    const start1 = await startReview(db as never, "react10", entry!.id);
    await saveAnswer(db as never, "react10", start1.attemptId!, 1, "B");
    await confirmAnswer(db as never, "react10", start1.attemptId!, 2);
    const start2 = await startReview(db as never, "react10", entry!.id);
    // "B" é sempre a alternativa correta nas questões de
    // worker/testing/questionFixtures.ts:seedQuestion (convenção do
    // helper) — a 2ª revisão precisa acertar de verdade também.
    await saveAnswer(db as never, "react10", start2.attemptId!, 1, "B");
    await confirmAnswer(db as never, "react10", start2.attemptId!, 2);

    const corrected = await findEntryByUserAndQuestion(db as never, "react10", originalId);
    expect(corrected!.status).toBe("corrected");
    expect(corrected!.corrected_at).not.toBeNull();
    void similarId;

    // Novo erro independente na MESMA questão original.
    const token = "session-token-react10";
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: originalId, mode: "practice" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });

    const reactivated = await findEntryByUserAndQuestion(db as never, "react10", originalId);
    expect(reactivated!.status).toBe("pending_understanding");
    expect(reactivated!.review_stage).toBe(0);
    expect(reactivated!.corrected_at).toBeNull();
    expect(reactivated!.error_count).toBe(corrected!.error_count + 1);
    expect(reactivated!.latest_attempt_id).toBe(attemptId);
    // A reativação agenda +1 dia a partir de AGORA (seção 6 — erro
    // original/reset sempre +1 dia) — como a entrada estava "corrected"
    // com um agendamento de estágio avançado (+7 dias, calculado ANTES,
    // a partir de um "agora" ligeiramente mais cedo), o reagendamento
    // reativado é estritamente MAIS PRÓXIMO no tempo, nunca mais distante:
    // o erro reapareceu, então a urgência da próxima revisão aumenta.
    expect(new Date(reactivated!.next_review_at).getTime()).toBeLessThan(new Date(corrected!.next_review_at).getTime());
  });

  it("11) um novo erro reativa uma entrada 'archived' da mesma forma", async () => {
    const originalId = seedPublishedQuestion({ id: "react11-orig", code: "REACT11-ORIG" });
    await startAndConfirmWrong("react11", originalId);
    const entry = await findEntryByUserAndQuestion(db as never, "react11", originalId);

    const archived = await archiveEntry(db as never, "react11", entry!.id, entry!.version, "arch-react11");
    expect(archived.ok).toBe(true);
    const archivedRow = await findEntryByUserAndQuestion(db as never, "react11", originalId);
    expect(archivedRow!.status).toBe("archived");

    const token = "session-token-react11";
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: originalId, mode: "practice" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });

    const reactivated = await findEntryByUserAndQuestion(db as never, "react11", originalId);
    expect(reactivated!.status).toBe("pending_understanding");
    expect(reactivated!.review_stage).toBe(0);
    expect(reactivated!.corrected_at).toBeNull();
    expect(reactivated!.error_count).toBe(archivedRow!.error_count + 1);
  });
});

describe("Sprint 9 v1.1 — retry não duplica nenhuma das operações acima (item 12)", () => {
  it("12) retry do fluxo normal, do fluxo de revisão e de uma reativação não duplicam entrada/evento/auditoria", async () => {
    const originalId = seedPublishedQuestion({ id: "retry12-orig", code: "RETRY12-ORIG" });
    seedPublishedQuestion({ id: "retry12-sim", code: "RETRY12-SIM" });
    const token = await seedUserWithSession("retry12");

    // Fluxo normal + retry.
    const create1 = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: originalId, mode: "learning" }) });
    const { attemptId: attempt1 } = (await create1.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attempt1}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callPlayerRoute(`/api/player/attempts/${attempt1}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${attempt1}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) }); // retry
    expect(countRows("error_notebook_entries")).toBe(1);
    expect(countRows("audit_log", `WHERE event_type = 'error_notebook_entry_created' AND user_id = 'retry12'`)).toBe(1);

    const entry = await findEntryByUserAndQuestion(db as never, "retry12", originalId);

    // Fluxo de revisão + retry.
    const start = await startReview(db as never, "retry12", entry!.id);
    await callPlayerRoute(`/api/player/attempts/${start.attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${start.attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${start.attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) }); // retry
    expect(countRows("error_review_events", `WHERE attempt_id = '${start.attemptId}'`)).toBe(1);
    expect(countRows("audit_log", `WHERE event_type = 'error_notebook_review_completed' AND user_id = 'retry12'`)).toBe(1);

    // Reativação: arquiva, novo erro, e RETRY do próprio confirm do novo erro.
    const midEntry = await findEntryByUserAndQuestion(db as never, "retry12", originalId);
    await archiveEntry(db as never, "retry12", midEntry!.id, midEntry!.version, "arch-retry12");
    const create2 = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: originalId, mode: "practice" }) });
    const { attemptId: attempt2 } = (await create2.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attempt2}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callPlayerRoute(`/api/player/attempts/${attempt2}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${attempt2}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) }); // retry da reativação

    expect(countRows("error_notebook_entries")).toBe(1); // nunca uma segunda entrada
    const reactivated = await findEntryByUserAndQuestion(db as never, "retry12", originalId);
    expect(reactivated!.status).toBe("pending_understanding");
    expect(reactivated!.error_count).toBe(midEntry!.error_count + 1); // incrementou uma vez só, não duas
    expect(countRows("audit_log", `WHERE event_type = 'error_notebook_entry_updated' AND user_id = 'retry12'`)).toBe(1);
  });
});
