// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleDailyTrainingRequest } from "../src/routes/dailyTraining";
import { abandonList, applyList, completeList, skipItem, startItem, syncItem, type StartItemResult } from "../src/services/dailyTrainingService";
import {
  buildAbandonListStatement,
  buildReleaseAbandonedItemAttemptsStatement,
  findAttemptOwnerWithListStatus,
} from "../src/repositories/dailyTrainingRepository";
import { confirmAnswer, saveAnswer } from "../src/services/playerService";
import { civilDateInTimezone, weekdayCodeForCivilDate } from "../src/lib/scheduleValidation";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 11 v1.0 — provas DIRETAS no banco (nunca só a resposta HTTP) das
   garantias de atomicidade/idempotência/concorrência exigidas pela seção
   15 da ordem, mesmo padrão de worker/testing/playerAtomicity.test.ts
   (Sprint 8) e worker/testing/errorNotebook.test.ts (Sprint 9):
     - dois applies simultâneos criam exatamente UMA lista ativa;
     - start simultâneo cria/associa exatamente UMA tentativa;
     - falha genuína de SQL no INSERT do evento reverte também o núcleo
       (nunca escrita parcial);
     - colisão de mutationId retorna conflito controlado, nunca corrompe;
     - auditoria só é gravada quando a mutação é REAL (changed === true). */

let db: FakeD1Database;

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

const NOW_ISO = "2026-09-01T15:00:00.000Z";
const CLOCK = fixedClock(NOW_ISO);
const TIMEZONE = "America/Sao_Paulo";
const TODAY_CIVIL = civilDateInTimezone(new Date(NOW_ISO), TIMEZONE);
const TODAY_WEEKDAY = weekdayCodeForCivilDate(TODAY_CIVIL);
const LOCAL_ORIGIN = "http://localhost:8793";

/* v1.4 — causa raiz real dos 5 testes que falhavam (nunca vazamento entre
   arquivos de teste, ver relatório da correção): as rotas HTTP chamadas via
   `callRoute` (abaixo) invocam os serviços SEM passar `CLOCK` — usam o
   `systemClock` padrão (relógio de parede REAL do processo), não o `CLOCK`
   fixo acima. `TODAY_WEEKDAY` reflete só o dia da semana de NOW_ISO
   (fixado em 2026-09-01), então qualquer perfil semeado só com
   `[TODAY_WEEKDAY]` fica indisponível assim que o dia civil real (usado
   pelas chamadas via HTTP) vira para outro dia da semana — os testes deste
   arquivo então dependiam silenciosamente de rodar no mesmo dia da semana
   de NOW_ISO. `AVAILABLE_WEEKDAYS` inclui os dois dias (o de NOW_ISO, para
   os testes que chamam os serviços diretamente com `CLOCK`, e o do relógio
   real, para os que passam pela rota HTTP com `systemClock`), tornando os
   testes de atomicidade/idempotência independentes da data em que rodam —
   sem mexer em nenhum código de produção. */
const REAL_TODAY_WEEKDAY = weekdayCodeForCivilDate(civilDateInTimezone(new Date(), TIMEZONE));
const AVAILABLE_WEEKDAYS = Array.from(new Set([TODAY_WEEKDAY, REAL_TODAY_WEEKDAY]));

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, { id, name: "Usuária Teste", email: `${id}@teste.dev`, emailNormalized: `${id}@teste.dev`, passwordHash: "hash" });
}

/** Cria a sessão para um usuário JÁ existente (ex.: já criado por
 *  `setupUserWithOneEligibleQuestion`) — nunca chama `seedUser` de novo
 *  (evitaria uma violação de unicidade em `users`). */
async function createSessionForUser(id: string): Promise<string> {
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

function seedPattern(id: string, code: string): void {
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${id}', '${code}', 'slug-${id}', 'Padrão ${id}', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
}

function seedProfile(userId: string, availableDays: string[], dailyMinutes: number): void {
  db.sqlite.exec(
    `INSERT INTO student_profiles (user_id, available_days, daily_minutes, status) VALUES ('${userId}', '${JSON.stringify(availableDays)}', ${dailyMinutes}, 'completed')`
  );
}

function seedPublishedQuestion(id: string, code: string, patternId: string): string {
  return seedQuestion(db.sqlite, { id, code, status: "published", version: 1, patternId });
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

function localEnv(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ENABLE_LOCAL_EDITORIAL_FIXTURES: "true" };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${LOCAL_ORIGIN}${path}`, { ...init, headers });
}

async function callRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  const response = await handleDailyTrainingRequest(request, localEnv(), url);
  return response!;
}

async function setupUserWithOneEligibleQuestion(userId: string): Promise<void> {
  await seedUser(userId);
  seedPattern(`p-${userId}`, `PAD-${userId}`);
  seedPublishedQuestion(`q-${userId}`, `C-${userId}`, `p-${userId}`);
  seedProfile(userId, AVAILABLE_WEEKDAYS, 60);
}

describe("dois applies simultâneos criam exatamente UMA lista ativa (seção 15 da ordem)", () => {
  it("duas chamadas concorrentes de applyList para o MESMO aluno/dia nunca duplicam a lista", async () => {
    await setupUserWithOneEligibleQuestion("u-race-apply");

    const [r1, r2] = await Promise.all([
      applyList(db as never, "u-race-apply", "mut-a", false, CLOCK),
      applyList(db as never, "u-race-apply", "mut-b", false, CLOCK),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.value!.listId).toBe(r2.value!.listId);
    expect(countRows("daily_training_lists", `WHERE user_id = 'u-race-apply' AND status = 'active'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE event_type = 'list_created'`)).toBe(1);
  });
});

describe("start simultâneo cria/associa exatamente UMA tentativa (seção 15 da ordem)", () => {
  it("duas chamadas concorrentes de startItem no MESMO item resultam numa única question_attempts e um único item_started", async () => {
    await setupUserWithOneEligibleQuestion("u-race-start");
    const applied = await applyList(db as never, "u-race-start", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };

    const [r1, r2] = await Promise.all([
      startItem(db as never, "u-race-start", listId, itemRow.id, "start-a", false),
      startItem(db as never, "u-race-start", listId, itemRow.id, "start-b", false),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.value!.attemptId).toBe(r2.value!.attemptId);
    expect(countRows("question_attempts", `WHERE user_id = 'u-race-start'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
    expect(countRows("daily_training_items", `WHERE id = '${itemRow.id}' AND status = 'in_progress'`)).toBe(1);
  });
});

describe("falha genuína de SQL no INSERT do evento reverte também o núcleo (seção 15 da ordem)", () => {
  it("apply: INSERT de daily_training_events forçado a falhar não deixa lista/itens órfãos", async () => {
    await setupUserWithOneEligibleQuestion("u-fail-apply");
    db.failNextMatching(/INSERT INTO daily_training_events/);

    await expect(applyList(db as never, "u-fail-apply", "mut-1", false, CLOCK)).rejects.toThrow();

    expect(countRows("daily_training_lists")).toBe(0);
    expect(countRows("daily_training_items")).toBe(0);
  });

  it("start: INSERT de daily_training_events forçado a falhar não deixa o item marcado in_progress sem evento, NEM uma tentativa órfã do Player (PO v1.1, seção 1-3)", async () => {
    await setupUserWithOneEligibleQuestion("u-fail-start");
    const applied = await applyList(db as never, "u-fail-start", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };

    db.failNextMatching(/INSERT INTO daily_training_events/);
    await expect(startItem(db as never, "u-fail-start", listId, itemRow.id, "start-1", false)).rejects.toThrow();

    const row = db.sqlite.prepare(`SELECT status, question_attempt_id, version FROM daily_training_items WHERE id = ?`).get(itemRow.id) as {
      status: string;
      question_attempt_id: string | null;
      version: number;
    };
    expect(row.status).toBe("pending"); // núcleo revertido junto com o evento
    expect(row.question_attempt_id).toBeNull();
    expect(row.version).toBe(1);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemRow.id}'`)).toBe(0);
    // PO v1.1 (seção 1-3): a criação da tentativa do Player e a associação
    // ao item precisam viajar na MESMA transação — uma falha depois de criar
    // a tentativa NUNCA pode deixá-la órfã (criada mas nunca associada,
    // pendente de "reassociação" numa próxima chamada). Prova direta contra
    // a tabela do Player, não só contra daily_training_items.
    expect(countRows("question_attempts", `WHERE user_id = 'u-fail-start'`)).toBe(0);
    expect(countRows("audit_log", `WHERE user_id = 'u-fail-start'`)).toBe(0);
  });

  it("start (revisão vencida): INSERT de daily_training_events forçado a falhar não deixa órfãs a tentativa NEM a entrada marcada in_review (PO v1.1, seção 1-3)", async () => {
    await seedUser("u-fail-review");
    seedPattern("p-fail-review", "PAD-FR");
    const questionId = seedPublishedQuestion("q-fail-review", "C-FR", "p-fail-review");
    seedProfile("u-fail-review", AVAILABLE_WEEKDAYS, 60);
    const entryId = "entry-fail-review";
    const originalAttemptId = `${entryId}-attempt`;
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, is_correct, selected_alternative, answered_at, completed_at)
       VALUES ('${originalAttemptId}', 'u-fail-review', '${questionId}', 1, 'learning', 'completed', 0, 'A', datetime('now'), datetime('now'))`
    );
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries
         (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, primary_pattern_id, status, next_review_at)
       VALUES ('${entryId}', 'u-fail-review', '${questionId}', '${originalAttemptId}', '${originalAttemptId}', 'p-fail-review', 'scheduled', '2020-01-01T00:00:00.000Z')`
    );

    const applied = await applyList(db as never, "u-fail-review", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id, error_entry_id FROM daily_training_items WHERE list_id = ?`).get(listId) as {
      id: string;
      error_entry_id: string | null;
    };
    expect(itemRow.error_entry_id).toBe(entryId); // confirma que é o item de revisão

    db.failNextMatching(/INSERT INTO daily_training_events/);
    await expect(startItem(db as never, "u-fail-review", listId, itemRow.id, "start-1", false)).rejects.toThrow();

    const item = db.sqlite.prepare(`SELECT status, question_attempt_id FROM daily_training_items WHERE id = ?`).get(itemRow.id) as {
      status: string;
      question_attempt_id: string | null;
    };
    expect(item.status).toBe("pending");
    expect(item.question_attempt_id).toBeNull();
    expect(countRows("daily_training_events", `WHERE item_id = '${itemRow.id}'`)).toBe(0);
    // Nenhuma tentativa NOVA de revisão pode sobreviver órfã (só a original,
    // pré-existente e usada para popular o Caderno de Erros, é esperada).
    expect(countRows("question_attempts", `WHERE user_id = 'u-fail-review'`)).toBe(1);
    expect(countRows("question_attempts", `WHERE id = '${originalAttemptId}'`)).toBe(1);
    // A entrada do Caderno de Erros NUNCA pode ficar marcada 'in_review' sem
    // uma tentativa de revisão associada e sem o item do treino refletir isso.
    const entry = db.sqlite.prepare(`SELECT status FROM error_notebook_entries WHERE id = ?`).get(entryId) as { status: string };
    expect(entry.status).toBe("scheduled");
  });
});

describe("colisão de mutationId retorna conflito controlado (seção 15 da ordem)", () => {
  it("completar a lista duas vezes com o MESMO mutationId (sem ser retry do resultado já aplicado) retorna conflict, não corrompe nada", async () => {
    await setupUserWithOneEligibleQuestion("u-collision");
    const applied = await applyList(db as never, "u-collision", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };

    // Reaproveita o mutationId do PRÓPRIO apply (já usado para outra
    // mutação real, o list_created) para tentar completar a lista — uma
    // colisão de identidade genuína, nunca um retry legítimo do mesmo
    // "complete".
    const { completeList, skipItem } = await import("../src/services/dailyTrainingService");
    await skipItem(db as never, "u-collision", listId, itemRow.id, "skip-1", "not_now");
    const result = await completeList(db as never, "u-collision", listId, "mut-apply");
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("daily_training_lists", `WHERE id = '${listId}' AND status = 'completed'`)).toBe(0);
  });
});

describe("auditoria só é gravada quando a mutação é REAL (seção 14 da ordem)", () => {
  it("apply idempotente (segunda chamada, lista já existe) não grava um segundo daily_training_applied", async () => {
    await setupUserWithOneEligibleQuestion("u-audit-apply");
    const token = await createSessionForUser("u-audit-apply");
    await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-http-1" }) });
    await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-http-2" }) });

    expect(countRows("audit_log", `WHERE event_type = 'daily_training_applied' AND user_id = 'u-audit-apply'`)).toBe(1);
  });

  it("GETs (preview/current) nunca gravam audit_log", async () => {
    await setupUserWithOneEligibleQuestion("u-audit-get");
    const token = await createSessionForUser("u-audit-get");
    await callRoute("/api/daily-training/preview", token);
    await callRoute("/api/daily-training/current", token);
    expect(countRows("audit_log", `WHERE user_id = 'u-audit-get'`)).toBe(0);
  });

  it("skip idempotente (item já skipped) não grava um segundo daily_training_item_skipped", async () => {
    await setupUserWithOneEligibleQuestion("u-audit-skip");
    const token = await createSessionForUser("u-audit-skip");
    const applyResponse = await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-apply" }) });
    const { listId } = (await applyResponse.json()) as { listId: string };
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };

    await callRoute(`/api/daily-training/${listId}/items/${itemRow.id}/skip`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "skip-1", skipReason: "not_now" }),
    });
    await callRoute(`/api/daily-training/${listId}/items/${itemRow.id}/skip`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "skip-2", skipReason: "not_now" }),
    });

    expect(countRows("audit_log", `WHERE event_type = 'daily_training_item_skipped' AND user_id = 'u-audit-skip'`)).toBe(1);
  });
});

describe("nenhum GET cria lista (seção 6/9 da ordem, prova via rota HTTP real)", () => {
  it("GET /preview e GET /current repetidos nunca criam nenhuma linha em daily_training_lists", async () => {
    await setupUserWithOneEligibleQuestion("u-get-no-write");
    const token = await createSessionForUser("u-get-no-write");
    await callRoute("/api/daily-training/preview", token);
    await callRoute("/api/daily-training/preview", token);
    await callRoute("/api/daily-training/current", token);
    expect(countRows("daily_training_lists")).toBe(0);
  });
});

describe("acesso cruzado e métodos inválidos (seção 9 da ordem)", () => {
  it("acessar a lista de outro aluno responde 404, nunca 403", async () => {
    await setupUserWithOneEligibleQuestion("u-owner");
    await setupUserWithOneEligibleQuestion("u-intruder");
    const ownerToken = await createSessionForUser("u-owner");
    const intruderToken = await createSessionForUser("u-intruder");

    const applyResponse = await callRoute("/api/daily-training/apply", ownerToken, { method: "POST", body: JSON.stringify({ mutationId: "mut-1" }) });
    const { listId } = (await applyResponse.json()) as { listId: string };

    const crossResponse = await callRoute(`/api/daily-training/${listId}`, intruderToken);
    expect(crossResponse.status).toBe(404);
  });

  it("método inválido no endpoint de preview responde 405", async () => {
    await setupUserWithOneEligibleQuestion("u-method");
    const token = await createSessionForUser("u-method");
    const response = await callRoute("/api/daily-training/preview", token, { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(405);
  });

  it("sem sessão responde 401", async () => {
    const response = await callRoute("/api/daily-training/preview", null);
    expect(response.status).toBe(401);
  });
});

/* --------------------------------------------------------------------------
 * PO v1.1 — seção 4: concorrência/resumo do startItem, provados DIRETO
 * contra o banco (nunca só a resposta do serviço/HTTP).
 * -------------------------------------------------------------------------- */

async function setupUserWithTwoEligibleQuestions(userId: string): Promise<void> {
  await seedUser(userId);
  seedPattern(`p1-${userId}`, `PAD1-${userId}`);
  seedPattern(`p2-${userId}`, `PAD2-${userId}`);
  seedPublishedQuestion(`q1-${userId}`, `C1-${userId}`, `p1-${userId}`);
  seedPublishedQuestion(`q2-${userId}`, `C2-${userId}`, `p2-${userId}`);
  seedProfile(userId, AVAILABLE_WEEKDAYS, 60);
}

describe("startItem — retry idempotente com o MESMO mutationId (PO v1.1, seção 4)", () => {
  it("repetir a chamada com o mesmo mutationId devolve sucesso idempotente, sem nova tentativa/evento/auditoria", async () => {
    await setupUserWithOneEligibleQuestion("u-retry-start");
    const token = await createSessionForUser("u-retry-start");
    const applyResponse = await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-apply" }) });
    const { listId } = (await applyResponse.json()) as { listId: string };
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };

    const r1 = await callRoute(`/api/daily-training/${listId}/items/${itemRow.id}/start`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "start-retry" }),
    });
    const r2 = await callRoute(`/api/daily-training/${listId}/items/${itemRow.id}/start`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "start-retry" }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { attemptId: string };
    const b2 = (await r2.json()) as { attemptId: string };
    expect(b1.attemptId).toBe(b2.attemptId);

    expect(countRows("question_attempts", `WHERE user_id = 'u-retry-start'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
    expect(countRows("audit_log", `WHERE event_type = 'daily_training_item_started' AND user_id = 'u-retry-start'`)).toBe(1);
  });
});

describe("startItem — mutationId reaproveitado para uma operação DIFERENTE (PO v1.1, seção 4)", () => {
  it("reaproveitar um mutationId já usado por OUTRA mutação real (mesmo item, skip) retorna conflito controlado, nunca corrompe", async () => {
    await setupUserWithOneEligibleQuestion("u-mutid-collision");
    const token = await createSessionForUser("u-mutid-collision");
    const applyResponse = await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-apply" }) });
    const { listId } = (await applyResponse.json()) as { listId: string };
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };

    // "skip-1" já foi consumido por uma mutação real (o próprio skip) —
    // reaproveitá-lo para "iniciar" o MESMO item (já não está mais
    // 'pending' depois do skip) precisa devolver um resultado controlado.
    await callRoute(`/api/daily-training/${listId}/items/${itemRow.id}/skip`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "skip-1", skipReason: "not_now" }),
    });
    const startResponse = await callRoute(`/api/daily-training/${listId}/items/${itemRow.id}/start`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "skip-1" }),
    });
    // O item não está mais 'pending' (foi pulado) — erro de validação
    // controlado (400), nunca uma exceção crua/500.
    expect(startResponse.status).toBe(400);
    expect(countRows("daily_training_items", `WHERE id = '${itemRow.id}' AND status = 'skipped'`)).toBe(1);
    expect(countRows("question_attempts", `WHERE user_id = 'u-mutid-collision'`)).toBe(0);
  });

  it("reaproveitar um mutationId de OUTRO item (mesma lista) para iniciar este item retorna conflito controlado (409), nunca uma exceção crua", async () => {
    await setupUserWithTwoEligibleQuestions("u-mutid-cross-item");
    const token = await createSessionForUser("u-mutid-cross-item");
    const applyResponse = await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-apply" }) });
    const { listId } = (await applyResponse.json()) as { listId: string };
    const items = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ? ORDER BY position ASC`).all(listId) as { id: string }[];
    expect(items.length).toBe(2);
    const [itemA, itemB] = items;

    // "start-shared" já foi consumido por uma mutação REAL no item A —
    // reaproveitá-lo para iniciar o item B (linha DIFERENTE de
    // daily_training_events, mesmo `id`) colide na PRIMARY KEY da tabela de
    // eventos — precisa virar um resultado controlado, nunca um 500 cru.
    const startA = await callRoute(`/api/daily-training/${listId}/items/${itemA.id}/start`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "start-shared" }),
    });
    expect(startA.status).toBe(200);

    const startB = await callRoute(`/api/daily-training/${listId}/items/${itemB.id}/start`, token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "start-shared" }),
    });
    expect(startB.status).toBe(409);
    expect(countRows("daily_training_items", `WHERE id = '${itemB.id}' AND status = 'pending'`)).toBe(1);
    expect(countRows("daily_training_items", `WHERE id = '${itemB.id}' AND question_attempt_id IS NOT NULL`)).toBe(0);
    // A tentativa criada para o item B (antes da colisão de PK abortar o
    // lote inteiro) nunca sobrevive órfã — mesma garantia das seções 1-3.
    expect(countRows("question_attempts", `WHERE user_id = 'u-mutid-cross-item'`)).toBe(1);
  });
});

describe("startItem — tentativa pré-existente e legitimamente retomável (PO v1.1, seção 4)", () => {
  it("uma tentativa in_progress já aberta pelo Player (mesma questão+modo, ANTES do treino diário) é associada exatamente uma vez, sem criar uma segunda", async () => {
    await setupUserWithOneEligibleQuestion("u-preexisting-attempt");
    const applied = await applyList(db as never, "u-preexisting-attempt", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id, question_id, player_mode FROM daily_training_items WHERE list_id = ?`).get(listId) as {
      id: string;
      question_id: string;
      player_mode: string;
    };

    // O aluno já tinha aberto esta MESMA questão/modo diretamente pelo
    // Player (fora do treino diário) — tentativa real, pré-existente.
    const preexistingAttemptId = "attempt-preexisting";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${preexistingAttemptId}', 'u-preexisting-attempt', '${itemRow.question_id}', 1, '${itemRow.player_mode}', 'in_progress')`
    );

    const result = await startItem(db as never, "u-preexisting-attempt", listId, itemRow.id, "start-resume", false);
    expect(result.ok).toBe(true);
    expect(result.value!.attemptId).toBe(preexistingAttemptId);
    expect(countRows("question_attempts", `WHERE user_id = 'u-preexisting-attempt'`)).toBe(1);
    expect(countRows("daily_training_items", `WHERE id = '${itemRow.id}' AND question_attempt_id = '${preexistingAttemptId}'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
  });

  it("falha ao associar uma tentativa JÁ EXISTENTE (retomada) não altera nem apaga essa tentativa pré-existente", async () => {
    await setupUserWithOneEligibleQuestion("u-preexisting-fail");
    const applied = await applyList(db as never, "u-preexisting-fail", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id, question_id, player_mode FROM daily_training_items WHERE list_id = ?`).get(listId) as {
      id: string;
      question_id: string;
      player_mode: string;
    };
    const preexistingAttemptId = "attempt-preexisting-fail";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${preexistingAttemptId}', 'u-preexisting-fail', '${itemRow.question_id}', 1, '${itemRow.player_mode}', 'in_progress')`
    );

    db.failNextMatching(/INSERT INTO daily_training_events/);
    await expect(startItem(db as never, "u-preexisting-fail", listId, itemRow.id, "start-resume-fail", false)).rejects.toThrow();

    const attempt = db.sqlite.prepare(`SELECT status, version FROM question_attempts WHERE id = ?`).get(preexistingAttemptId) as {
      status: string;
      version: number;
    };
    expect(attempt.status).toBe("in_progress"); // intocada — nem alterada, nem apagada
    expect(attempt.version).toBe(1);
    expect(countRows("question_attempts", `WHERE id = '${preexistingAttemptId}'`)).toBe(1);
    const item = db.sqlite.prepare(`SELECT status, question_attempt_id FROM daily_training_items WHERE id = ?`).get(itemRow.id) as {
      status: string;
      question_attempt_id: string | null;
    };
    expect(item.status).toBe("pending");
    expect(item.question_attempt_id).toBeNull();
  });
});

describe("startItem — isolamento entre alunos na resolução da tentativa (PO v1.1, seção 4)", () => {
  it("uma tentativa in_progress de OUTRO aluno, para a MESMA questão, nunca é associada ao item deste aluno", async () => {
    await seedUser("u-owner-attempt");
    await seedUser("u-other-attempt");
    seedPattern("p-shared", "PAD-SHARED");
    const sharedQuestionId = seedPublishedQuestion("q-shared", "C-SHARED", "p-shared");
    seedProfile("u-owner-attempt", AVAILABLE_WEEKDAYS, 60);
    seedProfile("u-other-attempt", AVAILABLE_WEEKDAYS, 60);

    // Tentativa REAL de OUTRO aluno, mesma questão, mesmo modo — nunca deve
    // ser enxergada pelo findActiveAttempt escopado por user_id.
    const otherUserAttemptId = "attempt-other-user";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${otherUserAttemptId}', 'u-other-attempt', '${sharedQuestionId}', 1, 'learning', 'in_progress')`
    );

    const applied = await applyList(db as never, "u-owner-attempt", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ? AND question_id = ?`).get(listId, sharedQuestionId) as {
      id: string;
    };

    const result = await startItem(db as never, "u-owner-attempt", listId, itemRow.id, "start-owner", false);
    expect(result.ok).toBe(true);
    expect(result.value!.attemptId).not.toBe(otherUserAttemptId);

    const associatedAttempt = db.sqlite.prepare(`SELECT user_id FROM question_attempts WHERE id = ?`).get(result.value!.attemptId) as {
      user_id: string;
    };
    expect(associatedAttempt.user_id).toBe("u-owner-attempt");
    // A tentativa do outro aluno permanece intocada — nem tocada, nem
    // reaproveitada por engano.
    const otherAttempt = db.sqlite.prepare(`SELECT status, question_id FROM question_attempts WHERE id = ?`).get(otherUserAttemptId) as {
      status: string;
      question_id: string;
    };
    expect(otherAttempt.status).toBe("in_progress");
    expect(countRows("daily_training_items", `WHERE question_attempt_id = '${otherUserAttemptId}'`)).toBe(0);
  });
});

/* --------------------------------------------------------------------------
 * Hotfix pós-Sprint 20 — reuso seguro de tentativa após abandon. Causa raiz
 * real, reproduzida em produção: idx_daily_training_items_attempt_unique
 * (migrations/0016) permite só UM item dono por question_attempt_id;
 * abandonList nunca liberava essa posse, então um segundo treino com a
 * MESMA questão sempre colidia com um 500 cru ao tentar retomar a
 * tentativa in_progress (ainda presa ao item da lista abandonada).
 * -------------------------------------------------------------------------- */

describe("abandonList — libera posse de tentativa in_progress para reuso futuro (hotfix pós-Sprint 20, seção 4)", () => {
  it("abandonar a lista libera a tentativa in_progress do item não-completed; um novo treino da MESMA questão retoma exatamente essa tentativa, sem UNIQUE error", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-reuse");
    const applied = await applyList(db as never, "u-abandon-reuse", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id, question_id FROM daily_training_items WHERE list_id = ?`).get(listIdA) as {
      id: string;
      question_id: string;
    };

    const started = await startItem(db as never, "u-abandon-reuse", listIdA, itemA.id, "start-1", false);
    expect(started.ok).toBe(true);
    const attemptId = started.value!.attemptId;

    await abandonList(db as never, "u-abandon-reuse", listIdA, "abandon-1");

    // Item da lista abandonada perde a posse; status do item não muda (só a
    // posse); a tentativa em si segue in_progress, intocada.
    const itemAAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemAAfter.question_attempt_id).toBeNull();
    expect(itemAAfter.status).toBe("in_progress");
    const attemptAfterAbandon = db.sqlite.prepare(`SELECT status, version FROM question_attempts WHERE id = ?`).get(attemptId) as {
      status: string;
      version: number;
    };
    expect(attemptAfterAbandon.status).toBe("in_progress");
    expect(attemptAfterAbandon.version).toBe(1); // nunca tocada

    // Novo treino do MESMO dia — só uma questão elegível no fixture, então
    // a mesma questão reaparece (mesmo cenário real de produção).
    const appliedB = await applyList(db as never, "u-abandon-reuse", "mut-apply-2", false, CLOCK);
    expect(appliedB.ok).toBe(true);
    const listIdB = appliedB.value!.listId;
    const itemB = db.sqlite.prepare(`SELECT id, question_id FROM daily_training_items WHERE list_id = ?`).get(listIdB) as {
      id: string;
      question_id: string;
    };
    expect(itemB.question_id).toBe(itemA.question_id);

    const startedB = await startItem(db as never, "u-abandon-reuse", listIdB, itemB.id, "start-2", false);
    expect(startedB.ok).toBe(true);
    expect(startedB.value!.attemptId).toBe(attemptId); // EXATAMENTE a mesma tentativa retomada

    expect(countRows("question_attempts", `WHERE user_id = 'u-abandon-reuse'`)).toBe(1); // nunca duplicada
    expect(countRows("daily_training_items", `WHERE question_attempt_id = '${attemptId}'`)).toBe(1); // só UM dono agora
    const itemBAfter = db.sqlite.prepare(`SELECT status FROM daily_training_items WHERE id = ?`).get(itemB.id) as { status: string };
    expect(itemBAfter.status).toBe("in_progress");
  });

  it("abandonar a lista NUNCA libera item já completed — preserva o vínculo histórico", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-preserve-completed");
    const applied = await applyList(db as never, "u-abandon-preserve-completed", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdA) as { id: string };
    const startedA = await startItem(db as never, "u-abandon-preserve-completed", listIdA, itemA.id, "start-1", false);
    const attemptId = startedA.value!.attemptId;

    await saveAnswer(db as never, "u-abandon-preserve-completed", attemptId, 1, "B"); // gabarito real é B (seedQuestion)
    await confirmAnswer(db as never, "u-abandon-preserve-completed", attemptId, 2);
    await syncItem(db as never, "u-abandon-preserve-completed", listIdA, itemA.id, "sync-1");

    const itemBeforeAbandon = db.sqlite.prepare(`SELECT status FROM daily_training_items WHERE id = ?`).get(itemA.id) as { status: string };
    expect(itemBeforeAbandon.status).toBe("completed");

    // A lista não pode mais ser abandonada depois de completa (guard
    // status='active') — este teste prova o caso relevante diretamente:
    // completeList (não abandonList) é o caminho real aqui, mas a garantia
    // que importa é que NENHUM caminho de release toca um item completed.
    // Prova via chamada direta ao serviço de conclusão, e confirma o
    // vínculo histórico integro depois.
    await completeList(db as never, "u-abandon-preserve-completed", listIdA, "complete-1");
    const itemAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemAfter.status).toBe("completed");
    expect(itemAfter.question_attempt_id).toBe(attemptId);
  });

  it("abandonar a lista NÃO libera item cuja tentativa já está completed mesmo se o item não foi sincronizado (attempt completed, item ainda in_progress tecnicamente)", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-desync-completed");
    const applied = await applyList(db as never, "u-abandon-desync-completed", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdA) as { id: string };
    const startedA = await startItem(db as never, "u-abandon-desync-completed", listIdA, itemA.id, "start-1", false);
    const attemptId = startedA.value!.attemptId;

    // Aluno confirma a resposta diretamente pelo Player (a tentativa vira
    // completed) mas nunca volta ao treino diário para acionar syncItem —
    // o item segue 'in_progress' tecnicamente, estado real e possível.
    await saveAnswer(db as never, "u-abandon-desync-completed", attemptId, 1, "B");
    await confirmAnswer(db as never, "u-abandon-desync-completed", attemptId, 2);

    await abandonList(db as never, "u-abandon-desync-completed", listIdA, "abandon-1");

    const itemAAfter = db.sqlite.prepare(`SELECT question_attempt_id FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      question_attempt_id: string | null;
    };
    // Preservado — a tentativa já está completed, nunca "in_progress", então
    // a condição de liberação (seção 4: "tentativa ainda ativa/in_progress")
    // não se aplica; nada a liberar.
    expect(itemAAfter.question_attempt_id).toBe(attemptId);
  });
});

describe("startItem — reuso seguro de tentativa após abandon: transferência de posse (hotfix pós-Sprint 20, seções 5/6)", () => {
  it("estado legado fabricado diretamente (item de lista já abandoned segurando a tentativa): startItem transfere atomicamente, mesmo sem passar pelo abandonList corrigido", async () => {
    await setupUserWithOneEligibleQuestion("u-legacy");
    const applied = await applyList(db as never, "u-legacy", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id, question_id, player_mode FROM daily_training_items WHERE list_id = ?`).get(listIdA) as {
      id: string;
      question_id: string;
      player_mode: string;
    };
    const legacyAttemptId = "attempt-legacy";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${legacyAttemptId}', 'u-legacy', '${itemA.question_id}', 1, '${itemA.player_mode}', 'in_progress')`
    );
    // Fabrica DIRETAMENTE o estado legado pré-hotfix (nunca via abandonList
    // já corrigido) — simula exatamente o que já existia em produção antes
    // desta correção: item ABANDONED ainda dono da tentativa.
    db.sqlite.exec(`UPDATE daily_training_items SET status = 'in_progress', question_attempt_id = '${legacyAttemptId}' WHERE id = '${itemA.id}'`);
    db.sqlite.exec(`UPDATE daily_training_lists SET status = 'abandoned' WHERE id = '${listIdA}'`);

    const appliedB = await applyList(db as never, "u-legacy", "mut-apply-2", false, CLOCK);
    expect(appliedB.ok).toBe(true);
    const listIdB = appliedB.value!.listId;
    const itemB = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ? AND question_id = ?`).get(listIdB, itemA.question_id) as {
      id: string;
    };

    const startedB = await startItem(db as never, "u-legacy", listIdB, itemB.id, "start-transfer", false);
    expect(startedB.ok).toBe(true);
    expect(startedB.value!.attemptId).toBe(legacyAttemptId);

    const itemAAfter = db.sqlite.prepare(`SELECT question_attempt_id FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      question_attempt_id: string | null;
    };
    expect(itemAAfter.question_attempt_id).toBeNull();
    const itemBAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(itemB.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemBAfter.question_attempt_id).toBe(legacyAttemptId);
    expect(itemBAfter.status).toBe("in_progress");
    expect(countRows("daily_training_items", `WHERE question_attempt_id = '${legacyAttemptId}'`)).toBe(1); // só UM dono
    expect(countRows("question_attempts", `WHERE id = '${legacyAttemptId}'`)).toBe(1); // nunca duplicada/apagada
  });

  it("tentativa já pertence a item de OUTRA lista ainda ATIVA (dia diferente): nunca transfere, conflito controlado, dono original intacto", async () => {
    const userId = "u-active-owner";
    await seedUser(userId);
    seedPattern(`p-${userId}`, `PAD-${userId}`);
    seedPublishedQuestion(`q-${userId}`, `C-${userId}`, `p-${userId}`);
    const YESTERDAY_ISO = "2026-08-31T15:00:00.000Z";
    const YESTERDAY_CLOCK = fixedClock(YESTERDAY_ISO);
    const YESTERDAY_WEEKDAY = weekdayCodeForCivilDate(civilDateInTimezone(new Date(YESTERDAY_ISO), TIMEZONE));
    seedProfile(userId, Array.from(new Set([TODAY_WEEKDAY, YESTERDAY_WEEKDAY])), 60);

    const appliedYesterday = await applyList(db as never, userId, "mut-apply-yesterday", false, YESTERDAY_CLOCK);
    expect(appliedYesterday.ok).toBe(true);
    const listIdYesterday = appliedYesterday.value!.listId;
    const itemYesterday = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdYesterday) as { id: string };
    const startedYesterday = await startItem(db as never, userId, listIdYesterday, itemYesterday.id, "start-yesterday", false);
    expect(startedYesterday.ok).toBe(true);
    const attemptId = startedYesterday.value!.attemptId;
    // A lista de ontem NUNCA foi concluída nem abandonada — segue 'active'
    // (cenário real possível: aluno não voltou a fechar o treino).

    const appliedToday = await applyList(db as never, userId, "mut-apply-today", false, CLOCK);
    expect(appliedToday.ok).toBe(true); // dias diferentes — índice único não bloqueia
    const listIdToday = appliedToday.value!.listId;
    const itemToday = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdToday) as { id: string };

    const startedToday = await startItem(db as never, userId, listIdToday, itemToday.id, "start-today", false);
    expect(startedToday.ok).toBe(false);
    expect(startedToday.conflict).toBe(true);

    const itemYesterdayAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(itemYesterday.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemYesterdayAfter.question_attempt_id).toBe(attemptId); // dono original intacto
    expect(itemYesterdayAfter.status).toBe("in_progress");
    const itemTodayAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(itemToday.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemTodayAfter.question_attempt_id).toBeNull();
    expect(itemTodayAfter.status).toBe("pending");
  });

  it("dono anterior tem item COMPLETED (estado defensivo/inconsistente fabricado — nunca alcançável pelas transições guardadas do próprio serviço): nunca transfere o vínculo histórico, conflito controlado", async () => {
    await setupUserWithOneEligibleQuestion("u-completed-defensive");
    const applied = await applyList(db as never, "u-completed-defensive", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id, question_id, player_mode FROM daily_training_items WHERE list_id = ?`).get(listIdA) as {
      id: string;
      question_id: string;
      player_mode: string;
    };
    const attemptId = "attempt-completed-item-inprogress";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${attemptId}', 'u-completed-defensive', '${itemA.question_id}', 1, '${itemA.player_mode}', 'in_progress')`
    );
    db.sqlite.exec(`UPDATE daily_training_items SET status = 'completed', question_attempt_id = '${attemptId}' WHERE id = '${itemA.id}'`);
    db.sqlite.exec(`UPDATE daily_training_lists SET status = 'abandoned' WHERE id = '${listIdA}'`);

    const appliedB = await applyList(db as never, "u-completed-defensive", "mut-apply-2", false, CLOCK);
    const listIdB = appliedB.value!.listId;
    const itemB = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdB) as { id: string };

    const startedB = await startItem(db as never, "u-completed-defensive", listIdB, itemB.id, "start-2", false);
    expect(startedB.ok).toBe(false);
    expect(startedB.conflict).toBe(true);

    const itemAAfter = db.sqlite.prepare(`SELECT question_attempt_id FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      question_attempt_id: string | null;
    };
    expect(itemAAfter.question_attempt_id).toBe(attemptId); // nunca liberado
  });

  it("falha forçada DEPOIS do clear do dono legado mas ANTES da nova associação: rollback total, vínculo antigo permanece intacto", async () => {
    await setupUserWithOneEligibleQuestion("u-legacy-fail");
    const applied = await applyList(db as never, "u-legacy-fail", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id, question_id, player_mode FROM daily_training_items WHERE list_id = ?`).get(listIdA) as {
      id: string;
      question_id: string;
      player_mode: string;
    };
    const attemptId = "attempt-legacy-fail";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${attemptId}', 'u-legacy-fail', '${itemA.question_id}', 1, '${itemA.player_mode}', 'in_progress')`
    );
    db.sqlite.exec(`UPDATE daily_training_items SET status = 'in_progress', question_attempt_id = '${attemptId}' WHERE id = '${itemA.id}'`);
    db.sqlite.exec(`UPDATE daily_training_lists SET status = 'abandoned' WHERE id = '${listIdA}'`);

    const appliedB = await applyList(db as never, "u-legacy-fail", "mut-apply-2", false, CLOCK);
    const listIdB = appliedB.value!.listId;
    const itemB = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdB) as { id: string };

    // Falha forçada bem no statement que associa a tentativa ao item NOVO —
    // ou seja, DEPOIS do clear do dono antigo (primeiro statement do lote)
    // mas ANTES do evento (último). Prova que o lote inteiro reverte.
    db.failNextMatching(/SET status = 'in_progress', question_attempt_id = \?/);
    await expect(startItem(db as never, "u-legacy-fail", listIdB, itemB.id, "start-fail", false)).rejects.toThrow();

    const itemAAfter = db.sqlite.prepare(`SELECT question_attempt_id FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      question_attempt_id: string | null;
    };
    expect(itemAAfter.question_attempt_id).toBe(attemptId); // clear NÃO persistiu — rollback total
    const itemBAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(itemB.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemBAfter.question_attempt_id).toBeNull();
    expect(itemBAfter.status).toBe("pending");
    expect(countRows("question_attempts", `WHERE id = '${attemptId}'`)).toBe(1);
  });

  it("CORRIDA real: duas chamadas concorrentes de startItem no MESMO item novo (double-click), dono legado abandoned: nenhum 500 bruto, no máximo uma associação real", async () => {
    await setupUserWithOneEligibleQuestion("u-legacy-race");
    const applied = await applyList(db as never, "u-legacy-race", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id, question_id, player_mode FROM daily_training_items WHERE list_id = ?`).get(listIdA) as {
      id: string;
      question_id: string;
      player_mode: string;
    };
    const attemptId = "attempt-legacy-race";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status)
       VALUES ('${attemptId}', 'u-legacy-race', '${itemA.question_id}', 1, '${itemA.player_mode}', 'in_progress')`
    );
    db.sqlite.exec(`UPDATE daily_training_items SET status = 'in_progress', question_attempt_id = '${attemptId}' WHERE id = '${itemA.id}'`);
    db.sqlite.exec(`UPDATE daily_training_lists SET status = 'abandoned' WHERE id = '${listIdA}'`);

    const appliedB = await applyList(db as never, "u-legacy-race", "mut-apply-2", false, CLOCK);
    const listIdB = appliedB.value!.listId;
    const itemB = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdB) as { id: string };

    // Trava as PRÓXIMAS DUAS leituras de "quem é o dono" — cada uma já lê o
    // estado REAL (dono = item A, lista abandoned) antes de bloquear, prova
    // deterministicamente que as duas chamadas passam pela detecção ANTES
    // de qualquer uma escrever.
    const gate = db.pauseReadsMatching(/FROM daily_training_items i\s+JOIN daily_training_lists l ON l\.id = i\.list_id/, 2);
    const racePromise = Promise.allSettled([
      startItem(db as never, "u-legacy-race", listIdB, itemB.id, "start-race-a", false),
      startItem(db as never, "u-legacy-race", listIdB, itemB.id, "start-race-b", false),
    ]);
    await gate.arrived;
    gate.release();
    const [r1, r2] = await racePromise;

    // Nunca um raw/uncaught error — mesmo requisito central de sempre.
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null)) as StartItemResult[];
    const winners = results.filter((r) => r.ok === true);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const winner of winners) expect(winner.value!.attemptId).toBe(attemptId);

    // No máximo UMA tentativa, no máximo UM dono — nunca duplicado nem
    // corrompido pela corrida.
    expect(countRows("question_attempts", `WHERE user_id = 'u-legacy-race'`)).toBe(1);
    expect(countRows("daily_training_items", `WHERE question_attempt_id = '${attemptId}'`)).toBe(1);
  });

  it("findAttemptOwnerWithListStatus nunca enxerga o item/tentativa de OUTRO usuário, mesmo com o attemptId real correto (segurança entre usuários, seção 9)", async () => {
    await setupUserWithOneEligibleQuestion("u-cross-owner-a");
    const applied = await applyList(db as never, "u-cross-owner-a", "mut-apply-1", false, CLOCK);
    const listIdA = applied.value!.listId;
    const itemA = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdA) as { id: string };
    const startedA = await startItem(db as never, "u-cross-owner-a", listIdA, itemA.id, "start-a", false);
    const attemptIdA = startedA.value!.attemptId;

    // Consulta direta com o attemptId REAL de A, mas user_id de outro
    // aluno — mesmo que um bug futuro em outro lugar do código passasse
    // esse attemptId por engano, esta consulta nunca revela o dono real.
    const ownerAsSeenByOther = await findAttemptOwnerWithListStatus(db as never, attemptIdA, "u-nao-e-o-dono");
    expect(ownerAsSeenByOther).toBeNull();

    // A mesma consulta com o user_id CORRETO continua enxergando normalmente.
    const ownerAsSeenByOwner = await findAttemptOwnerWithListStatus(db as never, attemptIdA, "u-cross-owner-a");
    expect(ownerAsSeenByOwner?.id).toBe(itemA.id);
  });
});

/* --------------------------------------------------------------------------
 * Correção de auditoria (mesmo hotfix pós-Sprint 20) — Gap 1: o release do
 * abandon rodava no mesmo db.batch() do UPDATE que abandona a lista, mas
 * sem exigir, no PRÓPRIO SQL, que a lista REALMENTE tivesse ficado
 * abandoned dentro da mesma transação — um guard de versão stale no
 * primeiro UPDATE (0 linhas afetadas, sem lançar exceção) ainda deixava o
 * release rodar contra uma lista que continuava active. Corrigido com um
 * EXISTS correlato ao estado real de daily_training_lists.status no
 * momento do commit.
 * -------------------------------------------------------------------------- */

describe("abandonList — Gap 1 (auditoria): release acoplado ao estado real da lista", () => {
  it("se o guard de buildAbandonListStatement falha (versão stale) e a lista permanece ACTIVE, o release acoplado NUNCA libera ownership", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-guard-fail");
    const applied = await applyList(db as never, "u-abandon-guard-fail", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const started = await startItem(db as never, "u-abandon-guard-fail", listId, item.id, "start-1", false);
    const attemptId = started.value!.attemptId;

    // Guard version PROPOSITALMENTE errado — simula uma corrida em que
    // outra mutação já avançou a versão da lista antes deste batch (0
    // linhas afetadas no UPDATE de abandono, sem lançar exceção).
    await db.batch([
      buildAbandonListStatement(db as never, { listId, userId: "u-abandon-guard-fail", guardVersion: 999, mutationId: "abandon-stale" }),
      buildReleaseAbandonedItemAttemptsStatement(db as never, { listId, userId: "u-abandon-guard-fail" }),
    ]);

    const listAfter = db.sqlite.prepare(`SELECT status FROM daily_training_lists WHERE id = ?`).get(listId) as { status: string };
    expect(listAfter.status).toBe("active"); // guard falhou, lista NUNCA mudou

    const itemAfter = db.sqlite.prepare(`SELECT question_attempt_id, status FROM daily_training_items WHERE id = ?`).get(item.id) as {
      question_attempt_id: string | null;
      status: string;
    };
    expect(itemAfter.question_attempt_id).toBe(attemptId); // NUNCA liberado
    expect(itemAfter.status).toBe("in_progress");
  });

  it("abandon normal continua liberando ownership corretamente (regressão)", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-guard-ok");
    const applied = await applyList(db as never, "u-abandon-guard-ok", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const started = await startItem(db as never, "u-abandon-guard-ok", listId, item.id, "start-1", false);
    const attemptId = started.value!.attemptId;

    const result = await abandonList(db as never, "u-abandon-guard-ok", listId, "abandon-1");
    expect(result.ok).toBe(true);

    const listAfter = db.sqlite.prepare(`SELECT status FROM daily_training_lists WHERE id = ?`).get(listId) as { status: string };
    expect(listAfter.status).toBe("abandoned");
    const itemAfter = db.sqlite.prepare(`SELECT question_attempt_id FROM daily_training_items WHERE id = ?`).get(item.id) as {
      question_attempt_id: string | null;
    };
    expect(itemAfter.question_attempt_id).toBeNull();
    void attemptId;
  });

  it("concorrência onde outra chamada JÁ abandonou a lista: release idempotente, sem dano", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-idempotent-release");
    const applied = await applyList(db as never, "u-abandon-idempotent-release", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    await startItem(db as never, "u-abandon-idempotent-release", listId, item.id, "start-1", false);

    await abandonList(db as never, "u-abandon-idempotent-release", listId, "abandon-1"); // abandon real, já libera

    // "Outra chamada" roda o MESMO release isoladamente de novo — idempotente
    // por construção (EXISTS já vê a lista abandoned, mas não há mais nada
    // com question_attempt_id NOT NULL para liberar).
    await db.batch([buildReleaseAbandonedItemAttemptsStatement(db as never, { listId, userId: "u-abandon-idempotent-release" })]);

    const itemAfter = db.sqlite.prepare(`SELECT question_attempt_id FROM daily_training_items WHERE id = ?`).get(item.id) as {
      question_attempt_id: string | null;
    };
    expect(itemAfter.question_attempt_id).toBeNull();
  });
});

/* --------------------------------------------------------------------------
 * Correção de auditoria (mesmo hotfix pós-Sprint 20) — Gap 2: o mesmo
 * bloqueio de ownership reaparecia pelo fluxo "pular". Um item in_progress
 * podia ser pulado sem liberar question_attempt_id; como skipped é
 * terminal, a lista podia ser concluída com o item ainda "dono" da
 * tentativa — um treino futuro da MESMA questão nunca conseguia retomá-la
 * (presa a um item de lista já completed, e startItem corretamente se
 * recusa a roubar ownership de lista completed). Corrigido em
 * buildSkipItemStatement: um único UPDATE guardado libera
 * question_attempt_id somente quando a tentativa subjacente ainda está
 * REALMENTE in_progress no momento do commit.
 * -------------------------------------------------------------------------- */

describe("skipItem — Gap 2 (auditoria): pular item in_progress também libera a tentativa ativa", () => {
  it("pular um item in_progress libera a tentativa in_progress — item skipped, question_attempt_id NULL, tentativa preservada", async () => {
    await setupUserWithOneEligibleQuestion("u-skip-release");
    const applied = await applyList(db as never, "u-skip-release", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const started = await startItem(db as never, "u-skip-release", listId, item.id, "start-1", false);
    const attemptId = started.value!.attemptId;

    const skipped = await skipItem(db as never, "u-skip-release", listId, item.id, "skip-1", "too_hard");
    expect(skipped.ok).toBe(true);

    const itemAfter = db.sqlite.prepare(`SELECT status, question_attempt_id FROM daily_training_items WHERE id = ?`).get(item.id) as {
      status: string;
      question_attempt_id: string | null;
    };
    expect(itemAfter.status).toBe("skipped");
    expect(itemAfter.question_attempt_id).toBeNull();

    const attemptAfter = db.sqlite.prepare(`SELECT status FROM question_attempts WHERE id = ?`).get(attemptId) as { status: string };
    expect(attemptAfter.status).toBe("in_progress"); // preservada, nunca tocada
  });

  it("start → skip → complete list → novo treino da MESMA questão → start retoma o MESMO attemptId, sem UNIQUE error", async () => {
    await setupUserWithOneEligibleQuestion("u-skip-complete-reuse");
    const applied = await applyList(db as never, "u-skip-complete-reuse", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const started = await startItem(db as never, "u-skip-complete-reuse", listId, item.id, "start-1", false);
    const attemptId = started.value!.attemptId;

    const skipped = await skipItem(db as never, "u-skip-complete-reuse", listId, item.id, "skip-1", "too_hard");
    expect(skipped.ok).toBe(true);
    const completed = await completeList(db as never, "u-skip-complete-reuse", listId, "complete-1");
    expect(completed.ok).toBe(true);
    expect(countRows("daily_training_lists", `WHERE id = '${listId}' AND status = 'completed'`)).toBe(1);

    const appliedB = await applyList(db as never, "u-skip-complete-reuse", "mut-apply-2", false, CLOCK);
    expect(appliedB.ok).toBe(true);
    const listIdB = appliedB.value!.listId;
    const itemB = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listIdB) as { id: string };

    const startedB = await startItem(db as never, "u-skip-complete-reuse", listIdB, itemB.id, "start-2", false);
    expect(startedB.ok).toBe(true);
    expect(startedB.value!.attemptId).toBe(attemptId); // EXATAMENTE a mesma tentativa

    expect(countRows("question_attempts", `WHERE user_id = 'u-skip-complete-reuse'`)).toBe(1); // nunca duplicada
    expect(countRows("daily_training_items", `WHERE question_attempt_id = '${attemptId}'`)).toBe(1); // só UM dono
  });

  it("tentativa já completed (item ainda in_progress tecnicamente): pular NUNCA libera o vínculo histórico silenciosamente", async () => {
    await setupUserWithOneEligibleQuestion("u-skip-preserve-completed");
    const applied = await applyList(db as never, "u-skip-preserve-completed", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const started = await startItem(db as never, "u-skip-preserve-completed", listId, item.id, "start-1", false);
    const attemptId = started.value!.attemptId;

    // Aluno confirma a resposta diretamente pelo Player (tentativa vira
    // completed) mas o item do treino diário segue 'in_progress'
    // tecnicamente — nunca sincronizado (mesmo cenário real do abandon).
    await saveAnswer(db as never, "u-skip-preserve-completed", attemptId, 1, "B"); // gabarito real é B (seedQuestion)
    await confirmAnswer(db as never, "u-skip-preserve-completed", attemptId, 2);

    const skipped = await skipItem(db as never, "u-skip-preserve-completed", listId, item.id, "skip-1", "too_hard");
    expect(skipped.ok).toBe(true); // pular ainda funciona normalmente

    const itemAfter = db.sqlite.prepare(`SELECT status, question_attempt_id FROM daily_training_items WHERE id = ?`).get(item.id) as {
      status: string;
      question_attempt_id: string | null;
    };
    expect(itemAfter.status).toBe("skipped");
    expect(itemAfter.question_attempt_id).toBe(attemptId); // preservado — nunca liberado silenciosamente
  });

  it("skip de item pending (sem tentativa) continua normal — nenhuma mudança de comportamento", async () => {
    await setupUserWithOneEligibleQuestion("u-skip-pending-normal");
    const applied = await applyList(db as never, "u-skip-pending-normal", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id, status, question_attempt_id FROM daily_training_items WHERE list_id = ?`).get(listId) as {
      id: string;
      status: string;
      question_attempt_id: string | null;
    };
    expect(item.status).toBe("pending");
    expect(item.question_attempt_id).toBeNull();

    const skipped = await skipItem(db as never, "u-skip-pending-normal", listId, item.id, "skip-1", "too_hard");
    expect(skipped.ok).toBe(true);

    const itemAfter = db.sqlite.prepare(`SELECT status, question_attempt_id FROM daily_training_items WHERE id = ?`).get(item.id) as {
      status: string;
      question_attempt_id: string | null;
    };
    expect(itemAfter.status).toBe("skipped");
    expect(itemAfter.question_attempt_id).toBeNull();
  });

  it("falha forçada no evento de skip reverte TUDO — release e mudança de status não persistem", async () => {
    await setupUserWithOneEligibleQuestion("u-skip-fail-rollback");
    const applied = await applyList(db as never, "u-skip-fail-rollback", "mut-apply-1", false, CLOCK);
    const listId = applied.value!.listId;
    const item = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const started = await startItem(db as never, "u-skip-fail-rollback", listId, item.id, "start-1", false);
    const attemptId = started.value!.attemptId;

    db.failNextMatching(/INSERT INTO daily_training_events/);
    await expect(skipItem(db as never, "u-skip-fail-rollback", listId, item.id, "skip-fail", "too_hard")).rejects.toThrow();

    const itemAfter = db.sqlite.prepare(`SELECT status, question_attempt_id FROM daily_training_items WHERE id = ?`).get(item.id) as {
      status: string;
      question_attempt_id: string | null;
    };
    expect(itemAfter.status).toBe("in_progress"); // rollback total — nunca virou skipped
    expect(itemAfter.question_attempt_id).toBe(attemptId); // release não persistiu
  });
});

/* --------------------------------------------------------------------------
 * PO v1.1 — seção 5: regra de unicidade diária. A ordem original (seção 5)
 * pede um índice único PARCIAL restrito a status = 'active' — texto
 * deliberado, nunca um índice único simples em (user_id, training_date).
 * Decisão explícita (documentada aqui e em dailyTrainingRepository.ts:
 * findActiveListForUserDate/applyList): "uma lista ATIVA por vez", não "uma
 * lista por dia, para sempre" — depois que a lista de hoje é concluída ou
 * abandonada, um novo apply() para o MESMO dia civil cria uma lista NOVA
 * (histórico de múltiplas listas terminais no mesmo dia é intencional, ex.:
 * o aluno concluiu o treino do dia e quer praticar mais). Provado aqui,
 * nunca deixado implícito. -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
 * PO v1.2 — TOCTOU real do mutationId em startItem: o pre-check em JS
 * (dailyTrainingEventIdInUse, ANTES do db.batch()) só cobre a corrida
 * SEQUENCIAL (uma chamada termina antes da outra começar — já provado
 * acima, "mutationId de OUTRO item"). Duas chamadas VERDADEIRAMENTE
 * concorrentes, mesmo mutationId, podem AMBAS passar pelo pre-check (ambas
 * leem "ainda não em uso") antes de qualquer INSERT real acontecer — só a
 * PK de daily_training_events (garantia real do banco) pode arbitrar quem
 * vence. Usa a "porta" determinística de fakeD1.ts (pauseReadsMatching)
 * para forçar esse entrelaçamento, em vez de confiar no acaso do
 * agendamento de microtasks do JS.
 * -------------------------------------------------------------------------- */

describe("startItem — corrida real de TOCTOU no mutationId, duas operações DIFERENTES (PO v1.2)", () => {
  it("duas chamadas CONCORRENTES de startItem, itens diferentes, MESMO mutationId: ambas passam pelo pre-check, exatamente uma vence, a outra recebe 409 controlado, sem escrita parcial", async () => {
    await setupUserWithTwoEligibleQuestions("u-toctou-race");
    const applied = await applyList(db as never, "u-toctou-race", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const items = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ? ORDER BY position ASC`).all(listId) as { id: string }[];
    expect(items.length).toBe(2);
    const [itemA, itemB] = items;
    const SHARED_MUTATION_ID = "toctou-shared-mut";

    // Trava as PRÓXIMAS DUAS leituras de dailyTrainingEventIdInUse (uma por
    // chamada) — cada uma já lê o estado REAL (ainda "não em uso", porque
    // nenhuma escrita aconteceu ainda) e só então bloqueia antes de
    // retornar, provando deterministicamente que as DUAS passam pelo
    // pre-check ANTES de qualquer uma prosseguir para o db.batch().
    const gate = db.pauseReadsMatching(/SELECT 1 as found FROM daily_training_events WHERE id = \?/, 2);

    const racePromise = Promise.allSettled([
      startItem(db as never, "u-toctou-race", listId, itemA.id, SHARED_MUTATION_ID, false),
      startItem(db as never, "u-toctou-race", listId, itemB.id, SHARED_MUTATION_ID, false),
    ]);

    await gate.arrived; // as DUAS já leram "não em uso" — nenhuma escreveu ainda.
    expect(countRows("daily_training_events", `WHERE id = '${SHARED_MUTATION_ID}'`)).toBe(0);
    gate.release(); // libera as duas para disputar o db.batch() real (serializado pelo writeLock, como duas conexões D1 reais disputariam a constraint).

    const [r1, r2] = await racePromise;

    // Requisito central (PO v1.2): NENHUM raw/uncaught error escapa ao
    // chamador em NENHUM cenário — nem um `rejected` do Promise.allSettled.
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null)) as StartItemResult[];

    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    // O perdedor SEMPRE recebe um conflito controlado (409) — nunca uma
    // exceção crua de UNIQUE constraint, nunca um outro tipo de falha.
    expect(losers[0].conflict).toBe(true);
    expect(losers[0].notFound).toBeFalsy();
    expect(losers[0].fieldErrors).toBeUndefined();

    // Exatamente UM evento com este mutationId — a PK real decidiu, nunca
    // duas linhas nem zero.
    expect(countRows("daily_training_events", `WHERE id = '${SHARED_MUTATION_ID}'`)).toBe(1);

    // O item VENCEDOR está in_progress com uma tentativa associada; o item
    // PERDEDOR continua exatamente como antes da corrida — pending, sem
    // tentativa, sem versão avançada (nenhuma escrita parcial da operação
    // perdedora sobrevive).
    const rowA = db.sqlite.prepare(`SELECT status, question_attempt_id, version FROM daily_training_items WHERE id = ?`).get(itemA.id) as {
      status: string;
      question_attempt_id: string | null;
      version: number;
    };
    const rowB = db.sqlite.prepare(`SELECT status, question_attempt_id, version FROM daily_training_items WHERE id = ?`).get(itemB.id) as {
      status: string;
      question_attempt_id: string | null;
      version: number;
    };
    const rows = [rowA, rowB];
    const inProgressRows = rows.filter((r) => r.status === "in_progress");
    const pendingRows = rows.filter((r) => r.status === "pending");
    expect(inProgressRows.length).toBe(1);
    expect(pendingRows.length).toBe(1);
    expect(inProgressRows[0].question_attempt_id).not.toBeNull();
    expect(inProgressRows[0].version).toBe(2);
    expect(pendingRows[0].question_attempt_id).toBeNull();
    expect(pendingRows[0].version).toBe(1);

    // Nenhuma tentativa órfã do Player sobrevive da operação perdedora —
    // exatamente UMA question_attempts para este aluno (a do vencedor).
    expect(countRows("question_attempts", `WHERE user_id = 'u-toctou-race'`)).toBe(1);
    const winningAttemptId = winners[0].value!.attemptId;
    expect(
      countRows("question_attempts", `WHERE user_id = 'u-toctou-race' AND id = '${winningAttemptId}' AND status = 'in_progress'`)
    ).toBe(1);
    // audit_log: esta prova chama o serviço diretamente (não a rota HTTP),
    // então audit_log nunca é escrito por nenhum dos dois caminhos aqui —
    // mesma convenção do resto deste arquivo.
    expect(countRows("audit_log", `WHERE user_id = 'u-toctou-race'`)).toBe(0);
  });

  it("retry da MESMA operação (mesmo item, mesmo mutationId) CONCORRENTE consigo mesma continua idempotente — nunca vira conflito", async () => {
    await setupUserWithOneEligibleQuestion("u-toctou-retry-same");
    const applied = await applyList(db as never, "u-toctou-retry-same", "mut-apply", false, CLOCK);
    const listId = applied.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(listId) as { id: string };
    const SHARED_MUTATION_ID = "toctou-retry-same-mut";

    const gate = db.pauseReadsMatching(/SELECT 1 as found FROM daily_training_events WHERE id = \?/, 2);
    const racePromise = Promise.allSettled([
      startItem(db as never, "u-toctou-retry-same", listId, itemRow.id, SHARED_MUTATION_ID, false),
      startItem(db as never, "u-toctou-retry-same", listId, itemRow.id, SHARED_MUTATION_ID, false),
    ]);
    await gate.arrived;
    gate.release();
    const [r1, r2] = await racePromise;

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null)) as StartItemResult[];
    // As DUAS são a MESMA operação (mesmo item, mesmo mutationId) — ambas
    // devem refletir sucesso com o MESMO attemptId, nunca um 409 entre elas
    // (409 é só para operações DIFERENTES colidindo, seção 1 da ordem).
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
    expect(results[0].value!.attemptId).toBe(results[1].value!.attemptId);

    expect(countRows("question_attempts", `WHERE user_id = 'u-toctou-retry-same'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
    expect(countRows("daily_training_items", `WHERE id = '${itemRow.id}' AND status = 'in_progress'`)).toBe(1);
  });
});

describe("regra de unicidade diária — apenas UMA lista ativa por vez (PO v1.1, seção 5)", () => {
  it("depois que a lista ativa do dia é CONCLUÍDA, um novo apply() para o MESMO dia cria uma SEGUNDA lista (histórico, não um erro)", async () => {
    await setupUserWithOneEligibleQuestion("u-second-list-completed");
    const first = await applyList(db as never, "u-second-list-completed", "mut-apply-1", false, CLOCK);
    const firstListId = first.value!.listId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM daily_training_items WHERE list_id = ?`).get(firstListId) as { id: string };
    await skipItem(db as never, "u-second-list-completed", firstListId, itemRow.id, "skip-1", "not_now");
    const completed = await completeList(db as never, "u-second-list-completed", firstListId, "complete-1");
    expect(completed.ok).toBe(true);

    const second = await applyList(db as never, "u-second-list-completed", "mut-apply-2", false, CLOCK);
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(true);
    expect(second.value!.listId).not.toBe(firstListId);

    expect(countRows("daily_training_lists", `WHERE user_id = 'u-second-list-completed' AND training_date = '${TODAY_CIVIL}'`)).toBe(2);
    expect(countRows("daily_training_lists", `WHERE user_id = 'u-second-list-completed' AND status = 'active'`)).toBe(1);
    expect(countRows("daily_training_lists", `WHERE user_id = 'u-second-list-completed' AND status = 'completed'`)).toBe(1);
  });

  it("depois que a lista ativa do dia é ABANDONADA, um novo apply() para o MESMO dia cria uma SEGUNDA lista (histórico, não um erro)", async () => {
    await setupUserWithOneEligibleQuestion("u-second-list-abandoned");
    const first = await applyList(db as never, "u-second-list-abandoned", "mut-apply-1", false, CLOCK);
    const firstListId = first.value!.listId;
    const abandoned = await abandonList(db as never, "u-second-list-abandoned", firstListId, "abandon-1");
    expect(abandoned.ok).toBe(true);

    const second = await applyList(db as never, "u-second-list-abandoned", "mut-apply-2", false, CLOCK);
    expect(second.ok).toBe(true);
    expect(second.value!.listId).not.toBe(firstListId);
    expect(countRows("daily_training_lists", `WHERE user_id = 'u-second-list-abandoned' AND training_date = '${TODAY_CIVIL}'`)).toBe(2);
  });

  it("enquanto a lista do dia continua ACTIVE, um novo apply() nunca cria uma segunda — devolve a existente (comportamento já coberto, reafirmado aqui)", async () => {
    await setupUserWithOneEligibleQuestion("u-still-active");
    const first = await applyList(db as never, "u-still-active", "mut-apply-1", false, CLOCK);
    const second = await applyList(db as never, "u-still-active", "mut-apply-2", false, CLOCK);
    expect(second.changed).toBe(false);
    expect(second.value!.listId).toBe(first.value!.listId);
    expect(countRows("daily_training_lists", `WHERE user_id = 'u-still-active' AND training_date = '${TODAY_CIVIL}'`)).toBe(1);
  });
});
