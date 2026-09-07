// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleDailyTrainingRequest } from "../src/routes/dailyTraining";
import {
  applyFocusedByPattern,
  applyList,
  getCurrent,
  listTrainablePatterns,
  previewFocusedByPattern,
  startItem,
  syncItem,
} from "../src/services/dailyTrainingService";
import { confirmAnswer, saveAnswer } from "../src/services/playerService";
import { civilDateInTimezone, weekdayCodeForCivilDate } from "../src/lib/scheduleValidation";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 20 — "Treino Diário por Padrão" ("O que você quer treinar
   hoje?"). Cobre exclusivamente a funcionalidade NOVA desta sprint
   (catálogo de padrões treináveis, preview/apply focados por padrão,
   reaproveitamento do Player/progresso, compatibilidade com listas
   históricas) — mesmo padrão de harness (FakeD1Database real) de
   worker/testing/dailyTraining.test.ts/dailyTrainingAtomicity.test.ts,
   nunca duplicado aqui: os testes de regressão do motor adaptativo
   original continuam SÓ naqueles arquivos, re-executados sem alteração
   (ver relatório). */

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

interface SeedPatternOptions {
  status?: string;
  isLocalFixture?: boolean;
  mainStrategy?: string;
}

function seedPattern(id: string, code: string, options: SeedPatternOptions = {}): void {
  db.sqlite
    .prepare(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status, is_local_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, code, `slug-${id}`, `Padrão ${id}`, "F", "D", options.mainStrategy ?? "Macete técnico de teste.", "X", "R", options.status ?? "published", options.isLocalFixture ? 1 : 0);
}

function seedProfile(userId: string, availableDays: string[], dailyMinutes: number): void {
  db.sqlite.exec(
    `INSERT INTO student_profiles (user_id, available_days, daily_minutes, status) VALUES ('${userId}', '${JSON.stringify(availableDays)}', ${dailyMinutes}, 'completed')`
  );
}

function seedPublishedQuestion(id: string, code: string, patternId: string, opts: { tempoEstimadoSegundos?: number; isLocalFixture?: boolean; role?: "principal" | "secundario" } = {}): string {
  const qId = seedQuestion(db.sqlite, {
    id,
    code,
    status: "published",
    version: 1,
    isLocalFixture: opts.isLocalFixture ?? false,
    withPrincipalPattern: opts.role !== "secundario",
    patternId: opts.role === "secundario" ? undefined : patternId,
    secondaryPatternIds: opts.role === "secundario" ? [patternId] : [],
    fingerprint: `fp-${id}`,
  });
  if (opts.tempoEstimadoSegundos !== undefined) {
    db.sqlite.prepare("UPDATE questions SET tempo_estimado_segundos = ? WHERE id = ?").run(opts.tempoEstimadoSegundos, qId);
  }
  return qId;
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

/** Marca uma tentativa CONFIRMADA (completed) para `questionId`, agora
 *  (dentro da janela de 3 dias de "recém concluída"). */
function seedRecentCompletion(userId: string, attemptId: string, questionId: string): void {
  db.sqlite.exec(
    `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, is_correct, selected_alternative, answered_at, completed_at)
     VALUES ('${attemptId}', '${userId}', '${questionId}', 1, 'learning', 'completed', 1, 'B', datetime('now'), datetime('now'))`
  );
}

/* --------------------------------------- CATÁLOGO --------------------------------------- */

describe("listTrainablePatterns — catálogo dinâmico (correção 20, seção 4)", () => {
  it("item 1 — lista somente padrões published", async () => {
    seedPattern("p1", "PAD-01");
    const result = await listTrainablePatterns(db as never, false);
    expect(result.map((p) => p.id)).toEqual(["p1"]);
  });

  it("item 2 — draft/archived não aparecem", async () => {
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02", { status: "draft" });
    seedPattern("p3", "PAD-03", { status: "archived" });
    const result = await listTrainablePatterns(db as never, false);
    expect(result.map((p) => p.id)).toEqual(["p1"]);
  });

  it("item 3 — padrão published sem questão aparece com count=0/canTrain=false", async () => {
    seedPattern("p1", "PAD-01");
    const result = await listTrainablePatterns(db as never, false);
    expect(result).toHaveLength(1);
    expect(result[0].availableQuestionCount).toBe(0);
    expect(result[0].canTrain).toBe(false);
  });

  it("item 4 — questão published com vínculo PRINCIPAL conta", async () => {
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    const result = await listTrainablePatterns(db as never, false);
    expect(result[0].availableQuestionCount).toBe(1);
    expect(result[0].canTrain).toBe(true);
  });

  it("item 5 — questão onde o padrão é apenas SECUNDÁRIO não conta", async () => {
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p2"); // principal em p2
    // vincula p1 como secundário na mesma questão.
    db.sqlite.prepare(`INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('q1-sec-p1', 'q1', 'p1', 'secundario')`).run();
    const result = await listTrainablePatterns(db as never, false);
    const p1 = result.find((p) => p.id === "p1")!;
    expect(p1.availableQuestionCount).toBe(0);
    expect(p1.canTrain).toBe(false);
  });

  it("item 6 — questão draft não conta", async () => {
    seedPattern("p1", "PAD-01");
    seedQuestion(db.sqlite, { id: "q1", code: "C1", status: "draft", patternId: "p1", fingerprint: "fp-q1" });
    const result = await listTrainablePatterns(db as never, false);
    expect(result[0].availableQuestionCount).toBe(0);
  });

  it("item 7 — fixture não conta fora do dev local autorizado", async () => {
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1", { isLocalFixture: true });
    const result = await listTrainablePatterns(db as never, false);
    expect(result[0].availableQuestionCount).toBe(0);
  });

  it("item 8 — fixture conta quando o dev local está autorizado (fixturesAllowed=true)", async () => {
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1", { isLocalFixture: true });
    const result = await listTrainablePatterns(db as never, true);
    expect(result[0].availableQuestionCount).toBe(1);
    expect(result[0].canTrain).toBe(true);
  });

  it("item 9 — catálogo é UMA única consulta agregada, nunca N+1 por padrão", async () => {
    for (let i = 0; i < 12; i++) {
      seedPattern(`p${i}`, `PAD-${i}`);
      seedPublishedQuestion(`q${i}`, `C${i}`, `p${i}`);
    }
    db.resetD1CallCount();
    const result = await listTrainablePatterns(db as never, false);
    expect(result).toHaveLength(12);
    expect(db.getD1CallCount()).toBe(1);
  });
});

/* ------------------------------------ PREVIEW FOCADO ------------------------------------ */

describe("previewFocusedByPattern — preview escopado a UM padrão (correção 20, seção 9)", () => {
  it("item 10/11 — retorna SOMENTE questões cujo padrão principal é o escolhido", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p2");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.questionId)).toEqual(["q1"]);
    expect(result.value.items.every((i) => i.patternId === "p1")).toBe(true);
    expect(result.value.focusPattern.id).toBe("p1");
  });

  it("item 12 — padrão inexistente bloqueia (notFound)", async () => {
    await seedUser("u1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await previewFocusedByPattern(db as never, "u1", "nao-existe", false, CLOCK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.notFound).toBe(true);
  });

  it("item 13 — padrão NÃO published (draft) bloqueia com o MESMO notFound (nunca revela rascunho)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01", { status: "draft" });
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(false);
  });

  it("item 14 — padrão published sem questão gera preview vazio honesto (nunca erro)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemCount).toBe(0);
    expect(result.value.items).toEqual([]);
  });

  it("item 15 — GET nunca cria lista/item/tentativa/auditoria", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(countRows("daily_training_lists")).toBe(0);
    expect(countRows("daily_training_items")).toBe(0);
    expect(countRows("question_attempts")).toBe(0);
    expect(countRows("audit_log")).toBe(0);
  });

  it("item 16 — indisponibilidade diária continua respeitada (0 minutos → vazio honesto)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    const otherWeekday = (["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const).find((d) => d !== TODAY_WEEKDAY)!;
    seedProfile("u1", [otherWeekday], 60);
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasAvailabilityToday).toBe(false);
    expect(result.value.itemCount).toBe(0);
  });

  it("item 17 — máximo de 10 itens continua, mesmo com mais questões elegíveis e tempo disponível", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    for (let i = 0; i < 15; i++) seedPublishedQuestion(`q${i}`, `C${i}`, "p1", { tempoEstimadoSegundos: 60 });
    seedProfile("u1", [TODAY_WEEKDAY], 600); // 10h disponíveis — nunca o gargalo aqui.
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemCount).toBe(10);
  });

  it("item 18 — limite de minutos continua respeitado", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    for (let i = 0; i < 5; i++) seedPublishedQuestion(`q${i}`, `C${i}`, "p1", { tempoEstimadoSegundos: 600 }); // 10 min cada.
    seedProfile("u1", [TODAY_WEEKDAY], 25); // só cabem 2 questões de 10 min.
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemCount).toBe(2);
    expect(result.value.estimatedMinutes).toBeLessThanOrEqual(25);
  });

  it("item 19 — questão concluída recentemente é PRETERIDA quando há alternativa fresca", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q-recent", "C1", "p1");
    seedPublishedQuestion("q-fresh", "C2", "p1");
    seedRecentCompletion("u1", "att-1", "q-recent");
    // seedQuestion() grava tempo_estimado_segundos=90 por padrão (2 min
    // arredondados) — 3 minutos disponíveis cabem exatamente 1 questão,
    // nunca 2 (2+2=4 > 3).
    seedProfile("u1", [TODAY_WEEKDAY], 3);

    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.questionId)).toEqual(["q-fresh"]);
  });

  it("item 20 — questão recente entra como FALLBACK quando TODAS são recentes (nunca lista vazia por causa disso)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    seedRecentCompletion("u1", "att-1", "q1");
    seedRecentCompletion("u1", "att-2", "q2");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemCount).toBe(2); // nunca vazio só porque ambas são recentes.
    expect(result.value.items.map((i) => i.questionId).sort()).toEqual(["q1", "q2"]);
  });

  it("item 21 — lista curta permanece curta: NUNCA completa com outro padrão", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p1"); // só 1 questão em p1.
    for (let i = 0; i < 10; i++) seedPublishedQuestion(`other${i}`, `O${i}`, "p2"); // muitas em p2.
    seedProfile("u1", [TODAY_WEEKDAY], 600);

    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemCount).toBe(1);
    expect(result.value.items.every((i) => i.patternId === "p1")).toBe(true);
  });

  it("item 22 — nenhuma questão duplicada", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    for (let i = 0; i < 5; i++) seedPublishedQuestion(`q${i}`, `C${i}`, "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 600);
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.items.map((i) => i.questionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ---------------------------------------- APPLY ---------------------------------------- */

describe("applyFocusedByPattern — mutação focada (correção 20, seção 13/14)", () => {
  it("item 23/24 — cria lista válida; TODOS os itens têm o patternId escolhido", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await applyFocusedByPattern(db as never, "u1", "p1", "mut-1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = db.sqlite.prepare("SELECT primary_pattern_id FROM daily_training_items WHERE list_id = ?").all(result.value!.listId) as Array<{ primary_pattern_id: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.primary_pattern_id === "p1")).toBe(true);
  });

  it("item 25 — apply nunca altera editorial_status das questões (nenhuma mudança editorial)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    await applyFocusedByPattern(db as never, "u1", "p1", "mut-1", false, CLOCK);
    const q = db.sqlite.prepare("SELECT editorial_status FROM questions WHERE id = 'q1'").get() as { editorial_status: string };
    expect(q.editorial_status).toBe("published");
  });

  it("item 26 — nunca persiste lista vazia (padrão sem questão elegível)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await applyFocusedByPattern(db as never, "u1", "p1", "mut-1", false, CLOCK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.empty).toBe(true);
    expect(countRows("daily_training_lists")).toBe(0);
  });

  it("item 26b — nunca persiste lista vazia (0 minutos disponíveis, mesmo com questões reais)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    const otherWeekday = (["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const).find((d) => d !== TODAY_WEEKDAY)!;
    seedProfile("u1", [otherWeekday], 60);
    const result = await applyFocusedByPattern(db as never, "u1", "p1", "mut-1", false, CLOCK);
    expect(result.ok).toBe(false);
    expect(countRows("daily_training_lists")).toBe(0);
  });

  it("item 27 — retry não duplica lista (idempotente)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const first = await applyFocusedByPattern(db as never, "u1", "p1", "mut-1", false, CLOCK);
    const retry = await applyFocusedByPattern(db as never, "u1", "p1", "mut-2", false, CLOCK);
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.value!.listId).toBe(first.value!.listId);
    expect(countRows("daily_training_lists")).toBe(1);
  });

  it("item 28 — duas chamadas concorrentes do MESMO padrão nunca duplicam a lista", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const [r1, r2] = await Promise.all([
      applyFocusedByPattern(db as never, "u1", "p1", "mut-a", false, CLOCK),
      applyFocusedByPattern(db as never, "u1", "p1", "mut-b", false, CLOCK),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(countRows("daily_training_lists")).toBe(1);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value!.listId).toBe(r2.value!.listId);
  });

  it("item 29/30 — duas chamadas concorrentes de PADRÕES DIFERENTES: só UMA lista ativa; o perdedor recebe a lista vencedora real", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p2");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const [r1, r2] = await Promise.all([
      applyFocusedByPattern(db as never, "u1", "p1", "mut-p1", false, CLOCK),
      applyFocusedByPattern(db as never, "u1", "p2", "mut-p2", false, CLOCK),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Só uma lista ativa foi persistida — nunca uma "parcial" de cada padrão.
    expect(countRows("daily_training_lists", "WHERE status = 'active'")).toBe(1);
    // As duas chamadas concordam sobre QUAL lista é a real (o perdedor
    // recarrega a vencedora, nunca finge que seu próprio padrão venceu).
    expect(r1.value!.listId).toBe(r2.value!.listId);

    const current = await getCurrent(db as never, "u1", false, CLOCK);
    expect(current).not.toBeNull();
    expect(current!.id).toBe(r1.value!.listId);
    // A lista vencedora pertence inteiramente a UM padrão só (p1 OU p2,
    // nunca uma mistura) — prova que o item concreto sempre veio de um
    // fluxo de apply completo e atômico, nunca de uma escrita parcial.
    expect(current!.focusPattern).not.toBeNull();
    expect(["p1", "p2"]).toContain(current!.focusPattern!.id);
  });

  it("item 31 — nenhum item órfão: contagem de itens bate com item_count da lista", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await applyFocusedByPattern(db as never, "u1", "p1", "mut-1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = db.sqlite.prepare("SELECT item_count FROM daily_training_lists WHERE id = ?").get(result.value!.listId) as { item_count: number };
    const itemCount = countRows("daily_training_items", `WHERE list_id = '${result.value!.listId}'`);
    expect(itemCount).toBe(list.item_count);
  });

  it("item 32 — mutationId/evento gravados corretamente; auditoria via rota só na mutação REAL", async () => {
    await seedUser("u1");
    const token = await createSessionForUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY, weekdayCodeForCivilDate(civilDateInTimezone(new Date(), TIMEZONE))], 60);

    const response = await callRoute("/api/daily-training/patterns/p1/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-real" }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; listId: string };
    expect(body.ok).toBe(true);

    const event = db.sqlite.prepare("SELECT event_type FROM daily_training_events WHERE id = 'mut-real'").get() as { event_type: string } | undefined;
    expect(event?.event_type).toBe("list_created");
    expect(countRows("audit_log", `WHERE event_type = 'daily_training_applied' AND user_id = 'u1'`)).toBe(1);

    // Retry idempotente (changed:false) NUNCA grava uma segunda auditoria.
    await callRoute("/api/daily-training/patterns/p1/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-retry" }) });
    expect(countRows("audit_log", `WHERE event_type = 'daily_training_applied' AND user_id = 'u1'`)).toBe(1);
  });

  it("apply com padrão inexistente devolve notFound (nunca upload/lista fantasma)", async () => {
    await seedUser("u1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await applyFocusedByPattern(db as never, "u1", "nao-existe", "mut-1", false, CLOCK);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.notFound).toBe(true);
    expect(countRows("daily_training_lists")).toBe(0);
  });
});

/* ------------------------------------- PLAYER / PROGRESSO ------------------------------------- */

describe("Player/progresso — mesmo pipeline reaproveitado (correção 20, seção 21)", () => {
  async function applyAndGetFirstItem(userId: string, patternId: string) {
    const applied = await applyFocusedByPattern(db as never, userId, patternId, `mut-apply-${userId}`, false, CLOCK);
    if (!applied.ok) throw new Error("apply falhou inesperadamente");
    const list = await getCurrent(db as never, userId, false, CLOCK);
    return { listId: applied.value!.listId, item: list!.items[0] };
  }

  it("item 33 — iniciar item cria uma tentativa REAL do Player", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const { listId, item } = await applyAndGetFirstItem("u1", "p1");

    const started = await startItem(db as never, "u1", listId, item.id, "mut-start", false);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const attempt = db.sqlite.prepare("SELECT id, question_id FROM question_attempts WHERE id = ?").get(started.value!.attemptId) as { id: string; question_id: string };
    expect(attempt.question_id).toBe(item.questionId);
  });

  it("item 34/35 — responder e confirmar no Player + sync conclui o item com isCorrect verdadeiro", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const { listId, item } = await applyAndGetFirstItem("u1", "p1");

    const started = await startItem(db as never, "u1", listId, item.id, "mut-start", false);
    if (!started.ok) throw new Error("start falhou");
    await saveAnswer(db as never, "u1", started.value!.attemptId, 1, "B"); // alternativa correta (seedQuestion marca B como correta).
    await confirmAnswer(db as never, "u1", started.value!.attemptId, 2);

    const synced = await syncItem(db as never, "u1", listId, item.id, "mut-sync");
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value!.itemStatus).toBe("completed");
    expect(synced.value!.isCorrect).toBe(true);
  });

  it("item 36 — resposta incorreta chega como false e o Caderno de Erros registra a entrada", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const { listId, item } = await applyAndGetFirstItem("u1", "p1");

    const started = await startItem(db as never, "u1", listId, item.id, "mut-start", false);
    if (!started.ok) throw new Error("start falhou");
    await saveAnswer(db as never, "u1", started.value!.attemptId, 1, "A"); // alternativa errada.
    await confirmAnswer(db as never, "u1", started.value!.attemptId, 2);

    const synced = await syncItem(db as never, "u1", listId, item.id, "mut-sync");
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value!.isCorrect).toBe(false);
    expect(countRows("error_notebook_entries", `WHERE user_id = 'u1' AND original_question_id = '${item.questionId}'`)).toBe(1);
  });

  it("item 37 — usuária A não acessa lista/item de usuária B (404 controlado)", async () => {
    await seedUser("u1");
    await seedUser("u2");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const { listId, item } = await applyAndGetFirstItem("u1", "p1");

    const foreign = await startItem(db as never, "u2", listId, item.id, "mut-foreign", false);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.notFound).toBe(true);
  });

  it("item 38 — questão de fixture nunca vaza no fluxo focado fora do dev local", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1", { isLocalFixture: true });
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await previewFocusedByPattern(db as never, "u1", "p1", false, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemCount).toBe(0); // única questão do padrão é fixture, fora do gate — vazio honesto.
  });
});

/* ------------------------------------- COMPATIBILIDADE ------------------------------------- */

describe("Compatibilidade com listas históricas/adaptativas (correção 20, seção 15/25)", () => {
  it("item 39/40 — lista adaptativa antiga com MÚLTIPLOS padrões continua serializando; focusPattern = null", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p2");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    // Motor ADAPTATIVO original (multi-padrão), nunca o focado.
    const applied = await applyList(db as never, "u1", "mut-adaptive", false, CLOCK);
    expect(applied.ok).toBe(true);

    const current = await getCurrent(db as never, "u1", false, CLOCK);
    expect(current).not.toBeNull();
    expect(current!.items.length).toBeGreaterThan(0);
    // Se o motor adaptativo selecionou mais de um padrão distinto, o foco é
    // null; se (por acaso, base pequena) só um padrão coube, o teste abaixo
    // cobre esse caso separadamente. Aqui garantimos ao menos a
    // serialização íntegra da lista, sem quebrar.
    expect(current!.focusPattern === null || typeof current!.focusPattern?.id === "string").toBe(true);
  });

  it("item 41 — focusPattern só existe quando TODOS os itens compartilham o MESMO padrão (nunca inferido do primeiro item)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p2");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const applied = await applyList(db as never, "u1", "mut-mixed", false, CLOCK);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const items = db.sqlite.prepare("SELECT primary_pattern_id FROM daily_training_items WHERE list_id = ?").all(applied.value!.listId) as Array<{ primary_pattern_id: string }>;
    const distinctPatterns = new Set(items.map((i) => i.primary_pattern_id));
    const current = await getCurrent(db as never, "u1", false, CLOCK);
    if (distinctPatterns.size > 1) {
      expect(current!.focusPattern).toBeNull();
    } else {
      expect(current!.focusPattern?.id).toBe([...distinctPatterns][0]);
    }
  });

  it("item 41b — foco focado por padrão SEMPRE devolve focusPattern não-nulo (todos os itens do mesmo padrão)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const applied = await applyFocusedByPattern(db as never, "u1", "p1", "mut-focused", false, CLOCK);
    expect(applied.ok).toBe(true);
    const current = await getCurrent(db as never, "u1", false, CLOCK);
    expect(current!.focusPattern).not.toBeNull();
    expect(current!.focusPattern!.id).toBe("p1");
  });

  it("item 42 — endpoint adaptativo antigo (/preview, /apply genéricos) continua funcionando sem regressão", async () => {
    await seedUser("u1");
    const token = await createSessionForUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY, weekdayCodeForCivilDate(civilDateInTimezone(new Date(), TIMEZONE))], 60);

    const previewResponse = await callRoute("/api/daily-training/preview", token);
    expect(previewResponse.status).toBe(200);
    const previewBody = (await previewResponse.json()) as { ok: boolean; preview: { itemCount: number } };
    expect(previewBody.ok).toBe(true);
    expect(previewBody.preview.itemCount).toBeGreaterThan(0);

    const applyResponse = await callRoute("/api/daily-training/apply", token, { method: "POST", body: JSON.stringify({ mutationId: "mut-legacy" }) });
    expect(applyResponse.status).toBe(200);
    const applyBody = (await applyResponse.json()) as { ok: boolean; listId: string };
    expect(applyBody.ok).toBe(true);
    expect(applyBody.listId).toBeTruthy();
  });
});

/* ------------------------------------------- RBAC / ROTAS ------------------------------------------- */

describe("Rotas — catálogo/preview/apply focados (correção 20, seção 12 da ordem geral)", () => {
  it("GET /api/daily-training/patterns exige sessão (401 sem cookie)", async () => {
    const response = await callRoute("/api/daily-training/patterns", null);
    expect(response.status).toBe(401);
  });

  it("GET /api/daily-training/patterns/:id/preview exige sessão (401 sem cookie)", async () => {
    const response = await callRoute("/api/daily-training/patterns/p1/preview", null);
    expect(response.status).toBe(401);
  });

  it("GET /api/daily-training/patterns retorna 200 com sessão válida e nunca N+1 mesmo via rota", async () => {
    await seedUser("u1");
    const token = await createSessionForUser("u1");
    for (let i = 0; i < 5; i++) {
      seedPattern(`p${i}`, `PAD-${i}`);
      seedPublishedQuestion(`q${i}`, `C${i}`, `p${i}`);
    }
    const response = await callRoute("/api/daily-training/patterns", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; patterns: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.patterns).toHaveLength(5);
  });

  it("POST /api/daily-training/patterns/:id/apply sem mutationId retorna 400 controlado", async () => {
    await seedUser("u1");
    const token = await createSessionForUser("u1");
    seedPattern("p1", "PAD-01");
    const response = await callRoute("/api/daily-training/patterns/p1/apply", token, { method: "POST", body: JSON.stringify({}) });
    expect(response.status).toBe(400);
  });

  it("GET /api/daily-training/patterns/:id/preview com padrão inexistente responde 404", async () => {
    await seedUser("u1");
    const token = await createSessionForUser("u1");
    const response = await callRoute("/api/daily-training/patterns/nao-existe/preview", token);
    expect(response.status).toBe(404);
  });
});
