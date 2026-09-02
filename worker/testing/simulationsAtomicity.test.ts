// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleSimulationsRequest } from "../src/routes/simulations";
import { abandonBlock, applyBlock, completeBlock, skipItem, startItem, syncItem, type StartItemResult } from "../src/services/simulationsService";
import { confirmAnswer, saveAnswer } from "../src/services/playerService";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 12 v1.0 — provas DIRETAS no banco (nunca só a resposta HTTP) das
   garantias de atomicidade/idempotência/concorrência exigidas pela seção 19
   da ordem, mesmo padrão de worker/testing/dailyTrainingAtomicity.test.ts
   (Sprint 11) e worker/testing/playerAtomicity.test.ts (Sprint 8):
     - dois applies simultâneos criam exatamente UM bloco ativo;
     - start simultâneo cria/associa exatamente UMA tentativa;
     - falha genuína de SQL no INSERT do evento reverte também o núcleo
       (nunca escrita parcial), inclusive sem deixar tentativa órfã do Player;
     - colisão de mutationId retorna conflito controlado, nunca corrompe;
     - corrida real de TOCTOU no mutationId do start (duas operações
       DIFERENTES, mesmo mutationId) é arbitrada pela PK real, nunca por
       sorte de scheduler;
     - complete com item não terminal falha antes do commit;
     - auditoria só é gravada quando a mutação é REAL. */

let db: FakeD1Database;

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

const NOW_ISO = "2026-09-01T15:00:00.000Z";
const CLOCK = fixedClock(NOW_ISO);
const LOCAL_ORIGIN = "http://localhost:8793";

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, { id, name: "Usuária Teste", email: `${id}@teste.dev`, emailNormalized: `${id}@teste.dev`, passwordHash: "hash" });
}

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
  const response = await handleSimulationsRequest(request, localEnv(), url);
  return response!;
}

async function setupUserWithOneEligibleQuestion(userId: string): Promise<void> {
  await seedUser(userId);
  seedPattern(`p-${userId}`, `PAD-${userId}`);
  seedPublishedQuestion(`q-${userId}`, `C-${userId}`, `p-${userId}`);
}

async function setupUserWithTwoEligibleQuestions(userId: string): Promise<void> {
  await seedUser(userId);
  seedPattern(`p1-${userId}`, `PAD1-${userId}`);
  seedPattern(`p2-${userId}`, `PAD2-${userId}`);
  seedPublishedQuestion(`q1-${userId}`, `C1-${userId}`, `p1-${userId}`);
  seedPublishedQuestion(`q2-${userId}`, `C2-${userId}`, `p2-${userId}`);
}

describe("dois applies simultâneos criam exatamente UM bloco ativo (seção 19 da ordem / PO v1.1 seção 1)", () => {
  it("PO v1.1 cenário 4 — DUAS chamadas concorrentes com mutationIds DIFERENTES: exatamente um bloco ativo, resultado CONTROLADO para a perdedora (nunca tratada como retry idempotente só por ter o mesmo conteúdo)", async () => {
    await setupUserWithOneEligibleQuestion("u-race-apply");
    const req = { blockType: "mixed" as const, patternSlug: null, size: 5 as const };

    const [r1, r2] = await Promise.all([
      applyBlock(db as never, "u-race-apply", { mutationId: "mut-a", ...req }, CLOCK),
      applyBlock(db as never, "u-race-apply", { mutationId: "mut-b", ...req }, CLOCK),
    ]);

    const results = [r1, r2];
    const winners = results.filter((r) => r.ok === true && r.changed === true);
    const losers = results.filter((r) => r.ok === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    // PO v1.1: a perdedora NUNCA pode ser um retry idempotente silencioso
    // (mesmo tendo pedido exatamente o mesmo tipo/padrão/tamanho) — é um
    // conflito de domínio explícito, nunca uma exceção crua de SQL.
    expect(losers[0].activeElsewhere).toBe(true);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u-race-apply' AND status = 'active'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE event_type = 'block_applied'`)).toBe(1);
  });

  it("PO v1.1 cenário 5 — DUAS chamadas concorrentes com o MESMO mutationId e a MESMA operação: ambas fulfilled, idempotente de verdade, exatamente um bloco/evento", async () => {
    await setupUserWithOneEligibleQuestion("u-race-apply-same");
    const req = { blockType: "mixed" as const, patternSlug: null, size: 5 as const };
    const SHARED_MUTATION_ID = "mut-shared-same-op";

    const [r1, r2] = await Promise.allSettled([
      applyBlock(db as never, "u-race-apply-same", { mutationId: SHARED_MUTATION_ID, ...req }, CLOCK),
      applyBlock(db as never, "u-race-apply-same", { mutationId: SHARED_MUTATION_ID, ...req }, CLOCK),
    ]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    expect(results[0]!.value!.blockId).toBe(results[1]!.value!.blockId);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u-race-apply-same' AND status = 'active'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE event_type = 'block_applied'`)).toBe(1);
    expect(countRows("audit_log", `WHERE event_type = 'simulation_block_applied' AND user_id = 'u-race-apply-same'`)).toBe(0); // serviço puro — auditoria é responsabilidade da rota, não testada aqui
  });

  it("PO v1.1 cenário 6 — DUAS chamadas concorrentes com o MESMO mutationId mas operações DIFERENTES (tipos de bloco diferentes): uma vence, a outra recebe 409 controlado, nunca uma exceção crua", async () => {
    await setupUserWithTwoEligibleQuestions("u-race-apply-diff-op");
    const SHARED_MUTATION_ID = "mut-shared-diff-op";

    const [r1, r2] = await Promise.allSettled([
      applyBlock(db as never, "u-race-apply-diff-op", { mutationId: SHARED_MUTATION_ID, blockType: "mixed", patternSlug: null, size: 5 }, CLOCK),
      applyBlock(
        db as never,
        "u-race-apply-diff-op",
        { mutationId: SHARED_MUTATION_ID, blockType: "pattern_focused", patternSlug: "slug-p1-u-race-apply-diff-op", size: 5 },
        CLOCK
      ),
    ]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null));
    const winners = results.filter((r) => r!.ok === true);
    const losers = results.filter((r) => r!.ok === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    // Perdedora: mesmo mutationId da vencedora, mas configuração diferente
    // — identidade reaproveitada para outra operação, 409 controlado
    // (nunca activeElsewhere, que seria o caso de um mutationId diferente).
    expect(losers[0]!.conflict).toBe(true);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u-race-apply-diff-op' AND status = 'active'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE event_type = 'block_applied'`)).toBe(1);
  });
});

describe("start simultâneo cria/associa exatamente UMA tentativa (seção 19 da ordem)", () => {
  it("duas chamadas concorrentes de startItem no MESMO item resultam numa única question_attempts e um único item_started", async () => {
    await setupUserWithOneEligibleQuestion("u-race-start");
    const applied = await applyBlock(db as never, "u-race-start", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };

    const [r1, r2] = await Promise.all([
      startItem(db as never, "u-race-start", blockId, itemRow.id, "start-a"),
      startItem(db as never, "u-race-start", blockId, itemRow.id, "start-b"),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.value!.attemptId).toBe(r2.value!.attemptId);
    expect(countRows("question_attempts", `WHERE user_id = 'u-race-start'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
    expect(countRows("simulation_block_items", `WHERE id = '${itemRow.id}' AND status = 'in_progress'`)).toBe(1);
  });
});

describe("falha genuína de SQL no INSERT do evento reverte também o núcleo (seção 19 da ordem)", () => {
  it("apply: INSERT de simulation_block_events forçado a falhar não deixa bloco/itens órfãos", async () => {
    await setupUserWithOneEligibleQuestion("u-fail-apply");
    db.failNextMatching(/INSERT INTO simulation_block_events/);

    await expect(applyBlock(db as never, "u-fail-apply", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK)).rejects.toThrow();

    expect(countRows("simulation_blocks")).toBe(0);
    expect(countRows("simulation_block_items")).toBe(0);
  });

  it("start: INSERT de simulation_block_events forçado a falhar não deixa o item marcado in_progress sem evento, NEM uma tentativa órfã do Player", async () => {
    await setupUserWithOneEligibleQuestion("u-fail-start");
    const applied = await applyBlock(db as never, "u-fail-start", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };

    db.failNextMatching(/INSERT INTO simulation_block_events/);
    await expect(startItem(db as never, "u-fail-start", blockId, itemRow.id, "start-1")).rejects.toThrow();

    const row = db.sqlite.prepare(`SELECT status, question_attempt_id, version FROM simulation_block_items WHERE id = ?`).get(itemRow.id) as {
      status: string;
      question_attempt_id: string | null;
      version: number;
    };
    expect(row.status).toBe("pending");
    expect(row.question_attempt_id).toBeNull();
    expect(row.version).toBe(1);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}'`)).toBe(0);
    expect(countRows("question_attempts", `WHERE user_id = 'u-fail-start'`)).toBe(0);
    expect(countRows("audit_log", `WHERE user_id = 'u-fail-start'`)).toBe(0);
  });

  it("complete: INSERT de simulation_block_events forçado a falhar não deixa o bloco marcado completed sem evento", async () => {
    await setupUserWithOneEligibleQuestion("u-fail-complete");
    const applied = await applyBlock(db as never, "u-fail-complete", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };
    await skipItem(db as never, "u-fail-complete", blockId, itemRow.id, "skip-1");

    db.failNextMatching(/INSERT INTO simulation_block_events/);
    await expect(completeBlock(db as never, "u-fail-complete", blockId, "complete-1")).rejects.toThrow();

    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'active'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE block_id = '${blockId}' AND event_type = 'block_completed'`)).toBe(0);
  });
});

describe("colisão de mutationId retorna conflito controlado (seção 19 da ordem)", () => {
  it("completar o bloco duas vezes com o MESMO mutationId (sem ser retry do resultado já aplicado) retorna conflict, não corrompe nada", async () => {
    await setupUserWithOneEligibleQuestion("u-collision");
    const applied = await applyBlock(db as never, "u-collision", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };
    await skipItem(db as never, "u-collision", blockId, itemRow.id, "skip-1");

    // Reaproveita o mutationId do PRÓPRIO apply (já usado para outra
    // mutação real, o block_applied) para tentar completar o bloco — uma
    // colisão de identidade genuína, nunca um retry legítimo.
    const result = await completeBlock(db as never, "u-collision", blockId, "mut-apply");
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'completed'`)).toBe(0);
  });
});

describe("PO v1.1 — reaproveitar mutationId de OUTRA operação real (fora do escopo já coberto por last_mutation_id) nunca vaza exceção crua, sempre 409 controlado", () => {
  // simulation_block_events.id é PK GLOBAL da tabela: um mutationId já
  // consumido por um evento de ITEM colide com o INSERT de um evento de
  // BLOCO (e vice-versa), mesmo quando a checagem proativa específica de
  // cada função (item.status/block.last_mutation_id) não o alcança porque
  // o mutationId pertence a um recurso DIFERENTE. Antes desta rodada,
  // syncItem/skipItem tratavam essa colisão como "falha genuína" (rethrow
  // cru) e completeBlock/abandonBlock nem tinham try/catch ao redor do
  // db.batch() — a exceção do D1 escapava direto para o chamador.

  it("syncItem: mutationId já usado por um skipItem em OUTRO item deste bloco retorna conflict, nunca lança", async () => {
    await setupUserWithTwoEligibleQuestions("u-cross-sync");
    const applied = await applyBlock(db as never, "u-cross-sync", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC`).all(blockId) as { id: string }[];
    const [itemA, itemB] = items;
    const REUSED_MUTATION_ID = "reused-mut-cross-sync";

    await skipItem(db as never, "u-cross-sync", blockId, itemA.id, REUSED_MUTATION_ID);
    const started = await startItem(db as never, "u-cross-sync", blockId, itemB.id, "start-b");
    expect(started.ok).toBe(true);
    // A tentativa REAL precisa estar `completed` — senão syncItem devolve
    // `changed:false` sem sequer tentar escrever, e o teste não exercitaria
    // o caminho de colisão de identidade no db.batch().
    await saveAnswer(db as never, "u-cross-sync", started.value!.attemptId, 1, "A");
    await confirmAnswer(db as never, "u-cross-sync", started.value!.attemptId, 2, CLOCK);

    const result = await syncItem(db as never, "u-cross-sync", blockId, itemB.id, REUSED_MUTATION_ID);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    const rowB = db.sqlite.prepare(`SELECT status, version FROM simulation_block_items WHERE id = ?`).get(itemB.id) as { status: string; version: number };
    expect(rowB.status).toBe("in_progress"); // nunca "completed" por engano — rollback completo
    expect(rowB.version).toBe(2); // inalterado pela tentativa de sync (1 do apply + 1 do start)
    expect(countRows("simulation_block_events", `WHERE id = '${REUSED_MUTATION_ID}'`)).toBe(1); // só o skip original
  });

  it("skipItem: mutationId já usado por um startItem em OUTRO item deste bloco retorna conflict, nunca lança", async () => {
    await setupUserWithTwoEligibleQuestions("u-cross-skip");
    const applied = await applyBlock(db as never, "u-cross-skip", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC`).all(blockId) as { id: string }[];
    const [itemA, itemB] = items;
    const REUSED_MUTATION_ID = "reused-mut-cross-skip";

    const started = await startItem(db as never, "u-cross-skip", blockId, itemA.id, REUSED_MUTATION_ID);
    expect(started.ok).toBe(true);

    const result = await skipItem(db as never, "u-cross-skip", blockId, itemB.id, REUSED_MUTATION_ID);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    const rowB = db.sqlite.prepare(`SELECT status, version FROM simulation_block_items WHERE id = ?`).get(itemB.id) as { status: string; version: number };
    expect(rowB.status).toBe("pending"); // nunca "skipped" por engano
    expect(rowB.version).toBe(1);
  });

  it("completeBlock: mutationId já usado por um evento de ITEM (não pelo próprio bloco) retorna conflict, nunca lança — o bloco permanece active", async () => {
    await setupUserWithOneEligibleQuestion("u-cross-complete");
    const applied = await applyBlock(db as never, "u-cross-complete", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };
    const REUSED_MUTATION_ID = "reused-mut-cross-complete";
    const skipped = await skipItem(db as never, "u-cross-complete", blockId, itemRow.id, REUSED_MUTATION_ID);
    expect(skipped.ok).toBe(true);

    // block.last_mutation_id ainda é "mut-apply" (nunca tocado pelo skip de
    // item) — a checagem proativa de completeBlock não alcança este caso; é
    // a PK global de simulation_block_events que precisa proteger. Se esta
    // chamada lançasse (comportamento antigo), o `await` abaixo rejeitaria
    // e o teste falharia por exceção não tratada, nunca por asserção.
    const result = await completeBlock(db as never, "u-cross-complete", blockId, REUSED_MUTATION_ID);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'active'`)).toBe(1);
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'completed'`)).toBe(0);
  });

  it("abandonBlock: mutationId já usado por um evento de ITEM (não pelo próprio bloco) retorna conflict, nunca lança — o bloco permanece active", async () => {
    await setupUserWithOneEligibleQuestion("u-cross-abandon");
    const applied = await applyBlock(db as never, "u-cross-abandon", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };
    const REUSED_MUTATION_ID = "reused-mut-cross-abandon";
    const started = await startItem(db as never, "u-cross-abandon", blockId, itemRow.id, REUSED_MUTATION_ID);
    expect(started.ok).toBe(true);

    // Se esta chamada lançasse (comportamento antigo, sem try/catch ao
    // redor do db.batch()), o `await` abaixo rejeitaria e o teste falharia
    // por exceção não tratada, nunca por asserção.
    const result = await abandonBlock(db as never, "u-cross-abandon", blockId, REUSED_MUTATION_ID);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'active'`)).toBe(1);
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'abandoned'`)).toBe(0);
  });
});

describe("complete com item não terminal falha antes do commit (seção 12/19 da ordem)", () => {
  it("tentar completar com um item ainda pending nunca muda o status do bloco", async () => {
    await setupUserWithOneEligibleQuestion("u-not-terminal");
    const applied = await applyBlock(db as never, "u-not-terminal", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;

    const result = await completeBlock(db as never, "u-not-terminal", blockId, "complete-1");
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.items).toBeTruthy();
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'active'`)).toBe(1);
  });
});

describe("auditoria só é gravada quando a mutação é REAL (seção 18 da ordem)", () => {
  it("skip idempotente (item já skipped) não grava um segundo simulation_item_skipped", async () => {
    await setupUserWithOneEligibleQuestion("u-audit-skip");
    const token = await createSessionForUser("u-audit-skip");
    const applyResponse = await callRoute("/api/simulations/apply", token, {
      method: "POST",
      body: JSON.stringify({ mutationId: "mut-apply", blockType: "mixed", size: 5 }),
    });
    const { blockId } = (await applyResponse.json()) as { blockId: string };
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };

    await callRoute(`/api/simulations/${blockId}/items/${itemRow.id}/skip`, token, { method: "POST", body: JSON.stringify({ mutationId: "skip-1" }) });
    await callRoute(`/api/simulations/${blockId}/items/${itemRow.id}/skip`, token, { method: "POST", body: JSON.stringify({ mutationId: "skip-2" }) });

    expect(countRows("audit_log", `WHERE event_type = 'simulation_item_skipped' AND user_id = 'u-audit-skip'`)).toBe(1);
  });
});

describe("startItem — corrida real de TOCTOU no mutationId, duas operações DIFERENTES", () => {
  it("duas chamadas CONCORRENTES de startItem, itens diferentes, MESMO mutationId: ambas passam pelo pre-check, exatamente uma vence, a outra recebe 409 controlado, sem escrita parcial", async () => {
    await setupUserWithTwoEligibleQuestions("u-toctou-race");
    const applied = await applyBlock(db as never, "u-toctou-race", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC`).all(blockId) as { id: string }[];
    expect(items.length).toBe(2);
    const [itemA, itemB] = items;
    const SHARED_MUTATION_ID = "toctou-shared-mut";

    const gate = db.pauseReadsMatching(/SELECT 1 as found FROM simulation_block_events WHERE id = \?/, 2);

    const racePromise = Promise.allSettled([
      startItem(db as never, "u-toctou-race", blockId, itemA.id, SHARED_MUTATION_ID),
      startItem(db as never, "u-toctou-race", blockId, itemB.id, SHARED_MUTATION_ID),
    ]);

    await gate.arrived;
    expect(countRows("simulation_block_events", `WHERE id = '${SHARED_MUTATION_ID}'`)).toBe(0);
    gate.release();

    const [r1, r2] = await racePromise;
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null)) as StartItemResult[];

    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].conflict).toBe(true);
    expect(losers[0].notFound).toBeFalsy();

    expect(countRows("simulation_block_events", `WHERE id = '${SHARED_MUTATION_ID}'`)).toBe(1);

    const rowA = db.sqlite.prepare(`SELECT status, question_attempt_id, version FROM simulation_block_items WHERE id = ?`).get(itemA.id) as {
      status: string;
      question_attempt_id: string | null;
      version: number;
    };
    const rowB = db.sqlite.prepare(`SELECT status, question_attempt_id, version FROM simulation_block_items WHERE id = ?`).get(itemB.id) as {
      status: string;
      question_attempt_id: string | null;
      version: number;
    };
    const rows = [rowA, rowB];
    expect(rows.filter((r) => r.status === "in_progress").length).toBe(1);
    expect(rows.filter((r) => r.status === "pending").length).toBe(1);
    expect(countRows("question_attempts", `WHERE user_id = 'u-toctou-race'`)).toBe(1);
  });

  it("retry da MESMA operação (mesmo item, mesmo mutationId) CONCORRENTE consigo mesma continua idempotente — nunca vira conflito", async () => {
    await setupUserWithOneEligibleQuestion("u-toctou-retry-same");
    const applied = await applyBlock(db as never, "u-toctou-retry-same", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };
    const SHARED_MUTATION_ID = "toctou-retry-same-mut";

    const gate = db.pauseReadsMatching(/SELECT 1 as found FROM simulation_block_events WHERE id = \?/, 2);
    const racePromise = Promise.allSettled([
      startItem(db as never, "u-toctou-retry-same", blockId, itemRow.id, SHARED_MUTATION_ID),
      startItem(db as never, "u-toctou-retry-same", blockId, itemRow.id, SHARED_MUTATION_ID),
    ]);
    await gate.arrived;
    gate.release();
    const [r1, r2] = await racePromise;

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null)) as StartItemResult[];
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(true);
    expect(results[0].value!.attemptId).toBe(results[1].value!.attemptId);
    expect(countRows("question_attempts", `WHERE user_id = 'u-toctou-retry-same'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
  });
});

describe("bloco preexistente ativo não é apagado por rollback do abandono/conclusão", () => {
  it("falha ao completar não altera status/versão do bloco (permanece ativo, intocado)", async () => {
    await setupUserWithOneEligibleQuestion("u-block-preserved");
    const applied = await applyBlock(db as never, "u-block-preserved", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).get(blockId) as { id: string };
    await skipItem(db as never, "u-block-preserved", blockId, itemRow.id, "skip-1");

    db.failNextMatching(/INSERT INTO simulation_block_events/);
    await expect(completeBlock(db as never, "u-block-preserved", blockId, "complete-fail")).rejects.toThrow();

    const block = db.sqlite.prepare(`SELECT status, version FROM simulation_blocks WHERE id = ?`).get(blockId) as { status: string; version: number };
    expect(block.status).toBe("active");
    expect(block.version).toBe(1);
  });
});

describe("abandonar duas vezes é idempotente", () => {
  it("segunda chamada de abandonBlock não grava um segundo evento nem falha", async () => {
    await setupUserWithOneEligibleQuestion("u-abandon-twice");
    const applied = await applyBlock(db as never, "u-abandon-twice", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, CLOCK);
    const blockId = applied.value!.blockId;
    const r1 = await abandonBlock(db as never, "u-abandon-twice", blockId, "abandon-1");
    const r2 = await abandonBlock(db as never, "u-abandon-twice", blockId, "abandon-2");
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(false);
    expect(countRows("simulation_block_events", `WHERE block_id = '${blockId}' AND event_type = 'block_abandoned'`)).toBe(1);
  });
});
