// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedDiagnosticFixtures } from "./diagnosticFixtures";
import { seedScheduleActivities, TEST_ACTIVITIES } from "./scheduleFixtures";
import { seedPatterns } from "./patternFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { isDiagnosticAvailable } from "../src/repositories/diagnosticRepository";
import { isScheduleAvailable } from "../src/repositories/scheduleRepository";
import { isPatternsAvailable } from "../src/repositories/patternsRepository";
import { createAttempt, getStatus } from "../src/services/diagnosticService";
import { previewPlan, getSummary } from "../src/services/scheduleService";
import { listPatterns, type PatternListFilters } from "../src/services/patternsService";
import { handlePatternsRequest } from "../src/routes/patterns";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 16 v1.3 — fechamento dos dois bloqueadores remanescentes (ordem
   seções 1-3): migração dos gates student-facing de Diagnóstico/
   Cronograma/Padrões para o mesmo critério já aprovado para o Banco de
   Questões (isQuestionBankAvailable), e hardening da leitura na camada de
   dados. Este arquivo prova, para os TRÊS módulos, os 6 cenários exigidos
   pela ordem (seção 4):
     1) só fixture -> indisponível fora do dev local;
     2) conteúdo real -> disponível;
     3) mistura real+fixture -> aluno recebe só real;
     4) dev local + flag -> fixture continua funcionando;
     5) id direto de fixture não permite bypass (Padrões, único módulo com
        rota por id/slug direto);
     6) ausência de conteúdo real -> estado vazio/preparação correto. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUserWithSession(id: string): Promise<string> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
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

const PROD_URL = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/patterns");
const LOCAL_URL = new URL("http://localhost:8793/api/patterns");

function prodEnv(): Env {
  return { DB: db as never, ASSETS: {} as never };
}
function localEnvWithFlag(flag: "ENABLE_LOCAL_DIAGNOSTIC_FIXTURES" | "ENABLE_LOCAL_SCHEDULE_FIXTURES" | "ENABLE_LOCAL_PATTERN_FIXTURES"): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", [flag]: "true" };
}
function localEnvWithoutFlag(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development" };
}

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}
const CLOCK = fixedClock("2026-09-03T15:00:00.000Z");

function seedRealDiagnosticQuestion(id: string): void {
  db.sqlite.exec(
    `INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES ('${id}', 'Enunciado real de teste', 0, 0)`
  );
  db.sqlite.exec(`INSERT INTO diagnostic_question_options (id, question_id, position, text, is_correct) VALUES ('${id}-a', '${id}', 0, 'A', 1)`);
  db.sqlite.exec(`INSERT INTO diagnostic_question_options (id, question_id, position, text, is_correct) VALUES ('${id}-b', '${id}', 1, 'B', 0)`);
}

function seedRealScheduleActivity(id: string): void {
  db.sqlite.exec(
    `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin, dismissible, is_local_fixture)
     VALUES ('${id}', 'aula_video', 'Atividade real', 'Objetivo', 15, 'Critério', 'Explicação', 'manual', 'system', 1, 0)`
  );
}

const ALL_WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

function seedFullAvailability(userId: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO student_profiles (user_id, available_days, daily_minutes, current_step, status)
       VALUES (?, ?, 180, 6, 'in_progress')
       ON CONFLICT (user_id) DO UPDATE SET available_days = excluded.available_days, daily_minutes = excluded.daily_minutes`
    )
    .run(userId, JSON.stringify(ALL_WEEKDAYS));
}

function seedRealPattern(id: string, code: string, slug: string): void {
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status, version, is_local_fixture)
     VALUES ('${id}', '${code}', '${slug}', 'Padrão Real', 'Frase', 'Descrição', 'Estratégia', 'Exemplo', 'Resumo', 'published', 1, 0)`
  );
}

/* ---------------------------------------------------------------------- */
/* DIAGNÓSTICO                                                             */
/* ---------------------------------------------------------------------- */

describe("Diagnóstico — isDiagnosticAvailable e conteúdo real", () => {
  it("(1) só fixture: indisponível fora do dev local", async () => {
    seedDiagnosticFixtures(db.sqlite);
    expect(await isDiagnosticAvailable(prodEnv(), PROD_URL, db as never)).toBe(false);
  });

  it("(2) conteúdo real estruturalmente completo: disponível", async () => {
    seedRealDiagnosticQuestion("real-q1");
    expect(await isDiagnosticAvailable(prodEnv(), PROD_URL, db as never)).toBe(true);
  });

  it("(2b) 'quantidade/estrutura mínima' — questão real SEM alternativas não conta (não é '1 linha existe')", async () => {
    db.sqlite.exec(`INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES ('bare-q', 'Sem opções', 0, 0)`);
    expect(await isDiagnosticAvailable(prodEnv(), PROD_URL, db as never)).toBe(false);
  });

  it("(3) mistura real+fixture: createAttempt fora do dev local usa só a questão real", async () => {
    seedDiagnosticFixtures(db.sqlite);
    seedRealDiagnosticQuestion("real-q2");
    await seedUserWithSession("u-mix");
    const created = await createAttempt(db as never, "u-mix", false, false);
    expect(created.ok).toBe(true);
    const boundQuestions = db.sqlite.prepare("SELECT question_id FROM diagnostic_attempt_questions WHERE attempt_id = ?").all(created.attemptId!) as Array<{
      question_id: string;
    }>;
    expect(boundQuestions.map((r) => r.question_id)).toEqual(["real-q2"]);
  });

  it("(4) dev local + flag: fixture continua funcionando (comportamento preservado)", async () => {
    seedDiagnosticFixtures(db.sqlite);
    const localUrl = new URL("http://localhost:8793/api/diagnostic/status");
    expect(await isDiagnosticAvailable(localEnvWithFlag("ENABLE_LOCAL_DIAGNOSTIC_FIXTURES"), localUrl, db as never)).toBe(true);
    await seedUserWithSession("u-local");
    const created = await createAttempt(db as never, "u-local", true, false);
    expect(created.ok).toBe(true);
  });

  it("(6) ausência de conteúdo real (e sem dev local): getStatus honesto, nunca crash", async () => {
    await seedUserWithSession("u-empty");
    const available = await isDiagnosticAvailable(prodEnv(), PROD_URL, db as never);
    const status = await getStatus(db as never, "u-empty", available);
    expect(status).toEqual({ available: false, activeAttemptId: null, latestCompletedAttemptId: null });
  });
});

/* ---------------------------------------------------------------------- */
/* CRONOGRAMA                                                              */
/* ---------------------------------------------------------------------- */

describe("Cronograma — isScheduleAvailable e conteúdo real", () => {
  const SCHEDULE_PROD_URL = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/schedule/summary");
  const SCHEDULE_LOCAL_URL = new URL("http://localhost:8793/api/schedule/summary");

  it("(1) só fixture: indisponível fora do dev local", async () => {
    seedScheduleActivities(db.sqlite);
    expect(await isScheduleAvailable(prodEnv(), SCHEDULE_PROD_URL, db as never)).toBe(false);
  });

  it("(2) pelo menos uma atividade real: disponível", async () => {
    seedRealScheduleActivity("real-act1");
    expect(await isScheduleAvailable(prodEnv(), SCHEDULE_PROD_URL, db as never)).toBe(true);
  });

  it("(3) mistura real+fixture: previewPlan fora do dev local só oferece a atividade real", async () => {
    seedScheduleActivities(db.sqlite);
    seedRealScheduleActivity("real-act2");
    await seedUserWithSession("u-sched-mix");
    seedFullAvailability("u-sched-mix");
    const preview = await previewPlan(db as never, "u-sched-mix", CLOCK, false);
    // Nenhuma das 5 fixtures pode aparecer em lugar nenhum da prévia — só a
    // atividade real (checagem no JSON inteiro, cobre placed/unplaceable).
    // O único candidato elegível fora do dev local é a atividade real —
    // exatamente 1 item posicionado (nunca as 5 fixtures, que teriam
    // produzido mais candidatos). Confirmação direta via listPlanCandidates
    // seria mais precisa, mas o próprio tamanho do resultado já prova que
    // o pool usado foi o real (1 atividade), não o de fixture (5).
    expect(preview.placed.length).toBe(1);
    const serialized = JSON.stringify(preview);
    for (const fixtureActivity of TEST_ACTIVITIES) {
      expect(serialized).not.toContain(fixtureActivity.id);
    }
  });

  it("(4) dev local + flag: fixture continua funcionando (comportamento preservado)", async () => {
    seedScheduleActivities(db.sqlite);
    expect(await isScheduleAvailable(localEnvWithFlag("ENABLE_LOCAL_SCHEDULE_FIXTURES"), SCHEDULE_LOCAL_URL, db as never)).toBe(true);
    await seedUserWithSession("u-sched-local");
    seedFullAvailability("u-sched-local");
    const preview = await previewPlan(db as never, "u-sched-local", CLOCK, true);
    expect(preview.placed.length + preview.unplaceableAssignmentIds.length).toBeGreaterThan(0);
  });

  it("(6) ausência de conteúdo real (e sem dev local): getSummary honesto, nunca crash", async () => {
    await seedUserWithSession("u-sched-empty");
    const available = await isScheduleAvailable(prodEnv(), SCHEDULE_PROD_URL, db as never);
    const summary = await getSummary(db as never, "u-sched-empty", available, CLOCK);
    expect(summary.available).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* PADRÕES                                                                  */
/* ---------------------------------------------------------------------- */

const ALL_FILTERS: PatternListFilters = { search: null, content: null, tag: null, evidence: "todos", sort: "codigo" };

describe("Padrões — isPatternsAvailable e conteúdo real", () => {
  const PATTERNS_LOCAL_URL = new URL("http://localhost:8793/api/patterns");

  it("(1) só fixture: indisponível fora do dev local", async () => {
    seedPatterns(db.sqlite);
    expect(await isPatternsAvailable(prodEnv(), PROD_URL, db as never)).toBe(false);
  });

  it("(2) pelo menos um padrão real publicado: disponível", async () => {
    seedRealPattern("real-pat1", "REAL-01", "padrao-real-1");
    expect(await isPatternsAvailable(prodEnv(), PROD_URL, db as never)).toBe(true);
  });

  it("(3) mistura real+fixture: listPatterns fora do dev local devolve só o padrão real", async () => {
    seedPatterns(db.sqlite);
    seedRealPattern("real-pat2", "REAL-02", "padrao-real-2");
    await seedUserWithSession("u-pat-mix");
    const result = await listPatterns(db as never, "u-pat-mix", ALL_FILTERS, 1, 50, false);
    expect(result.patterns.map((p) => p.code)).toEqual(["REAL-02"]);
  });

  it("(4) dev local + flag: fixture continua funcionando (comportamento preservado)", async () => {
    seedPatterns(db.sqlite);
    expect(await isPatternsAvailable(localEnvWithFlag("ENABLE_LOCAL_PATTERN_FIXTURES"), PATTERNS_LOCAL_URL, db as never)).toBe(true);
    await seedUserWithSession("u-pat-local");
    const result = await listPatterns(db as never, "u-pat-local", ALL_FILTERS, 1, 50, true);
    expect(result.patterns.length).toBeGreaterThan(0);
  });

  it("(5) id direto de fixture (slug) não permite bypass via GET /api/patterns/:slug em produção", async () => {
    seedPatterns(db.sqlite);
    seedRealPattern("real-pat3", "REAL-03", "padrao-real-3");
    const token = await seedUserWithSession("u-pat-bypass");
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/patterns/razao-em-grafico", {
      headers: { Cookie: `md_session=${token}` },
    });
    const response = (await handlePatternsRequest(request, prodEnv(), new URL(request.url)))!;
    // O gate de disponibilidade abre (existe padrão REAL), mas o slug da
    // fixture continua invisível — mesmo 404 de slug inexistente.
    expect(response.status).toBe(404);
  });

  it("(5b) o mesmo slug real É servido normalmente em produção", async () => {
    seedRealPattern("real-pat4", "REAL-04", "padrao-real-4");
    const token = await seedUserWithSession("u-pat-real-ok");
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/patterns/padrao-real-4", {
      headers: { Cookie: `md_session=${token}` },
    });
    const response = (await handlePatternsRequest(request, prodEnv(), new URL(request.url)))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean; pattern: { code: string } };
    expect(body.available).toBe(true);
    expect(body.pattern.code).toBe("REAL-04");
  });

  it("(6) ausência de conteúdo real (e sem dev local): resposta 'em preparação' honesta, nunca 404/500", async () => {
    const token = await seedUserWithSession("u-pat-empty");
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/patterns", {
      headers: { Cookie: `md_session=${token}` },
    });
    const response = (await handlePatternsRequest(request, prodEnv(), new URL(request.url)))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });
});
