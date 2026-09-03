// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import {
  findQuestionForStudent,
  findTrainableQuestionForPattern,
  hasAnyPublishedQuestion,
  isQuestionBankAvailable,
} from "../src/repositories/questionRepository";
import type { Env } from "../src/env";
import { listTrainableQuestionsForPattern } from "../src/repositories/dailyTrainingRepository";
import { selectSimilarQuestion } from "../src/repositories/errorNotebookRepository";
import { planStartOrResumeAttempt } from "../src/services/playerService";
import { preview as dailyTrainingPreview } from "../src/services/dailyTrainingService";
import { preview as simulationsPreview } from "../src/services/simulationsService";
import { startReview } from "../src/services/errorNotebookService";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 16 v1.1 — decisão do PO sobre o bloqueador A2 (Banco de Questões):
   "toda leitura de conteúdo destinada ao aluno deve excluir explicitamente
   fixture local (`is_local_fixture = 0`), na camada de dados, não apenas no
   gate de rota".

   Sprint 16 v1.4 — correção do achado registrado na v1.3: a regra acima
   estava correta para produção/ambientes não-locais, mas era aplicada de
   forma INCONDICIONAL — mesmo em dev local com
   ENABLE_LOCAL_EDITORIAL_FIXTURES=true, o que quebrava o teste local do
   Player/Treino Diário/Simulados/Caderno de Erros. As quatro funções de
   repositório abaixo agora recebem um parâmetro explícito
   `includeFixtures`/`fixturesAllowed`, propagado desde a rota (nunca
   recalculado a partir de header/query/body) — nunca por inferência.

   Este arquivo prova, contra um SQLite real embutido (FakeD1Database —
   nunca mocks de chamada), os 6 cenários exigidos pela ordem v1.4:
     1) produção/flag desligada + só fixture: fixture NÃO é servida;
     2) produção/flag desligada + mistura real+fixture: só a real é servida;
     3) dev local + flag ligada + só fixture: fixture É servida;
     4) dev local + flag ligada + mistura: comportamento local esperado
        preservado (a fixture é uma candidata genuína, não apenas "não some
        por acaso" — provado ordenando a fixture antes da real);
     5) id direto de fixture: só funciona no ambiente local autorizado,
        nunca fora dele;
     6) Player/Treino Diário/Simulados/Caderno de Erros permanecem
        protegidos fora do ambiente local, E voltam a servir fixture
        normalmente dentro dele. */

let db: FakeD1Database;

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

const CLOCK = fixedClock("2026-09-03T15:00:00.000Z");

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, { id, name: "Usuária Teste", email: `${id}@teste.dev`, emailNormalized: `${id}@teste.dev`, passwordHash: "hash" });
}

function seedPattern(id: string, code: string): void {
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${id}', '${code}', 'slug-${id}', 'Padrão ${id}', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
}

function seedRealQuestion(id: string, code: string, patternId: string): string {
  return seedQuestion(db.sqlite, { id, code, status: "published", version: 1, patternId, isLocalFixture: false });
}

function seedFixtureQuestion(id: string, code: string, patternId: string): string {
  return seedQuestion(db.sqlite, { id, code, status: "published", version: 1, patternId, isLocalFixture: true });
}

function seedProfile(userId: string, availableDays: string[], dailyMinutes: number): void {
  db.sqlite.exec(
    `INSERT INTO student_profiles (user_id, available_days, daily_minutes, status) VALUES ('${userId}', '${JSON.stringify(availableDays)}', ${dailyMinutes}, 'completed')`
  );
}

/* ---------------------------------------------------------------------- */
/* 1-4: camada de repositório                                              */
/* ---------------------------------------------------------------------- */

describe("findQuestionForStudent — leitura direta destinada ao aluno", () => {
  it("(1) questão real publicada é servida (includeFixtures=false, produção)", async () => {
    seedPattern("p1", "PAD-01");
    const id = seedRealQuestion("q-real", "C-REAL", "p1");
    const row = await findQuestionForStudent(db as never, id, false);
    expect(row).not.toBeNull();
    expect(row!.id).toBe("q-real");
  });

  it("(1)(6) fixture local publicada NÃO é servida ao aluno com includeFixtures=false (produção/flag desligada)", async () => {
    seedPattern("p1", "PAD-01");
    const id = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const row = await findQuestionForStudent(db as never, id, false);
    expect(row).toBeNull();
  });

  it("(3)(5) fixture local publicada É servida com includeFixtures=true (dev local + flag ligada)", async () => {
    seedPattern("p1", "PAD-01");
    const id = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const row = await findQuestionForStudent(db as never, id, true);
    expect(row).not.toBeNull();
    expect(row!.id).toBe("q-fixture");
  });

  it("(1) questão real continua servida normalmente com includeFixtures=true (dev local não deveria esconder conteúdo real)", async () => {
    seedPattern("p1", "PAD-01");
    const id = seedRealQuestion("q-real", "C-REAL", "p1");
    const row = await findQuestionForStudent(db as never, id, true);
    expect(row).not.toBeNull();
    expect(row!.id).toBe("q-real");
  });
});

describe("hasAnyPublishedQuestion — CTA do dashboard", () => {
  it("(1) true quando existe questão real publicada", async () => {
    seedPattern("p1", "PAD-01");
    seedRealQuestion("q-real", "C-REAL", "p1");
    expect(await hasAnyPublishedQuestion(db as never)).toBe(true);
  });

  it("(1) false quando só existe fixture publicada (ausência de conteúdo real é honesta, nunca mascarada pela fixture — esta checagem nunca teve conceito de ambiente local, sempre real-only)", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    expect(await hasAnyPublishedQuestion(db as never)).toBe(false);
  });
});

describe("findTrainableQuestionForPattern — CTA 'Treinar este padrão' da ficha do padrão", () => {
  it("(2) mistura real + fixture no mesmo padrão retorna somente a real com includeFixtures=false", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const realId = seedRealQuestion("q-real", "C-REAL", "p1");
    expect(await findTrainableQuestionForPattern(db as never, "p1", false)).toBe(realId);
  });

  it("(1) só fixture disponível + includeFixtures=false -> null (nunca a fixture como substituta)", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    expect(await findTrainableQuestionForPattern(db as never, "p1", false)).toBeNull();
  });

  it("(3) só fixture disponível + includeFixtures=true -> a fixture é retornada (dev local + flag ligada)", async () => {
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    expect(await findTrainableQuestionForPattern(db as never, "p1", true)).toBe(fixtureId);
  });

  it("(4) mistura real + fixture + includeFixtures=true: a fixture É uma candidata genuína (ordenada antes da real por código, e ainda assim escolhida — prova que a cláusula de exclusão está realmente ausente, não que a fixture 'nunca aparece por acaso')", async () => {
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-AAA", "p1");
    seedRealQuestion("q-real", "C-ZZZ", "p1");
    expect(await findTrainableQuestionForPattern(db as never, "p1", true)).toBe(fixtureId);
  });
});

describe("listTrainableQuestionsForPattern — candidatos do Treino Diário/Simulados", () => {
  it("(2) mistura real + fixture retorna somente a real com includeFixtures=false", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const realId = seedRealQuestion("q-real", "C-REAL", "p1");
    const rows = await listTrainableQuestionsForPattern(db as never, "p1", false);
    expect(rows.map((r) => r.id)).toEqual([realId]);
  });

  it("(1) só fixture disponível + includeFixtures=false -> lista vazia", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const rows = await listTrainableQuestionsForPattern(db as never, "p1", false);
    expect(rows).toEqual([]);
  });

  it("(3) só fixture disponível + includeFixtures=true -> a fixture aparece na lista", async () => {
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const rows = await listTrainableQuestionsForPattern(db as never, "p1", true);
    expect(rows.map((r) => r.id)).toEqual([fixtureId]);
  });

  it("(4) mistura real + fixture + includeFixtures=true: ambas aparecem na lista (comportamento local preservado)", async () => {
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const realId = seedRealQuestion("q-real", "C-REAL", "p1");
    const rows = await listTrainableQuestionsForPattern(db as never, "p1", true);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([fixtureId, realId]));
  });
});

describe("selectSimilarQuestion — 'questão semelhante' do Caderno de Erros / camada 1 do Treino Diário", () => {
  it("(2) mistura real + fixture no padrão + includeFixtures=false: escolhe a real, nunca a fixture", async () => {
    seedPattern("p1", "PAD-01");
    const originalId = seedRealQuestion("q-original", "C-ORIG", "p1");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const realAlternativeId = seedRealQuestion("q-alt-real", "C-ALT", "p1");

    const selection = await selectSimilarQuestion(
      db as never,
      { originalQuestionId: originalId, primaryPatternId: "p1", excludeQuestionIds: [] },
      false
    );
    expect(selection.questionId).toBe(realAlternativeId);
  });

  it("(1) só a fixture existiria como alternativa + includeFixtures=false -> cai para a questão original real (nunca oferece a fixture)", async () => {
    seedPattern("p1", "PAD-01");
    const originalId = seedRealQuestion("q-original", "C-ORIG", "p1");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");

    const selection = await selectSimilarQuestion(
      db as never,
      { originalQuestionId: originalId, primaryPatternId: "p1", excludeQuestionIds: [] },
      false
    );
    expect(selection.questionId).toBe(originalId);
    expect(selection.reason).toBe("original_not_yet_succeeded");
  });

  it("(3) só a fixture existiria como alternativa + includeFixtures=true -> a fixture é oferecida (dev local + flag ligada)", async () => {
    seedPattern("p1", "PAD-01");
    const originalId = seedRealQuestion("q-original", "C-ORIG", "p1");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");

    const selection = await selectSimilarQuestion(
      db as never,
      { originalQuestionId: originalId, primaryPatternId: "p1", excludeQuestionIds: [] },
      true
    );
    expect(selection.questionId).toBe(fixtureId);
  });
});

describe("isQuestionBankAvailable — novo critério de gate editorial (A2, seção 2 da ordem)", () => {
  const PROD_URL = new URL("https://matematica-delicada.proffandreia5.workers.dev/api/player/attempts");
  const LOCAL_URL = new URL("http://localhost:8793/api/player/attempts");

  it("produção real sem nenhuma questão real publicada: continua indisponível, exatamente como hoje", async () => {
    const prodEnv: Env = { DB: db as never, ASSETS: {} as never };
    expect(await isQuestionBankAvailable(prodEnv, PROD_URL, db as never)).toBe(false);
  });

  it("produção real com questão real publicada: disponível — nova capacidade, sem flag/deploy adicional", async () => {
    seedPattern("p1", "PAD-01");
    seedRealQuestion("q-real", "C-REAL", "p1");
    const prodEnv: Env = { DB: db as never, ASSETS: {} as never };
    expect(await isQuestionBankAvailable(prodEnv, PROD_URL, db as never)).toBe(true);
  });

  it("produção real com SÓ fixture publicada (nunca deveria existir, mas por garantia): continua indisponível", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const prodEnv: Env = { DB: db as never, ASSETS: {} as never };
    expect(await isQuestionBankAvailable(prodEnv, PROD_URL, db as never)).toBe(false);
  });

  it("dev local com ENABLE_LOCAL_EDITORIAL_FIXTURES habilitado: disponível incondicionalmente (comportamento antigo preservado)", async () => {
    const localEnv: Env = { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ENABLE_LOCAL_EDITORIAL_FIXTURES: "true" };
    expect(await isQuestionBankAvailable(localEnv, LOCAL_URL, db as never)).toBe(true);
  });

  it("dev local SEM a flag habilitada e sem conteúdo real: indisponível (nunca um bypass genérico)", async () => {
    const localEnvNoFlag: Env = { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development" };
    expect(await isQuestionBankAvailable(localEnvNoFlag, LOCAL_URL, db as never)).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* 6: os quatro consumidores — protegidos fora do local, liberados dentro  */
/* ---------------------------------------------------------------------- */

describe("(6) Player — startOrResumeAttempt nunca inicia tentativa numa questão de fixture fora do ambiente local", () => {
  it("questão real: inicia normalmente (fixturesAllowed=false)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const realId = seedRealQuestion("q-real", "C-REAL", "p1");
    const result = await planStartOrResumeAttempt(db as never, "u1", realId, "practice", false);
    expect(result.ok).toBe(true);
  });

  it("questão de fixture (mesmo publicada) + fixturesAllowed=false: notFound, nunca uma tentativa criada", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const result = await planStartOrResumeAttempt(db as never, "u1", fixtureId, "practice", false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notFound).toBe(true);
  });

  it("questão de fixture + fixturesAllowed=true (dev local + flag ligada): inicia normalmente", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const result = await planStartOrResumeAttempt(db as never, "u1", fixtureId, "practice", true);
    expect(result.ok).toBe(true);
  });
});

describe("(6) Treino Diário — preview nunca inclui questão de fixture fora do ambiente local, e volta a incluir dentro dele", () => {
  it("padrão com candidata SÓ fixture + fixturesAllowed=false: não contribui nenhum item", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    seedProfile("u1", ["dom", "seg", "ter", "qua", "qui", "sex", "sab"], 60);

    const result = await dailyTrainingPreview(db as never, "u1", false, CLOCK);
    expect(result.itemCount).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("padrão com mistura real + fixture + fixturesAllowed=false: item selecionado é sempre a questão real", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const realId = seedRealQuestion("q-real", "C-REAL", "p1");
    seedProfile("u1", ["dom", "seg", "ter", "qua", "qui", "sex", "sab"], 60);

    const result = await dailyTrainingPreview(db as never, "u1", false, CLOCK);
    expect(result.itemCount).toBeGreaterThan(0);
    for (const item of result.items) expect(item.questionId).toBe(realId);
  });

  it("padrão com candidata SÓ fixture + fixturesAllowed=true (dev local + flag ligada): a fixture contribui item normalmente", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    seedProfile("u1", ["dom", "seg", "ter", "qua", "qui", "sex", "sab"], 60);

    const result = await dailyTrainingPreview(db as never, "u1", true, CLOCK);
    expect(result.itemCount).toBeGreaterThan(0);
    for (const item of result.items) expect(item.questionId).toBe(fixtureId);
  });
});

describe("(6) Simulados — preview nunca inclui questão de fixture fora do ambiente local, e volta a incluir dentro dele", () => {
  it("bloco focado num padrão com candidata SÓ fixture + fixturesAllowed=false: disponibilidade honesta zero, nunca a fixture", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");

    const result = await simulationsPreview(
      db as never,
      "u1",
      { blockType: "pattern_focused", patternSlug: "slug-p1", size: 5 },
      false,
      CLOCK
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.availableCount).toBe(0);
      expect(result.preview.items).toEqual([]);
      expect(result.preview.insufficientQuantity).toBe(true);
    }
  });

  it("bloco focado com mistura real + fixture + fixturesAllowed=false: só a real aparece na composição", async () => {
    seedPattern("p1", "PAD-01");
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");
    const realId = seedRealQuestion("q-real", "C-REAL", "p1");

    const result = await simulationsPreview(
      db as never,
      "u1",
      { blockType: "pattern_focused", patternSlug: "slug-p1", size: 5 },
      false,
      CLOCK
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.availableCount).toBe(1);
      expect(result.preview.items.map((i) => i.questionId)).toEqual([realId]);
    }
  });

  it("bloco focado num padrão com candidata SÓ fixture + fixturesAllowed=true (dev local + flag ligada): a fixture aparece na composição", async () => {
    seedPattern("p1", "PAD-01");
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");

    const result = await simulationsPreview(
      db as never,
      "u1",
      { blockType: "pattern_focused", patternSlug: "slug-p1", size: 5 },
      true,
      CLOCK
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.availableCount).toBe(1);
      expect(result.preview.items.map((i) => i.questionId)).toEqual([fixtureId]);
    }
  });
});

describe("(6) Caderno de Erros — startReview nunca oferece questão de fixture como revisão fora do ambiente local, e volta a oferecer dentro dele", () => {
  async function seedEntryOnOriginal(): Promise<string> {
    seedPattern("p1", "PAD-01");
    const originalId = seedRealQuestion("q-original", "C-ORIG", "p1");
    const attemptId = "attempt-original";
    db.sqlite.exec(
      `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, is_correct, selected_alternative, answered_at, completed_at)
       VALUES ('${attemptId}', 'u1', '${originalId}', 1, 'learning', 'completed', 0, 'A', datetime('now'), datetime('now'))`
    );
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, primary_pattern_id, status, next_review_at)
       VALUES ('entry-1', 'u1', '${originalId}', '${attemptId}', '${attemptId}', 'p1', 'scheduled', '2020-01-01T00:00:00.000Z')`
    );
    return originalId;
  }

  it("só existe fixture como alternativa + fixturesAllowed=false: revisão cai para a própria questão original (real), nunca a fixture", async () => {
    await seedUser("u1");
    const originalId = await seedEntryOnOriginal();
    seedFixtureQuestion("q-fixture", "C-FIX", "p1");

    const result = await startReview(db as never, "u1", "entry-1", false);
    expect(result.ok).toBe(true);
    expect(result.reviewedQuestionId).toBe(originalId);
  });

  it("só existe fixture como alternativa + fixturesAllowed=true (dev local + flag ligada): a fixture é oferecida como revisão", async () => {
    await seedUser("u1");
    await seedEntryOnOriginal();
    const fixtureId = seedFixtureQuestion("q-fixture", "C-FIX", "p1");

    const result = await startReview(db as never, "u1", "entry-1", true);
    expect(result.ok).toBe(true);
    expect(result.reviewedQuestionId).toBe(fixtureId);
  });
});
