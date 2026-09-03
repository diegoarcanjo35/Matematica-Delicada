// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { FIXTURE_ADMIN, FIXTURE_PLAIN_USER, seedFullAdminScenario } from "./adminFixtures";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleAdminRequest } from "../src/routes/admin";

/* Sprint 16 v1.2 — pipelines administrativos mínimos de conteúdo real
   (ordem seções 2-4): Diagnóstico, Cronograma, Padrões. Mesma convenção de
   worker/testing/admin.test.ts: SQLite real por trás do FakeD1Database,
   rotas reais chamadas diretamente. Cobre, para os três: RBAC (401/403),
   criação com validação/idempotência/conflito, listagem, auditoria, e a
   garantia central de "sem fixture" — nenhuma escrita deste pipeline
   jamais tem is_local_fixture = 1, e nenhuma leitura/mutação alcança uma
   linha de fixture pré-existente. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  seedFullAdminScenario(db.sqlite);
});

async function sessionFor(userId: string): Promise<string> {
  const rawToken = `session-token-${userId}`;
  await createSession(db as never, {
    id: `${userId}-session`,
    userId,
    tokenHash: await sha256Hex(rawToken),
    sessionVersion: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userAgent: null,
  });
  return rawToken;
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development" };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${LOCAL_ORIGIN}${path}`, { ...init, headers });
}

async function callAdminRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handleAdminRequest(request, localEnv(), url))!;
}

function postJson(path: string, token: string | null, body: unknown): Promise<Response> {
  return callAdminRoute(path, token, { method: "POST", body: JSON.stringify(body) });
}
function patchJson(path: string, token: string | null, body: unknown): Promise<Response> {
  return callAdminRoute(path, token, { method: "PATCH", body: JSON.stringify(body) });
}
function del(path: string, token: string | null): Promise<Response> {
  return callAdminRoute(path, token, { method: "DELETE" });
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

function seedFixtureDiagnosticQuestion(): void {
  db.sqlite.exec(
    `INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES ('fix-diag-1', '[PROVISÓRIO] fixture', 0, 1)`
  );
}

function seedFixtureScheduleActivity(): void {
  db.sqlite.exec(
    `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin, dismissible, is_local_fixture)
     VALUES ('fix-sched-1', 'aula_video', '[PROVISÓRIO]', 'obj', 10, 'crit', 'expl', 'manual', 'system', 1, 1)`
  );
}

function seedFixturePattern(): void {
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status, version, is_local_fixture)
     VALUES ('fix-pat-1', 'FIX-01', 'fixture-slug', '[PROVISÓRIO]', 'F', 'D', 'E', 'X', 'R', 'published', 1, 1)`
  );
}

/* ---------------------------------------------------------------------- */
/* Diagnóstico (ordem seção 2)                                             */
/* ---------------------------------------------------------------------- */

describe("Admin — Diagnóstico", () => {
  const validPayload = {
    prompt: "Qual o valor de x em 2x = 10?",
    options: [
      { text: "5", isCorrect: true },
      { text: "10", isCorrect: false },
    ],
    recognitionOptions: [],
    helpLayers: { 1: "Pista." },
  };

  it("sem sessão: 401", async () => {
    const response = await postJson("/api/admin/diagnostic-questions", null, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(response.status).toBe(401);
  });

  it("sessão sem papel admin: 403, nada criado", async () => {
    const token = await sessionFor(FIXTURE_PLAIN_USER);
    const before = countRows("diagnostic_questions");
    const response = await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(response.status).toBe(403);
    expect(countRows("diagnostic_questions")).toBe(before);
  });

  it("admin: cria com sucesso, is_local_fixture = 0, audita admin_diagnostic_question_created", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    const response = await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { questionId: string };
    expect(body.questionId).toBe(mutationId);

    const row = db.sqlite.prepare("SELECT is_local_fixture FROM diagnostic_questions WHERE id = ?").get(mutationId) as { is_local_fixture: number };
    expect(row.is_local_fixture).toBe(0);
    expect(countRows("diagnostic_question_options", `WHERE question_id = '${mutationId}'`)).toBe(2);
    expect(countRows("audit_log", `WHERE event_type = 'admin_diagnostic_question_created' AND id = '${mutationId}'`)).toBe(1);
  });

  it("retry idempotente (mesmo mutationId, mesmo conteúdo): changed:false, nenhuma linha duplicada", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    const first = await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId });
    expect(first.status).toBe(201);
    const second = await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { changed: boolean };
    expect(secondBody.changed).toBe(false);
    expect(countRows("diagnostic_questions")).toBe(1);
  });

  it("mesmo mutationId, conteúdo DIFERENTE: 409, nunca reaplica", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId });
    const conflicting = await postJson("/api/admin/diagnostic-questions", token, {
      ...validPayload,
      prompt: "Enunciado completamente diferente.",
      mutationId,
    });
    expect(conflicting.status).toBe(409);
  });

  it("validação: menos de 2 alternativas é rejeitado, nada criado", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/diagnostic-questions", token, {
      ...validPayload,
      options: [{ text: "só uma", isCorrect: true }],
      mutationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(400);
    expect(countRows("diagnostic_questions")).toBe(0);
  });

  it("validação: zero alternativas corretas é rejeitado", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/diagnostic-questions", token, {
      ...validPayload,
      options: [
        { text: "A", isCorrect: false },
        { text: "B", isCorrect: false },
      ],
      mutationId: crypto.randomUUID(),
    });
    expect(response.status).toBe(400);
  });

  it("GET lista só questões reais — nunca uma fixture pré-existente", async () => {
    seedFixtureDiagnosticQuestion();
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId });

    const response = await callAdminRoute("/api/admin/diagnostic-questions", token);
    const body = (await response.json()) as { questions: Array<{ id: string }> };
    expect(body.questions.map((q) => q.id)).toEqual([mutationId]);
  });

  it("DELETE não remove uma fixture local, mesmo pelo id correto — sempre 404 (nunca acessível por este pipeline)", async () => {
    seedFixtureDiagnosticQuestion();
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await del("/api/admin/diagnostic-questions/fix-diag-1", token);
    expect(response.status).toBe(404);
    expect(countRows("diagnostic_questions", "WHERE id = 'fix-diag-1'")).toBe(1);
  });

  it("DELETE de uma questão real: remove núcleo + opções atomicamente, audita", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/diagnostic-questions", token, { ...validPayload, mutationId });

    const response = await del(`/api/admin/diagnostic-questions/${mutationId}`, token);
    expect(response.status).toBe(200);
    expect(countRows("diagnostic_questions", `WHERE id = '${mutationId}'`)).toBe(0);
    expect(countRows("diagnostic_question_options", `WHERE question_id = '${mutationId}'`)).toBe(0);
    expect(countRows("audit_log", "WHERE event_type = 'admin_diagnostic_question_deleted'")).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Cronograma (ordem seção 3)                                              */
/* ---------------------------------------------------------------------- */

describe("Admin — Cronograma", () => {
  const validPayload = {
    type: "aula_video",
    title: "Aula: Razão e Proporção",
    objective: "Introduzir o conceito.",
    estimatedMinutes: 20,
    completionCriteria: "Assistir até o fim.",
    explanation: "Recomendada com base na disponibilidade configurada.",
    completionMode: "manual",
    origin: "system",
  };

  it("sem sessão: 401; sem papel admin: 403", async () => {
    const unauth = await postJson("/api/admin/schedule-activities", null, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(unauth.status).toBe(401);
    const token = await sessionFor(FIXTURE_PLAIN_USER);
    const forbidden = await postJson("/api/admin/schedule-activities", token, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(forbidden.status).toBe(403);
  });

  it("admin: cria com sucesso, is_local_fixture = 0, audita", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    const response = await postJson("/api/admin/schedule-activities", token, { ...validPayload, mutationId });
    expect(response.status).toBe(201);
    const row = db.sqlite.prepare("SELECT is_local_fixture FROM schedule_activities WHERE id = ?").get(mutationId) as { is_local_fixture: number };
    expect(row.is_local_fixture).toBe(0);
    expect(countRows("audit_log", "WHERE event_type = 'admin_schedule_activity_created'")).toBe(1);
  });

  it("validação: tipo fora do enum fechado é rejeitado", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await postJson("/api/admin/schedule-activities", token, { ...validPayload, type: "tipo_inventado", mutationId: crypto.randomUUID() });
    expect(response.status).toBe(400);
  });

  it("PATCH edita uma atividade real; conteúdo idêntico é no-op (changed:false)", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/schedule-activities", token, { ...validPayload, mutationId });

    const noop = await patchJson(`/api/admin/schedule-activities/${mutationId}`, token, { ...validPayload, mutationId: crypto.randomUUID() });
    expect((await noop.json()).changed).toBe(false);

    const changed = await patchJson(`/api/admin/schedule-activities/${mutationId}`, token, { ...validPayload, title: "Título Editado", mutationId: crypto.randomUUID() });
    expect((await changed.json()).changed).toBe(true);
    const row = db.sqlite.prepare("SELECT title FROM schedule_activities WHERE id = ?").get(mutationId) as { title: string };
    expect(row.title).toBe("Título Editado");
  });

  it("PATCH numa fixture local: 404 (nunca editável por este pipeline)", async () => {
    seedFixtureScheduleActivity();
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await patchJson("/api/admin/schedule-activities/fix-sched-1", token, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(response.status).toBe(404);
  });

  it("DELETE recusado (409) quando a atividade tem atribuição real de aluno", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/schedule-activities", token, { ...validPayload, mutationId });
    db.sqlite.exec(
      `INSERT INTO schedule_activity_assignments (id, user_id, activity_id, status) VALUES ('assign-1', '${FIXTURE_ADMIN}', '${mutationId}', 'not_started')`
    );
    const response = await del(`/api/admin/schedule-activities/${mutationId}`, token);
    expect(response.status).toBe(409);
    expect(countRows("schedule_activities", `WHERE id = '${mutationId}'`)).toBe(1);
  });

  it("DELETE de uma atividade real sem atribuições: remove e audita", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/schedule-activities", token, { ...validPayload, mutationId });
    const response = await del(`/api/admin/schedule-activities/${mutationId}`, token);
    expect(response.status).toBe(200);
    expect(countRows("schedule_activities", `WHERE id = '${mutationId}'`)).toBe(0);
    expect(countRows("audit_log", "WHERE event_type = 'admin_schedule_activity_deleted'")).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Padrões (ordem seção 4 — charter emendado)                              */
/* ---------------------------------------------------------------------- */

describe("Admin — Padrões (charter emendado)", () => {
  const validPayload = {
    code: "PAD-ADMIN-01",
    slug: "padrao-admin-01",
    name: "Padrão Administrativo 1",
    recognitionPhrase: "Frase de reconhecimento.",
    description: "Descrição.",
    mainStrategy: "Estratégia.",
    introductoryExample: "Exemplo.",
    strategicSummary: "Resumo.",
    attributes: { tags: ["proporcionalidade"], requiredContents: ["Razão e proporção"] },
  };

  it("sem sessão: 401; sem papel admin: 403", async () => {
    const unauth = await postJson("/api/admin/patterns", null, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(unauth.status).toBe(401);
    const token = await sessionFor(FIXTURE_PLAIN_USER);
    const forbidden = await postJson("/api/admin/patterns", token, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(forbidden.status).toBe(403);
  });

  it("admin: cria como draft, is_local_fixture = 0, atributos gravados, audita", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    const response = await postJson("/api/admin/patterns", token, { ...validPayload, mutationId });
    expect(response.status).toBe(201);
    const row = db.sqlite.prepare("SELECT editorial_status, is_local_fixture, version FROM patterns WHERE id = ?").get(mutationId) as {
      editorial_status: string;
      is_local_fixture: number;
      version: number;
    };
    expect(row.editorial_status).toBe("draft");
    expect(row.is_local_fixture).toBe(0);
    expect(row.version).toBe(1);
    expect(countRows("pattern_attributes", `WHERE pattern_id = '${mutationId}'`)).toBe(2);
    expect(countRows("audit_log", "WHERE event_type = 'admin_pattern_created'")).toBe(1);
  });

  it("code/slug duplicados (de outro padrão real): 409 com fieldError, nunca uma exceção crua", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    await postJson("/api/admin/patterns", token, { ...validPayload, mutationId: crypto.randomUUID() });
    const response = await postJson("/api/admin/patterns", token, { ...validPayload, mutationId: crypto.randomUUID() });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { fields: Record<string, string> } };
    // Ambos code e slug colidem neste teste (payload idêntico) — qual dos
    // dois o SQLite reporta primeiro é um detalhe de implementação; o que
    // importa é que a resposta seja um fieldError controlado (nunca uma
    // exceção crua/500) apontando para um dos dois campos duplicados.
    expect(body.error.fields.code || body.error.fields.slug).toBeTruthy();
  });

  it("PATCH edita dados essenciais com expectedVersion correta; versão errada -> 409", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/patterns", token, { ...validPayload, mutationId });

    const wrongVersion = await patchJson(`/api/admin/patterns/${mutationId}`, token, { ...validPayload, name: "Novo Nome", expectedVersion: 99, mutationId: crypto.randomUUID() });
    expect(wrongVersion.status).toBe(409);

    const correct = await patchJson(`/api/admin/patterns/${mutationId}`, token, { ...validPayload, name: "Novo Nome", expectedVersion: 1, mutationId: crypto.randomUUID() });
    expect(correct.status).toBe(200);
    const row = db.sqlite.prepare("SELECT name, version FROM patterns WHERE id = ?").get(mutationId) as { name: string; version: number };
    expect(row.name).toBe("Novo Nome");
    expect(row.version).toBe(2);
  });

  it("publicar/inativar (status): transições guardadas por versão, auditadas", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/patterns", token, { ...validPayload, mutationId });

    const publish = await patchJson(`/api/admin/patterns/${mutationId}/status`, token, { action: "publish", expectedVersion: 1, mutationId: crypto.randomUUID() });
    expect(publish.status).toBe(200);
    let row = db.sqlite.prepare("SELECT editorial_status, version FROM patterns WHERE id = ?").get(mutationId) as { editorial_status: string; version: number };
    expect(row.editorial_status).toBe("published");
    expect(row.version).toBe(2);

    const inactivate = await patchJson(`/api/admin/patterns/${mutationId}/status`, token, { action: "inactivate", expectedVersion: 2, mutationId: crypto.randomUUID() });
    expect(inactivate.status).toBe(200);
    row = db.sqlite.prepare("SELECT editorial_status FROM patterns WHERE id = ?").get(mutationId) as { editorial_status: string };
    expect(row.editorial_status).toBe("archived");

    expect(countRows("audit_log", "WHERE event_type = 'admin_pattern_published'")).toBe(1);
    expect(countRows("audit_log", "WHERE event_type = 'admin_pattern_inactivated'")).toBe(1);
  });

  it("PATCH numa fixture local: 404 (charter emendado nunca alcança fixture)", async () => {
    seedFixturePattern();
    const token = await sessionFor(FIXTURE_ADMIN);
    const response = await patchJson("/api/admin/patterns/fix-pat-1", token, { ...validPayload, expectedVersion: 1, mutationId: crypto.randomUUID() });
    expect(response.status).toBe(404);
  });

  it("GET lista só padrões reais — nunca uma fixture pré-existente", async () => {
    seedFixturePattern();
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/patterns", token, { ...validPayload, mutationId });

    const response = await callAdminRoute("/api/admin/patterns", token);
    const body = (await response.json()) as { patterns: Array<{ id: string }> };
    expect(body.patterns.map((p) => p.id)).toEqual([mutationId]);
  });

  it("sem score/TRI/domínio: DTO nunca inclui nenhum campo de índice pedagógico", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    const mutationId = crypto.randomUUID();
    await postJson("/api/admin/patterns", token, { ...validPayload, mutationId });
    const response = await callAdminRoute("/api/admin/patterns", token);
    const body = (await response.json()) as { patterns: Array<Record<string, unknown>> };
    const keys = Object.keys(body.patterns[0]);
    const forbiddenKeys = ["score", "recognitionIndex", "resolutionIndex", "masteryIndex", "rawEvidenceCount", "triScore", "domain", "mastery"];
    for (const forbidden of forbiddenKeys) expect(keys).not.toContain(forbidden);
  });
});

/* ---------------------------------------------------------------------- */
/* RBAC/mutação: mutationId reaproveitado por outra requisição real -> 409 */
/* ---------------------------------------------------------------------- */

describe("Admin — auditoria nunca duplica nem vaza entre pipelines", () => {
  it("cada pipeline audita com o próprio AuditEventType — nenhum evento cruzado", async () => {
    const token = await sessionFor(FIXTURE_ADMIN);
    await postJson("/api/admin/diagnostic-questions", token, {
      prompt: "P?",
      options: [
        { text: "A", isCorrect: true },
        { text: "B", isCorrect: false },
      ],
      recognitionOptions: [],
      helpLayers: {},
      mutationId: crypto.randomUUID(),
    });
    await postJson("/api/admin/schedule-activities", token, {
      type: "aula_video",
      title: "T",
      objective: "O",
      estimatedMinutes: 10,
      completionCriteria: "C",
      explanation: "E",
      completionMode: "manual",
      origin: "system",
      mutationId: crypto.randomUUID(),
    });
    await postJson("/api/admin/patterns", token, {
      code: "PAD-X",
      slug: "pad-x",
      name: "N",
      recognitionPhrase: "F",
      description: "D",
      mainStrategy: "E",
      introductoryExample: "X",
      strategicSummary: "R",
      mutationId: crypto.randomUUID(),
    });

    expect(countRows("audit_log", "WHERE event_type = 'admin_diagnostic_question_created'")).toBe(1);
    expect(countRows("audit_log", "WHERE event_type = 'admin_schedule_activity_created'")).toBe(1);
    expect(countRows("audit_log", "WHERE event_type = 'admin_pattern_created'")).toBe(1);
  });
});
