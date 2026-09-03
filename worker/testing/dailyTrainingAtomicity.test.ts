// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleDailyTrainingRequest } from "../src/routes/dailyTraining";
import { abandonList, applyList, completeList, skipItem, startItem, type StartItemResult } from "../src/services/dailyTrainingService";
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
