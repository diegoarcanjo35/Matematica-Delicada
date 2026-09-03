// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleSimulationsRequest } from "../src/routes/simulations";
import {
  abandonBlock,
  applyBlock,
  completeBlock,
  getBlockDetail,
  getCurrent,
  getHistory,
  preview,
  skipItem,
  startItem,
  syncItem,
} from "../src/services/simulationsService";
import { confirmAnswer, saveAnswer } from "../src/services/playerService";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 12 v1.0 — testes de serviço/rota dos Simulados em Blocos, contra
   um SQLite real embutido (FakeD1Database, ver worker/testing/fakeD1.ts) —
   nunca só mocks de chamada. Cobre: preview somente-leitura/determinístico,
   modo misto/focado, tamanhos, quantidade insuficiente, apply atômico/
   idempotente, integração real com o Player, sync/skip/complete/abandon,
   histórico, isolamento entre alunos, contrato HTTP (401/404/405).
   Concorrência e falhas forçadas ficam em
   worker/testing/simulationsAtomicity.test.ts. */

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

function seedDraftQuestion(id: string, code: string, patternId: string): string {
  return seedQuestion(db.sqlite, { id, code, status: "draft", version: 1, patternId });
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

/** Semeia dois padrões publicados, cada um com uma questão publicada
 *  treinável — base mínima para exercitar tanto o modo misto (diversidade
 *  entre dois padrões) quanto o modo focado. */
async function setupUserWithTwoPatterns(userId: string): Promise<{ patternA: string; patternB: string; questionA: string; questionB: string }> {
  await seedUser(userId);
  seedPattern("p-a", "PAD-A");
  seedPattern("p-b", "PAD-B");
  const questionA = seedPublishedQuestion("q-a", "C-A", "p-a");
  const questionB = seedPublishedQuestion("q-b", "C-B", "p-b");
  return { patternA: "p-a", patternB: "p-b", questionA, questionB };
}

describe("preview — somente leitura (seção 7 da ordem)", () => {
  it("nunca cria bloco, item, evento ou auditoria, mesmo repetido várias vezes", async () => {
    await setupUserWithTwoPatterns("u1");
    await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    await preview(db as never, "u1", { blockType: "pattern_focused", patternSlug: "slug-p-a", size: 10 }, false, CLOCK);

    expect(countRows("simulation_blocks")).toBe(0);
    expect(countRows("simulation_block_items")).toBe(0);
    expect(countRows("simulation_block_events")).toBe(0);
    expect(countRows("audit_log")).toBe(0);
  });

  it("é determinístico para o mesmo estado do banco e o mesmo relógio", async () => {
    await setupUserWithTwoPatterns("u1");
    const r1 = await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const r2 = await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    expect(r1).toEqual(r2);
  });

  it("bloco misto distribui entre os dois padrões publicados disponíveis", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.composition.length).toBe(2);
    expect(result.preview.selectableCount).toBe(2);
    expect(result.preview.insufficientQuantity).toBe(true); // só 2 disponíveis de 10 pedidas
  });

  it("bloco focado só traz questões do padrão escolhido, por slug resolvido no servidor", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await preview(db as never, "u1", { blockType: "pattern_focused", patternSlug: "slug-p-a", size: 5 }, false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.items.map((i) => i.patternId)).toEqual(["p-a"]);
  });

  it("padrão inexistente/rascunho no modo focado responde notFound, sem vazar conteúdo editorial", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await preview(db as never, "u1", { blockType: "pattern_focused", patternSlug: "slug-inexistente", size: 5 }, false, CLOCK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.notFound).toBe(true);
  });

  it("somente questões publicadas entram — questão em draft do padrão focado nunca aparece", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedDraftQuestion("q-draft", "C-DR", "p1");
    const result = await preview(db as never, "u1", { blockType: "pattern_focused", patternSlug: "slug-p1", size: 5 }, false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.availableCount).toBe(0);
    expect(result.preview.items).toEqual([]);
  });

  it("tamanho fora de {5,10,15} é rejeitado com erro de validação, nunca um bloco de 45", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 45 }, false, CLOCK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.size).toBeTruthy();
  });

  it("aviso de quantidade insuficiente aparece quando há menos questões que o tamanho pedido", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await preview(db as never, "u1", { blockType: "mixed", patternSlug: null, size: 15 }, false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.insufficientQuantity).toBe(true);
    expect(result.preview.selectableCount).toBeLessThan(15);
  });
});

describe("apply — atômico, explícito e idempotente (seção 9 da ordem)", () => {
  it("cria bloco + itens + evento atomicamente, nunca bloco vazio", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(countRows("simulation_blocks", `WHERE id = '${result.value!.blockId}'`)).toBe(1);
    expect(countRows("simulation_block_items", `WHERE block_id = '${result.value!.blockId}'`)).toBe(2);
    expect(countRows("simulation_block_events", `WHERE block_id = '${result.value!.blockId}' AND event_type = 'block_applied'`)).toBe(1);
  });

  it("retry idempotente com o MESMO mutationId devolve o bloco existente, sem duplicar (PO v1.1 — identidade da mutação, nunca igualdade de conteúdo)", async () => {
    await setupUserWithTwoPatterns("u1");
    const r1 = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const r2 = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
    expect(r2.value!.blockId).toBe(r1.value!.blockId);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u1'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE event_type = 'block_applied'`)).toBe(1);
  });

  it("PO v1.1 — mutationId DIFERENTE com configuração IDÊNTICA a um bloco já ativo NUNCA é tratado como retry idempotente (igualdade de conteúdo não prova mesma mutação)", async () => {
    await setupUserWithTwoPatterns("u1");
    const r1 = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const r2 = await applyBlock(db as never, "u1", { mutationId: "mut-2", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    expect(r2.ok).toBe(false);
    expect(r2.activeElsewhere).toBe(true);
    expect(r2.changed).toBeFalsy();
    expect(countRows("simulation_blocks", `WHERE user_id = 'u1'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE event_type = 'block_applied'`)).toBe(1);
    void r1;
  });

  it("PO v1.1 — mesmo mutationId de um bloco já ativo, mas configuração DIFERENTE, é um 409 controlado (identidade reaproveitada para outra operação)", async () => {
    await setupUserWithTwoPatterns("u1");
    await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const second = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "pattern_focused", patternSlug: "slug-p-a", size: 5 }, false, CLOCK);
    expect(second.ok).toBe(false);
    expect(second.conflict).toBe(true);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u1'`)).toBe(1);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u1' AND block_type = 'mixed'`)).toBe(1);
  });

  it("pedir um segundo bloco DIFERENTE enquanto um já está ativo é rejeitado explicitamente (nunca cria uma segunda sessão)", async () => {
    await setupUserWithTwoPatterns("u1");
    await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const second = await applyBlock(db as never, "u1", { mutationId: "mut-2", blockType: "pattern_focused", patternSlug: "slug-p-a", size: 5 }, false, CLOCK);
    expect(second.ok).toBe(false);
    expect(second.activeElsewhere).toBe(true);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u1' AND status = 'active'`)).toBe(1);
  });

  it("nenhuma questão elegível resulta em `empty`, nunca um bloco vazio persistido", async () => {
    await seedUser("u1");
    const result = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    expect(result.ok).toBe(false);
    expect(result.empty).toBe(true);
    expect(countRows("simulation_blocks")).toBe(0);
  });

  it("bloco misto tem actual_item_count menor que planned_item_count quando há menos candidatas — nunca preenche artificialmente", async () => {
    await setupUserWithTwoPatterns("u1");
    const result = await applyBlock(db as never, "u1", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 15 }, false, CLOCK);
    const row = db.sqlite.prepare("SELECT planned_item_count, actual_item_count FROM simulation_blocks WHERE id = ?").get(result.value!.blockId) as {
      planned_item_count: number;
      actual_item_count: number;
    };
    expect(row.planned_item_count).toBe(15);
    expect(row.actual_item_count).toBe(2);
  });
});

describe("integração com o Player (seção 10 da ordem)", () => {
  it("start cria a tentativa + associa ao item + grava evento, tudo atômico", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC LIMIT 1").get(blockId) as { id: string };

    const result = await startItem(db as never, "u1", blockId, itemRow.id, "start-1");
    expect(result.ok).toBe(true);
    expect(countRows("question_attempts", `WHERE user_id = 'u1'`)).toBe(1);
    expect(countRows("simulation_block_items", `WHERE id = '${itemRow.id}' AND status = 'in_progress'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
  });

  it("start retry com o mesmo mutationId é idempotente — nunca cria uma segunda tentativa", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC LIMIT 1").get(blockId) as { id: string };

    const r1 = await startItem(db as never, "u1", blockId, itemRow.id, "start-1");
    const r2 = await startItem(db as never, "u1", blockId, itemRow.id, "start-1");
    expect(r1.value!.attemptId).toBe(r2.value!.attemptId);
    expect(countRows("question_attempts", `WHERE user_id = 'u1'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_started'`)).toBe(1);
  });

  it("sync só conclui o item quando a tentativa real está completed; resposta salva mas não confirmada não conclui", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare("SELECT id, question_id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC LIMIT 1").get(blockId) as {
      id: string;
      question_id: string;
    };
    const started = await startItem(db as never, "u1", blockId, itemRow.id, "start-1");
    const attemptId = started.value!.attemptId;

    const midSync = await syncItem(db as never, "u1", blockId, itemRow.id, "sync-mid");
    expect(midSync.value!.itemStatus).toBe("in_progress");
    expect(countRows("simulation_block_items", `WHERE id = '${itemRow.id}' AND status = 'completed'`)).toBe(0);

    await saveAnswer(db as never, "u1", attemptId, 1, "A");
    await confirmAnswer(db as never, "u1", attemptId, 2, CLOCK);

    const finalSync = await syncItem(db as never, "u1", blockId, itemRow.id, "sync-final");
    expect(finalSync.value!.itemStatus).toBe("completed");
    expect(countRows("simulation_block_items", `WHERE id = '${itemRow.id}' AND status = 'completed'`)).toBe(1);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_completed'`)).toBe(1);
  });

  it("acerto e erro do simulado alimentam o Caderno de Erros pela regra já existente do Player, sem duplicar", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC LIMIT 1").get(blockId) as { id: string };
    const started = await startItem(db as never, "u1", blockId, itemRow.id, "start-1");
    const attemptId = started.value!.attemptId;

    // fixture-style seedQuestion sempre marca a alternativa B como correta —
    // respondendo A força um erro confirmado.
    await saveAnswer(db as never, "u1", attemptId, 1, "A");
    await confirmAnswer(db as never, "u1", attemptId, 2, CLOCK);
    await syncItem(db as never, "u1", blockId, itemRow.id, "sync-1");

    expect(countRows("error_notebook_entries", `WHERE user_id = 'u1'`)).toBe(1);
  });
});

describe("pular item (seção 15 da ordem)", () => {
  it("move o item para skipped e grava o evento; idempotente numa segunda chamada", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const itemRow = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC LIMIT 1").get(blockId) as { id: string };

    const r1 = await skipItem(db as never, "u1", blockId, itemRow.id, "skip-1");
    expect(r1.ok).toBe(true);
    expect(countRows("simulation_block_items", `WHERE id = '${itemRow.id}' AND status = 'skipped'`)).toBe(1);

    const r2 = await skipItem(db as never, "u1", blockId, itemRow.id, "skip-2");
    expect(r2.changed).toBe(false);
    expect(countRows("simulation_block_events", `WHERE item_id = '${itemRow.id}' AND event_type = 'item_skipped'`)).toBe(1);
  });
});

describe("conclusão do bloco (seção 12 da ordem)", () => {
  it("só conclui quando TODOS os itens estão em estado terminal", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ?").all(blockId) as { id: string }[];
    expect(items.length).toBe(2);

    const premature = await completeBlock(db as never, "u1", blockId, "complete-early");
    expect(premature.ok).toBe(false);
    expect(premature.fieldErrors?.items).toBeTruthy();

    for (const item of items) await skipItem(db as never, "u1", blockId, item.id, `skip-${item.id}`);

    const completed = await completeBlock(db as never, "u1", blockId, "complete-1");
    expect(completed.ok).toBe(true);
    expect(completed.value!.summary.skippedCount).toBe(2);
    expect(completed.value!.summary.completedCount).toBe(0);
    expect(completed.value!.summary.accuracyPercent).toBeNull(); // nenhuma questão confirmada — honesto, nunca 0% fabricado
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'completed'`)).toBe(1);
  });

  it("resumo factual nunca inclui TRI/nota/ranking — só campos factuais fechados", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ?").all(blockId) as { id: string }[];
    for (const item of items) await skipItem(db as never, "u1", blockId, item.id, `skip-${item.id}`);
    const completed = await completeBlock(db as never, "u1", blockId, "complete-1");
    const summaryKeys = Object.keys(completed.value!.summary);
    expect(summaryKeys.sort()).toEqual(
      [
        "completedCount",
        "skippedCount",
        "blockedCount",
        "correctCount",
        "incorrectCount",
        "accuracyPercent",
        "patternsPracticed",
        "approxMinutes",
        "approxMinutesPerQuestion",
        "helpsUsedCount",
      ].sort()
    );
  });
});

describe("abandono do bloco", () => {
  it("move o bloco para abandoned e libera um novo apply em seguida", async () => {
    await setupUserWithTwoPatterns("u1");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;

    const abandoned = await abandonBlock(db as never, "u1", blockId, "abandon-1");
    expect(abandoned.ok).toBe(true);
    expect(countRows("simulation_blocks", `WHERE id = '${blockId}' AND status = 'abandoned'`)).toBe(1);

    const second = await applyBlock(db as never, "u1", { mutationId: "mut-apply-2", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    expect(second.ok).toBe(true);
    expect(second.value!.blockId).not.toBe(blockId);
  });
});

describe("histórico — somente leitura (seção 14 da ordem)", () => {
  it("lista somente blocos concluídos/abandonados deste aluno, nunca ativos, nunca de outro aluno", async () => {
    await setupUserWithTwoPatterns("u1");
    await seedUser("u2");
    const applied = await applyBlock(db as never, "u1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare("SELECT id FROM simulation_block_items WHERE block_id = ?").all(blockId) as { id: string }[];
    for (const item of items) await skipItem(db as never, "u1", blockId, item.id, `skip-${item.id}`);
    await completeBlock(db as never, "u1", blockId, "complete-1");

    const activeOnly = await applyBlock(db as never, "u1", { mutationId: "mut-active", blockType: "pattern_focused", patternSlug: "slug-p-a", size: 5 }, false, CLOCK);
    expect(activeOnly.ok).toBe(true);

    const history = await getHistory(db as never, "u1", null);
    expect(history.entries.length).toBe(1);
    expect(history.entries[0].id).toBe(blockId);
    expect(history.entries[0].status).toBe("completed");

    const historyOther = await getHistory(db as never, "u2", null);
    expect(historyOther.entries.length).toBe(0);
  });

  it("GET /api/simulations/history nunca escreve nada, mesmo chamado várias vezes", async () => {
    await setupUserWithTwoPatterns("u1");
    const token = await createSessionForUser("u1");
    await callRoute("/api/simulations/history", token);
    await callRoute("/api/simulations/history", token);
    expect(countRows("simulation_blocks")).toBe(0);
    expect(countRows("audit_log")).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* PO v1.1 (correção, seção 3 da ordem) — significado de `current`: as     */
/* cinco propriedades exigidas, cada uma provada diretamente.              */
/* ---------------------------------------------------------------------- */

describe("significado de GET /current (correção PO v1.1, seção 3 da ordem)", () => {
  it("1) devolve SOMENTE o bloco ativo — nunca um completed/abandoned", async () => {
    await setupUserWithTwoPatterns("u-current-1");
    const applied = await applyBlock(db as never, "u-current-1", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const blockId = applied.value!.blockId;

    const whileActive = await getCurrent(db as never, "u-current-1", false);
    expect(whileActive?.id).toBe(blockId);
    expect(whileActive?.status).toBe("active");
  });

  it("2) um bloco COMPLETED nunca reaparece como current — devolve null depois de concluído", async () => {
    await setupUserWithTwoPatterns("u-current-2");
    const applied = await applyBlock(db as never, "u-current-2", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).all(blockId) as { id: string }[];
    for (const item of items) await skipItem(db as never, "u-current-2", blockId, item.id, `skip-${item.id}`);
    await completeBlock(db as never, "u-current-2", blockId, "complete-1");

    const current = await getCurrent(db as never, "u-current-2", false);
    expect(current).toBeNull();
  });

  it("2b) um bloco ABANDONED também nunca reaparece como current — devolve null depois de abandonado", async () => {
    await setupUserWithTwoPatterns("u-current-2b");
    const applied = await applyBlock(db as never, "u-current-2b", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    await abandonBlock(db as never, "u-current-2b", applied.value!.blockId, "abandon-1");

    const current = await getCurrent(db as never, "u-current-2b", false);
    expect(current).toBeNull();
  });

  it("3) blocos terminais (completed/abandoned) ficam a cargo do histórico, nunca de current", async () => {
    await setupUserWithTwoPatterns("u-current-3");
    const applied = await applyBlock(db as never, "u-current-3", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).all(blockId) as { id: string }[];
    for (const item of items) await skipItem(db as never, "u-current-3", blockId, item.id, `skip-${item.id}`);
    await completeBlock(db as never, "u-current-3", blockId, "complete-1");

    expect(await getCurrent(db as never, "u-current-3", false)).toBeNull();
    const history = await getHistory(db as never, "u-current-3", null);
    expect(history.entries.map((e) => e.id)).toEqual([blockId]);
  });

  it("4) um refresh (múltiplas chamadas) durante um bloco ativo sempre retoma o MESMO bloco — nunca cria um segundo", async () => {
    await setupUserWithTwoPatterns("u-current-4");
    const applied = await applyBlock(db as never, "u-current-4", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const blockId = applied.value!.blockId;

    const r1 = await getCurrent(db as never, "u-current-4", false);
    const r2 = await getCurrent(db as never, "u-current-4", false);
    const r3 = await getCurrent(db as never, "u-current-4", false);
    expect(r1?.id).toBe(blockId);
    expect(r2?.id).toBe(blockId);
    expect(r3?.id).toBe(blockId);
    expect(countRows("simulation_blocks", `WHERE user_id = 'u-current-4'`)).toBe(1);
  });

  it("5) após a conclusão, a tela de resultado é alcançada via blockId diretamente (getBlockDetail), sem criar uma nova prévia/bloco automaticamente", async () => {
    await setupUserWithTwoPatterns("u-current-5");
    const applied = await applyBlock(db as never, "u-current-5", { mutationId: "mut-apply", blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const blockId = applied.value!.blockId;
    const items = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).all(blockId) as { id: string }[];
    for (const item of items) await skipItem(db as never, "u-current-5", blockId, item.id, `skip-${item.id}`);
    await completeBlock(db as never, "u-current-5", blockId, "complete-1");

    const before = countRows("simulation_blocks", `WHERE user_id = 'u-current-5'`);
    const detail = await getBlockDetail(db as never, "u-current-5", blockId, false);
    expect(detail?.id).toBe(blockId);
    expect(detail?.status).toBe("completed");
    const after = countRows("simulation_blocks", `WHERE user_id = 'u-current-5'`);
    expect(after).toBe(before); // getBlockDetail é 100% leitura — nenhuma prévia/bloco novo criado
    expect(after).toBe(1);
  });
});

describe("isolamento entre alunos e contrato HTTP (seção 17 da ordem)", () => {
  it("acessar o bloco de outro aluno responde 404, nunca 403", async () => {
    await setupUserWithTwoPatterns("u-owner");
    await seedUser("u-intruder");
    const ownerToken = await createSessionForUser("u-owner");
    const intruderToken = await createSessionForUser("u-intruder");

    const applyResponse = await callRoute("/api/simulations/apply", ownerToken, {
      method: "POST",
      body: JSON.stringify({ mutationId: "mut-1", blockType: "mixed", size: 10 }),
    });
    const { blockId } = (await applyResponse.json()) as { blockId: string };

    const crossResponse = await callRoute(`/api/simulations/${blockId}`, intruderToken);
    expect(crossResponse.status).toBe(404);
  });

  it("getBlockDetail também nunca vaza um bloco de outro aluno (chamado direto no serviço)", async () => {
    await setupUserWithTwoPatterns("u-owner-2");
    await seedUser("u-intruder-2");
    const applied = await applyBlock(db as never, "u-owner-2", { mutationId: "mut-1", blockType: "mixed", patternSlug: null, size: 10 }, false, CLOCK);
    const detail = await getBlockDetail(db as never, "u-intruder-2", applied.value!.blockId, false);
    expect(detail).toBeNull();
  });

  it("método inválido no endpoint de preview responde 405", async () => {
    await setupUserWithTwoPatterns("u-method");
    const token = await createSessionForUser("u-method");
    const response = await callRoute("/api/simulations/preview?blockType=mixed&size=5", token, { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(405);
  });

  it("sem sessão responde 401", async () => {
    const response = await callRoute("/api/simulations/preview?blockType=mixed&size=5", null);
    expect(response.status).toBe(401);
  });

  it("GET current de um aluno sem bloco ativo devolve null, nunca cria nada", async () => {
    await setupUserWithTwoPatterns("u1");
    const current = await getCurrent(db as never, "u1", false);
    expect(current).toBeNull();
    expect(countRows("simulation_blocks")).toBe(0);
  });
});

describe("auditoria só em mutação real (seção 18 da ordem)", () => {
  it("apply idempotente (segunda chamada, bloco já existe) não grava um segundo simulation_block_applied", async () => {
    await setupUserWithTwoPatterns("u-audit");
    const token = await createSessionForUser("u-audit");
    await callRoute("/api/simulations/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-http-1", blockType: "mixed", size: 10 }) });
    await callRoute("/api/simulations/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-http-2", blockType: "mixed", size: 10 }) });
    expect(countRows("audit_log", `WHERE event_type = 'simulation_block_applied' AND user_id = 'u-audit'`)).toBe(1);
  });

  it("GETs (preview/current/history) nunca gravam audit_log", async () => {
    await setupUserWithTwoPatterns("u-audit-2");
    const token = await createSessionForUser("u-audit-2");
    await callRoute("/api/simulations/preview?blockType=mixed&size=5", token);
    await callRoute("/api/simulations/current", token);
    await callRoute("/api/simulations/history", token);
    expect(countRows("audit_log", `WHERE user_id = 'u-audit-2'`)).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* PO v1.1 (correção, seção 4 da ordem) — GET somente leitura, provado    */
/* para CADA UM dos 4 endpoints separadamente, com contagem de linhas por */
/* tabela antes/depois (nunca só o corpo da resposta), incluindo          */
/* audit_log e idempotência do corpo — mesmo rigor de                     */
/* studentMetrics.test.ts, "GET somente leitura — por endpoint...".       */
/* ---------------------------------------------------------------------- */

describe("GET somente leitura — por endpoint, com contagem de linhas por tabela (correção PO v1.1, seção 4 da ordem)", () => {
  const ALL_RELEVANT_TABLES = [
    "simulation_blocks",
    "simulation_block_items",
    "simulation_block_events",
    "question_attempts",
    "question_answer_events",
    "question_recognition_events",
    "question_help_events",
    "error_notebook_entries",
    "error_review_events",
    "audit_log",
  ];

  function snapshotAllTables(): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const table of ALL_RELEVANT_TABLES) snap[table] = countRows(table);
    return snap;
  }

  /** Cenário "quente": um bloco JÁ concluído (aparece no histórico) e um
   *  bloco ATIVO com um item em andamento (tentativa real criada) — para
   *  provar que os GETs não escrevem nada mesmo contra um banco com estado
   *  real em todas as tabelas envolvidas, não só contra um banco vazio. */
  async function setupBusyState(userId: string): Promise<{ token: string; activeBlockId: string }> {
    await setupUserWithTwoPatterns(userId);
    const token = await createSessionForUser(userId);

    const firstApply = await applyBlock(db as never, userId, { mutationId: `${userId}-mut-apply-1`, blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const firstBlockId = firstApply.value!.blockId;
    const firstItems = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ?`).all(firstBlockId) as { id: string }[];
    for (const item of firstItems) await skipItem(db as never, userId, firstBlockId, item.id, `${userId}-skip-${item.id}`);
    await completeBlock(db as never, userId, firstBlockId, `${userId}-mut-complete-1`);

    const secondApply = await applyBlock(db as never, userId, { mutationId: `${userId}-mut-apply-2`, blockType: "mixed", patternSlug: null, size: 5 }, false, CLOCK);
    const activeBlockId = secondApply.value!.blockId;
    const secondItems = db.sqlite.prepare(`SELECT id FROM simulation_block_items WHERE block_id = ? ORDER BY position ASC`).all(activeBlockId) as {
      id: string;
    }[];
    await startItem(db as never, userId, activeBlockId, secondItems[0].id, `${userId}-mut-start`);

    return { token, activeBlockId };
  }

  const endpointsFor = (activeBlockId: string): Array<{ name: string; path: string }> => [
    { name: "preview", path: "/api/simulations/preview?blockType=mixed&size=5" },
    { name: "current", path: "/api/simulations/current" },
    { name: ":blockId", path: `/api/simulations/${activeBlockId}` },
    { name: "history", path: "/api/simulations/history" },
  ];

  for (const endpointName of ["preview", "current", ":blockId", "history"] as const) {
    it(`GET ${endpointName}: zero linhas criadas/alteradas/removidas em NENHUMA das ${ALL_RELEVANT_TABLES.length} tabelas relevantes, e chamadas repetidas são idempotentes`, async () => {
      const userId = `u-getro-${endpointName.replace(/[^a-z0-9]/gi, "")}`;
      const { token, activeBlockId } = await setupBusyState(userId);
      const endpoint = endpointsFor(activeBlockId).find((e) => e.name === endpointName)!;

      const before = snapshotAllTables();

      const first = await callRoute(endpoint.path, token);
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const afterFirst = snapshotAllTables();
      expect(afterFirst).toEqual(before);

      const second = await callRoute(endpoint.path, token);
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      const afterSecond = snapshotAllTables();
      expect(afterSecond).toEqual(before);

      // Idempotência do corpo: sem nenhuma mutação real entre as chamadas,
      // a resposta é EXATAMENTE a mesma.
      expect(secondBody).toEqual(firstBody);
    });
  }
});
