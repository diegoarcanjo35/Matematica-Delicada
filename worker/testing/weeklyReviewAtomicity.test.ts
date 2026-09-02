// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleWeeklyReviewRequest } from "../src/routes/weeklyReview";
import { applyGoal, patchGoal, type MutationResult } from "../src/services/weeklyReviewService";
import {
  buildDeleteGoalPatternsStatement,
  buildGoalEventInsertStatement,
  buildInsertGoalPatternStatement,
  buildPatchGoalStatement,
} from "../src/repositories/weeklyReviewRepository";

/* Sprint 13 v1.0 — provas DIRETAS no banco (nunca só a resposta HTTP) das
   garantias de atomicidade/idempotência/concorrência exigidas pela seção 9
   da ordem, mesmo padrão de worker/testing/simulationsAtomicity.test.ts
   (Sprint 12) e worker/testing/dailyTrainingAtomicity.test.ts (Sprint 11):
     - dois applies concorrentes para a MESMA semana deixam exatamente uma
       meta ativa;
     - falha genuína forçada em CADA statement obrigatório (núcleo, padrão,
       evento) reverte a transação INTEIRA — nunca escrita parcial;
     - colisão de mutationId (TOCTOU real, duas operações DIFERENTES) é
       arbitrada pela PK real de weekly_goal_events, nunca por sorte de
       scheduler;
     - PATCH concorrente com a mesma versão: exatamente um vence;
     - auditoria só é gravada quando a mutação é REAL (changed === true). */

let db: FakeD1Database;

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
  const response = await handleWeeklyReviewRequest(request, localEnv(), url);
  return response!;
}

const WEEK_START = "2026-08-31";

describe("dois applies concorrentes para a MESMA semana deixam exatamente uma meta ativa (seção 9 da ordem)", () => {
  it("DUAS chamadas concorrentes com mutationIds DIFERENTES: exatamente uma meta ativa, resultado CONTROLADO para a perdedora (nunca tratada como retry só por conteúdo igual)", async () => {
    await seedUser("u-race-apply");
    const req = { weekStart: WEEK_START, targetMinutes: 150, targetQuestions: 30, availableDays: [] as string[], patternIds: [] as string[] };

    const [r1, r2] = await Promise.all([
      applyGoal(db as never, "u-race-apply", { mutationId: "mut-a", ...req }),
      applyGoal(db as never, "u-race-apply", { mutationId: "mut-b", ...req }),
    ]);

    const results = [r1, r2];
    const winners = results.filter((r) => r.ok === true && r.changed === true);
    const losers = results.filter((r) => r.ok === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].activeElsewhere).toBe(true);
    expect(countRows("weekly_study_goals", "WHERE status = 'active'")).toBe(1);
    expect(countRows("weekly_study_goals")).toBe(1);
    expect(countRows("weekly_goal_events")).toBe(1);
  });
});

describe("falha forçada em cada statement obrigatório reverte a transação INTEIRA (seção 9 da ordem)", () => {
  it("apply: INSERT de weekly_study_goals forçado a falhar não deixa padrão nem evento órfão", async () => {
    await seedUser("u-fail-core");
    db.failNextMatching(/INSERT INTO weekly_study_goals/);
    await expect(
      applyGoal(db as never, "u-fail-core", { mutationId: "mut-1", weekStart: WEEK_START, targetMinutes: 150, targetQuestions: 30, availableDays: [], patternIds: [] })
    ).rejects.toThrow();
    expect(countRows("weekly_study_goals")).toBe(0);
    expect(countRows("weekly_goal_patterns")).toBe(0);
    expect(countRows("weekly_goal_events")).toBe(0);
  });

  it("apply: INSERT de weekly_goal_patterns forçado a falhar reverte TAMBÉM o núcleo já inserido antes dela no mesmo lote", async () => {
    await seedUser("u-fail-pattern");
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('p1','PAD-01','padrao-01','Padrão 1','F','D','E','X','R','published')`
    );
    db.failNextMatching(/INSERT INTO weekly_goal_patterns/);
    await expect(
      applyGoal(db as never, "u-fail-pattern", {
        mutationId: "mut-1",
        weekStart: WEEK_START,
        targetMinutes: 150,
        targetQuestions: 30,
        availableDays: [],
        patternIds: ["p1"],
      })
    ).rejects.toThrow();
    expect(countRows("weekly_study_goals")).toBe(0);
    expect(countRows("weekly_goal_patterns")).toBe(0);
    expect(countRows("weekly_goal_events")).toBe(0);
  });

  it("apply: INSERT de weekly_goal_events forçado a falhar reverte núcleo E padrões (nenhuma meta fantasma sem evento)", async () => {
    await seedUser("u-fail-event");
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('p1','PAD-01','padrao-01','Padrão 1','F','D','E','X','R','published')`
    );
    db.failNextMatching(/INSERT INTO weekly_goal_events/);
    await expect(
      applyGoal(db as never, "u-fail-event", {
        mutationId: "mut-1",
        weekStart: WEEK_START,
        targetMinutes: 150,
        targetQuestions: 30,
        availableDays: [],
        patternIds: ["p1"],
      })
    ).rejects.toThrow();
    expect(countRows("weekly_study_goals")).toBe(0);
    expect(countRows("weekly_goal_patterns")).toBe(0);
    expect(countRows("weekly_goal_events")).toBe(0);
  });

  it("PATCH: falha forçada no evento reverte também o UPDATE do núcleo e a troca de padrões já executados no mesmo lote", async () => {
    await seedUser("u-fail-patch");
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('p1','PAD-01','padrao-01','Padrão 1','F','D','E','X','R','published'), ('p2','PAD-02','padrao-02','Padrão 2','F','D','E','X','R','published')`
    );
    const applied = await applyGoal(db as never, "u-fail-patch", {
      mutationId: "mut-apply",
      weekStart: WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: ["p1"],
    });
    if (!applied.ok) throw new Error("esperado ok");
    const goalId = applied.value!.goalId;

    db.failNextMatching(/INSERT INTO weekly_goal_events/);
    await expect(patchGoal(db as never, "u-fail-patch", goalId, { targetMinutes: 999, patternIds: ["p2"], version: 1, mutationId: "mut-patch" })).rejects.toThrow();

    const row = db.sqlite.prepare("SELECT target_minutes, version FROM weekly_study_goals WHERE id = ?").get(goalId) as { target_minutes: number; version: number };
    expect(row.target_minutes).toBe(150); // intocado
    expect(row.version).toBe(1);
    const patterns = db.sqlite.prepare("SELECT pattern_id FROM weekly_goal_patterns WHERE goal_id = ?").all(goalId) as { pattern_id: string }[];
    expect(patterns.map((p) => p.pattern_id)).toEqual(["p1"]); // troca revertida
  });
});

describe("Correção A v1.1 — falha SILENCIOSA em statement de padrões (WHERE não bate, sem lançar) — auditoria adversarial pedida pela PO", () => {
  it("[prova adversarial] PATCH que troca padrões: se o DELETE dos padrões antigos silenciosamente afeta 0 linhas (goalId inconsistente, sem lançar), o trigger de identidade deve abortar a transação inteira", async () => {
    await seedUser("u-silent-delete");
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('p1','PAD-01','padrao-01','Padrão 1','F','D','E','X','R','published'), ('p2','PAD-02','padrao-02','Padrão 2','F','D','E','X','R','published')`
    );
    const applied = await applyGoal(db as never, "u-silent-delete", {
      mutationId: "mut-apply",
      weekStart: WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: ["p1"],
    });
    if (!applied.ok) throw new Error("esperado ok");
    const goalId = applied.value!.goalId;

    // Reprodução adversarial EXATA pedida pela PO: um statement de padrões
    // (aqui, o DELETE que deveria remover a coleção antiga) cujo WHERE não
    // casa NENHUMA linha (goalId inconsistente, simulando um bug hipotético
    // de aplicação), afetando 0 linhas SEM lançar nenhum erro — composto no
    // MESMO lote que o UPDATE do núcleo e o INSERT do evento, ambos
    // corretos e usando o goalId REAL da meta.
    const statements = [
      buildPatchGoalStatement(db as never, {
        goalId,
        userId: "u-silent-delete",
        guardVersion: 1,
        mutationId: "mut-patch",
        targetMinutes: undefined,
        targetQuestions: undefined,
        availableDaysProvided: false,
        availableDays: [],
      }),
      // goalId ERRADO de propósito: WHERE não casa nenhuma linha -> DELETE
      // afeta 0 linhas, SEM THROW nenhum (mesmo comportamento de um UPDATE/
      // DELETE guardado que não bate no SQLite/D1 real).
      buildDeleteGoalPatternsStatement(db as never, { goalId: "goal-id-que-nao-existe", userId: "u-silent-delete" }),
      // priority_position=2 (nunca 1) DE PROPÓSITO: p1 (não removido pelo
      // DELETE que falhou em silêncio) continua ocupando a posição 1 — usar
      // a posição 2 evita que a prova dependa de um efeito colateral
      // acidental (violação de UNIQUE(goal_id, priority_position)), que
      // provaria outra coisa (constraint de posição), não a lacuna real de
      // identidade que esta prova quer isolar.
      buildInsertGoalPatternStatement(db as never, { id: "wp-new", goalId, userId: "u-silent-delete", patternId: "p2", priorityPosition: 2, mutationId: "mut-patch" }),
      buildGoalEventInsertStatement(db as never, {
        id: "mut-patch",
        goalId,
        userId: "u-silent-delete",
        eventType: "goal_updated",
        fromStatus: "active",
        toStatus: "active",
        goalVersion: 2,
        patternsExpectedCount: 1, // este PATCH afirma "a coleção agora tem exatamente 1 padrão (p2)"
      }),
    ];

    // Comportamento SEGURO esperado (e agora REAL, após a correção A v1.1):
    // o banco aborta a transação inteira, porque a coleção de padrões não
    // reflete de verdade a substituição que este evento afirma ter feito
    // (p1 continuaria lá, "coexistindo" com p2 — a troca pedida pelo PATCH
    // nunca aconteceu de verdade). Esta é a prova adversarial pedida pela
    // seção 2.2 da ordem — ANTES da correção, esta mesma chamada resolvia
    // com sucesso (ver o relatório final da rodada para o resultado RED
    // literal capturado antes do fix).
    await expect(db.batch(statements as never)).rejects.toThrow(/invariante violada/i);
    // Nada foi commitado: nem o núcleo avançou de versão, nem sobrou p2 solto.
    const row = db.sqlite.prepare("SELECT version FROM weekly_study_goals WHERE id = ?").get(goalId) as { version: number };
    expect(row.version).toBe(1);
    const patterns = db.sqlite.prepare("SELECT pattern_id FROM weekly_goal_patterns WHERE goal_id = ?").all(goalId) as { pattern_id: string }[];
    expect(patterns.map((p) => p.pattern_id)).toEqual(["p1"]); // estado original intocado
  });

  it("[prova adversarial] limpeza explícita (patterns: []): se o DELETE dos padrões antigos silenciosamente afeta 0 linhas, o trigger também aborta (nunca aceita uma 'limpeza' que na verdade não limpou nada)", async () => {
    await seedUser("u-silent-clear");
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('p1','PAD-01','padrao-01','Padrão 1','F','D','E','X','R','published')`
    );
    const applied = await applyGoal(db as never, "u-silent-clear", {
      mutationId: "mut-apply",
      weekStart: WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: ["p1"],
    });
    if (!applied.ok) throw new Error("esperado ok");
    const goalId = applied.value!.goalId;

    const statements = [
      buildPatchGoalStatement(db as never, {
        goalId,
        userId: "u-silent-clear",
        guardVersion: 1,
        mutationId: "mut-patch",
        targetMinutes: undefined,
        targetQuestions: undefined,
        availableDaysProvided: false,
        availableDays: [],
      }),
      // Mesmo goalId ERRADO de propósito: a "limpeza" não remove nada de verdade.
      buildDeleteGoalPatternsStatement(db as never, { goalId: "goal-id-que-nao-existe", userId: "u-silent-clear" }),
      // patternIds: [] -> nenhum INSERT de padrão novo (coleção deveria ficar vazia).
      buildGoalEventInsertStatement(db as never, {
        id: "mut-patch",
        goalId,
        userId: "u-silent-clear",
        eventType: "goal_updated",
        fromStatus: "active",
        toStatus: "active",
        goalVersion: 2,
        patternsExpectedCount: 0, // este PATCH afirma "a coleção agora está vazia"
      }),
    ];

    await expect(db.batch(statements as never)).rejects.toThrow(/invariante violada/i);
    const patterns = db.sqlite.prepare("SELECT pattern_id FROM weekly_goal_patterns WHERE goal_id = ?").all(goalId) as { pattern_id: string }[];
    expect(patterns.map((p) => p.pattern_id)).toEqual(["p1"]); // "limpeza" falsa nunca foi commitada
  });

  it("[caminho feliz, prova TRANSACIONAL] limpeza explícita (patterns: []) real: coleção fica genuinamente vazia, versão avança, exatamente um evento novo — mesma transação, provado pelo próprio trigger de identidade (nunca só 'a contagem terminou em zero por coincidência')", async () => {
    await seedUser("u-real-clear");
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('p1','PAD-01','padrao-01','Padrão 1','F','D','E','X','R','published')`
    );
    const applied = await applyGoal(db as never, "u-real-clear", {
      mutationId: "mut-apply",
      weekStart: WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: ["p1"],
    });
    if (!applied.ok) throw new Error("esperado ok");
    const goalId = applied.value!.goalId;

    const patched = await patchGoal(db as never, "u-real-clear", goalId, { patternIds: [], version: 1, mutationId: "mut-clear" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.changed).toBe(true);
    expect(patched.value!.goal.patterns).toEqual([]);

    // Prova DIRETA no banco (nunca só o retorno da função): a coleção está
    // genuinamente vazia — e o próprio trigger de identidade (rodado DENTRO
    // da mesma transação, ANTES do commit) já teria abortado se sobrasse
    // qualquer linha órfã de uma mutação anterior ou se a contagem
    // divergisse do 0 declarado pelo evento — isso já é a prova
    // transacional, não uma coincidência de contagem observada depois.
    expect(countRows("weekly_goal_patterns", `WHERE goal_id = '${goalId}'`)).toBe(0);
    const goalRow = db.sqlite.prepare("SELECT version FROM weekly_study_goals WHERE id = ?").get(goalId) as { version: number };
    expect(goalRow.version).toBe(2);
    expect(countRows("weekly_goal_events", `WHERE goal_id = '${goalId}'`)).toBe(2); // goal_created + goal_updated, nunca mais
    const eventRow = db.sqlite.prepare("SELECT patterns_expected_count FROM weekly_goal_events WHERE id = 'mut-clear'").get() as {
      patterns_expected_count: number;
    };
    expect(eventRow.patterns_expected_count).toBe(0);
  });
});

describe("colisão de mutationId (TOCTOU real) — seção 9 da ordem", () => {
  it("corrida real: duas chamadas CONCORRENTES de apply, SEMANAS DIFERENTES, MESMO mutationId — exatamente uma vence, a outra recebe 409 controlado (nunca uma exceção crua)", async () => {
    await seedUser("u-toctou-apply");
    const SHARED_MUTATION_ID = "toctou-shared-mut";

    const gate = db.pauseReadsMatching(/SELECT 1 AS found FROM weekly_goal_events WHERE id = \?/, 2);

    const racePromise = Promise.allSettled([
      applyGoal(db as never, "u-toctou-apply", {
        mutationId: SHARED_MUTATION_ID,
        weekStart: "2026-08-31",
        targetMinutes: 150,
        targetQuestions: 30,
        availableDays: [],
        patternIds: [],
      }),
      applyGoal(db as never, "u-toctou-apply", {
        mutationId: SHARED_MUTATION_ID,
        weekStart: "2026-09-07",
        targetMinutes: 150,
        targetQuestions: 30,
        availableDays: [],
        patternIds: [],
      }),
    ]);

    await gate.arrived;
    expect(countRows("weekly_goal_events", `WHERE id = '${SHARED_MUTATION_ID}'`)).toBe(0);
    gate.release();

    const [r1, r2] = await racePromise;
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? (r.value as MutationResult<{ goalId: string }>) : null));

    const winners = results.filter((r) => r?.ok === true && r.changed === true);
    const losers = results.filter((r) => r?.ok === false && r.conflict === true);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(countRows("weekly_study_goals")).toBe(1); // a perdedora nunca deixou meta órfã
    expect(countRows("weekly_goal_events")).toBe(1);
  });
});

describe("PATCH concorrente com a mesma versão — exatamente um vence", () => {
  it("duas chamadas CONCORRENTES de patchGoal na MESMA meta/versão: exatamente uma aplica, a outra recebe conflito controlado", async () => {
    await seedUser("u-patch-race");
    const applied = await applyGoal(db as never, "u-patch-race", {
      mutationId: "mut-apply",
      weekStart: WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: [],
    });
    if (!applied.ok) throw new Error("esperado ok");
    const goalId = applied.value!.goalId;

    const [r1, r2] = await Promise.all([
      patchGoal(db as never, "u-patch-race", goalId, { targetMinutes: 200, version: 1, mutationId: "mut-patch-a" }),
      patchGoal(db as never, "u-patch-race", goalId, { targetMinutes: 300, version: 1, mutationId: "mut-patch-b" }),
    ]);

    const results = [r1, r2];
    const winners = results.filter((r) => r.ok === true && r.changed === true);
    const losers = results.filter((r) => r.ok === false && r.conflict === true);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    const row = db.sqlite.prepare("SELECT version FROM weekly_study_goals WHERE id = ?").get(goalId) as { version: number };
    expect(row.version).toBe(2); // só uma escrita real avançou a versão
  });
});

describe("auditoria só em mutação REAL (seção 10 da ordem)", () => {
  it("apply repetido com o MESMO mutationId audita uma única vez (retry idempotente não duplica auditoria)", async () => {
    await seedUser("u-audit");
    const token = await createSessionForUser("u-audit");
    const body = JSON.stringify({ mutationId: "mut-1", weekStart: WEEK_START, targetMinutes: 150, targetQuestions: 30, availableDays: [], patternIds: [] });

    const r1 = await callRoute("/api/weekly-goals/apply", token, { method: "POST", body });
    expect(r1.status).toBe(200);
    const r2 = await callRoute("/api/weekly-goals/apply", token, { method: "POST", body });
    expect(r2.status).toBe(200);

    expect(countRows("audit_log", "WHERE event_type = 'weekly_goal_created'")).toBe(1);
  });

  it("GET current/history/preview nunca gravam audit_log", async () => {
    await seedUser("u-audit-get");
    const token = await createSessionForUser("u-audit-get");
    await callRoute("/api/weekly-review/current", token);
    await callRoute("/api/weekly-review/history", token);
    await callRoute(`/api/weekly-goals/preview?weekStart=${WEEK_START}`, token);
    expect(countRows("audit_log")).toBe(0);
  });

  it("acesso sem sessão retorna 401 em todas as rotas", async () => {
    const r1 = await callRoute("/api/weekly-review/current", null);
    expect(r1.status).toBe(401);
    const r2 = await callRoute("/api/weekly-goals/apply", null, { method: "POST", body: "{}" });
    expect(r2.status).toBe(401);
  });

  it("método inválido responde 405", async () => {
    await seedUser("u-405");
    const token = await createSessionForUser("u-405");
    const r = await callRoute("/api/weekly-review/current", token, { method: "POST" });
    expect(r.status).toBe(405);
  });
});
