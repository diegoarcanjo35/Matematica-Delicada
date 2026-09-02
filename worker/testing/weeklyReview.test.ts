// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { applyGoal, completeGoal, getHistory, getReportForWeek, patchGoal, previewGoal } from "../src/services/weeklyReviewService";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 13 v1.0 — testes de serviço do Relatório Semanal e das Metas
   Realistas, contra um SQLite real embutido (FakeD1Database), nunca só
   mocks de chamada. Cobre: agregação factual por fonte, honestidade
   ausência-vs-zero, comparação responsável, isolamento entre usuários,
   somente-leitura dos GETs/preview, limites/validação da meta, apply
   atômico, PATCH parcial com limpeza explícita de padrões, e
   conclusão/abandono idempotentes. Concorrência e falhas forçadas com
   prova de rollback ficam em worker/testing/weeklyReviewAtomicity.test.ts. */

let db: FakeD1Database;

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

// 2026-09-03 é uma quinta-feira; a semana civil correspondente começa em
// 2026-08-31 (segunda) e termina em 2026-09-06 (domingo).
const NOW_ISO = "2026-09-03T15:00:00.000Z";
const CLOCK = fixedClock(NOW_ISO);
const CURRENT_WEEK_START = "2026-08-31";
const PREVIOUS_WEEK_START = "2026-08-24";

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

function seedPublishedQuestion(id: string, code: string, patternId: string): string {
  return seedQuestion(db.sqlite, { id, code, status: "published", version: 1, patternId });
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

/** Tentativa CONFIRMADA (comum, nunca revisão) num instante dentro da
 *  semana corrente — `startedAtIso`/`completedAtIso` no formato
 *  `datetime('now')` do SQLite (`YYYY-MM-DD HH:MM:SS`). */
function seedConfirmedAttempt(
  id: string,
  userId: string,
  questionId: string,
  opts: { isCorrect: 0 | 1; startedAt: string; completedAt: string; errorEntryId?: string | null; mode?: string }
): void {
  db.sqlite.exec(
    `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, is_correct, selected_alternative, started_at, answered_at, completed_at, error_entry_id)
     VALUES ('${id}', '${userId}', '${questionId}', 1, '${opts.mode ?? "practice"}', 'completed', ${opts.isCorrect}, 'A', '${opts.startedAt}', '${opts.completedAt}', '${opts.completedAt}', ${opts.errorEntryId ? `'${opts.errorEntryId}'` : "NULL"})`
  );
}

function seedInProgressAttempt(id: string, userId: string, questionId: string, startedAt: string): void {
  db.sqlite.exec(
    `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, started_at) VALUES ('${id}', '${userId}', '${questionId}', 1, 'practice', 'in_progress', '${startedAt}')`
  );
}

describe("relatório semanal — semana sem evidência (honestidade, seção 4.1 da ordem)", () => {
  it("nenhuma evidência: hasAnyEvidence=false, approxMinutes NULO (nunca 0 fabricado)", async () => {
    await seedUser("u1");
    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.hasAnyEvidence).toBe(false);
    expect(result.report.approxMinutes).toBeNull();
    expect(result.report.confirmedQuestionsCount).toBe(0);
    expect(result.report.daysWithEvidenceCount).toBe(0);
  });

  it("ausência de evidência é diferente de desempenho zero: correctCount/incorrectCount também ficam 0 sem afirmar erro algum, e patternsPracticed fica vazio", async () => {
    await seedUser("u1");
    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.correctCount).toBe(0);
    expect(result.report.incorrectCount).toBe(0);
    expect(result.report.patternsPracticed).toEqual([]);
  });
});

describe("relatório semanal — agregação correta de cada fonte (seção 4.1/12.1 da ordem)", () => {
  it("agrega minutos/questões/acertos/erros a partir de tentativas confirmadas dentro da janela da semana", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    // Duas tentativas confirmadas dentro da semana 2026-08-31..2026-09-06.
    seedConfirmedAttempt("a1", "u1", "q1", { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });
    seedConfirmedAttempt("a2", "u1", "q2", { isCorrect: 0, startedAt: "2026-09-02 12:00:00", completedAt: "2026-09-02 12:03:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.confirmedQuestionsCount).toBe(2);
    expect(result.report.distinctQuestionsCount).toBe(2);
    expect(result.report.correctCount).toBe(1);
    expect(result.report.incorrectCount).toBe(1);
    expect(result.report.approxMinutes).toBe(8); // 5 min + 3 min
    expect(result.report.patternsPracticed).toEqual(["Padrão p1"]);
    expect(result.report.hasAnyEvidence).toBe(true);
    expect(result.report.daysWithEvidenceCount).toBe(2); // dois dias-calendário distintos
  });

  it("tentativa INCOMPLETA (in_progress) é ignorada na agregação (nunca conta como confirmada)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedInProgressAttempt("a1", "u1", "q1", "2026-09-01 12:00:00");

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.confirmedQuestionsCount).toBe(0);
    expect(result.report.hasAnyEvidence).toBe(false);
  });

  it("revisão é SEPARADA de erro comum: não polui correctCount/incorrectCount de prática comum, mas soma em reviewsCompletedCount", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    seedConfirmedAttempt("a1", "u1", "q1", { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" }); // prática comum
    // Entrada + tentativa de REVISÃO (error_entry_id preenchido).
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, primary_pattern_id, status, next_review_at)
       VALUES ('e1', 'u1', 'q1', 'a1', 'a1', 'p1', 'in_review', '2026-09-01 00:00:00')`
    );
    seedConfirmedAttempt("a2", "u1", "q2", { isCorrect: 1, startedAt: "2026-09-02 12:00:00", completedAt: "2026-09-02 12:02:00", errorEntryId: "e1" });
    db.sqlite.exec(
      `INSERT INTO error_review_events (id, entry_id, user_id, attempt_id, reviewed_question_id, result, previous_stage, resulting_stage, previous_next_review_at, resulting_next_review_at, used_different_question)
       VALUES ('rev1', 'e1', 'u1', 'a2', 'q2', 'correct', 0, 1, '2026-09-01 00:00:00', '2026-09-08 00:00:00', 1)`
    );

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    // Só a1 (prática comum) entra em confirmedQuestionsCount/correctCount da
    // aba "prática" — a2 (revisão) não deve inflar esses mesmos contadores.
    expect(result.report.correctCount).toBe(1);
    expect(result.report.incorrectCount).toBe(0);
    expect(result.report.reviewsCompletedCount).toBe(1);
    expect(result.report.reviewsCorrectCount).toBe(1);
    // confirmedQuestionsCount combina prática + revisão (seção 4.4 usa o
    // total para a meta) — 1 prática + 1 revisão = 2.
    expect(result.report.confirmedQuestionsCount).toBe(2);
  });

  it("itens do Treino Diário concluídos, blocos de Simulado concluídos, cronograma concluído/reagendado e entradas do Caderno de Erros criadas — cada fonte contada corretamente", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const dtQuestionId = seedPublishedQuestion("qdt1", "CDT1", "p1");
    db.sqlite.exec(
      `INSERT INTO daily_training_lists (id, user_id, training_date, timezone, estimated_minutes, item_count) VALUES ('dl1','u1','2026-09-01','America/Sao_Paulo',10,1)`
    );
    db.sqlite.exec(
      `INSERT INTO daily_training_items (id, list_id, user_id, question_id, origin, reason, player_mode, position, estimated_minutes, status)
       VALUES ('di1','dl1','u1','${dtQuestionId}','development','pattern_exploration','practice',0,10,'completed')`
    );
    db.sqlite.exec(`UPDATE daily_training_items SET last_mutation_id = 'dte1' WHERE id = 'di1'`);
    db.sqlite.exec(
      `INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type, created_at) VALUES ('dte1','dl1','di1','u1','item_completed','2026-09-01 12:00:00')`
    );

    db.sqlite.exec(
      `INSERT INTO simulation_blocks (id, user_id, block_type, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date) VALUES ('sb1','u1','mixed','completed',5,5,20,'America/Sao_Paulo','2026-09-01')`
    );
    db.sqlite.exec(`UPDATE simulation_blocks SET last_mutation_id = 'sbe1' WHERE id = 'sb1'`);
    db.sqlite.exec(
      `INSERT INTO simulation_block_events (id, block_id, user_id, event_type, created_at) VALUES ('sbe1','sb1','u1','block_completed','2026-09-01 13:00:00')`
    );
    db.sqlite.exec(
      `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin) VALUES ('act1','estudo_de_padrao','T','O',10,'C','E','manual','system')`
    );
    db.sqlite.exec(
      `INSERT INTO schedule_activity_assignments (id, user_id, activity_id, status) VALUES ('asg1','u1','act1','completed')`
    );
    db.sqlite.exec(
      `INSERT INTO schedule_activity_events (id, assignment_id, user_id, to_status, created_at) VALUES ('sae1','asg1','u1','completed','2026-09-02 09:00:00')`
    );
    db.sqlite.exec(
      `INSERT INTO schedule_activity_events (id, assignment_id, user_id, to_status, created_at) VALUES ('sae2','asg1','u1','rescheduled','2026-09-02 10:00:00')`
    );
    seedConfirmedAttempt("aen1", "u1", dtQuestionId, { isCorrect: 0, startedAt: "2026-09-01 07:55:00", completedAt: "2026-09-01 08:00:00" });
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, status, next_review_at, created_at)
       VALUES ('e1','u1','${dtQuestionId}','aen1','aen1','scheduled','2026-09-10 00:00:00','2026-09-01 08:00:00')`
    );

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.dailyTrainingItemsCompleted).toBe(1);
    expect(result.report.simulationBlocksCompleted).toBe(1);
    expect(result.report.scheduleCompletedCount).toBe(1);
    expect(result.report.scheduleRescheduledCount).toBe(1);
    expect(result.report.errorNotebookEntriesCreated).toBe(1);
    expect(result.report.hasAnyEvidence).toBe(true);
  });

  it("fronteira de semana: evidência exatamente na virada domingo->segunda cai na semana CORRETA", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    // 2026-08-31 03:00:00 UTC é exatamente meia-noite de segunda em
    // America/Sao_Paulo (UTC-3) — pertence à semana corrente.
    seedConfirmedAttempt("a1", "u1", "q1", { isCorrect: 1, startedAt: "2026-08-31 02:55:00", completedAt: "2026-08-31 03:00:00" });
    // Um segundo antes (2026-08-31 02:59:59 UTC = 23:59:59 de domingo local)
    // pertence à semana ANTERIOR, nunca à corrente.
    seedConfirmedAttempt("a2", "u1", "q2", { isCorrect: 1, startedAt: "2026-08-31 02:50:00", completedAt: "2026-08-31 02:59:59" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.confirmedQuestionsCount).toBe(1);

    const previous = await getReportForWeek(db as never, "u1", PREVIOUS_WEEK_START, CLOCK);
    if (!previous.ok) throw new Error("esperado ok");
    expect(previous.report.confirmedQuestionsCount).toBe(1);
  });
});

describe("Correção B v1.1 — padrões principal E secundários no relatório semanal (seção 3 da ordem)", () => {
  it("1) questão com SÓ padrão principal: padrão principal aparece normalmente em patternsPracticed", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const q1 = seedPublishedQuestion("q1", "C1", "p1"); // só principal, sem secundários
    seedConfirmedAttempt("a1", "u1", q1, { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.patternsPracticed).toEqual(["Padrão p1"]);
  });

  it("2) questão com principal + DOIS secundários: os três padrões aparecem em patternsPracticed", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01"); // principal
    seedPattern("p2", "PAD-02"); // secundário
    seedPattern("p3", "PAD-03"); // secundário
    const q1 = seedQuestion(db.sqlite, { id: "q1", code: "C1", status: "published", version: 1, patternId: "p1", secondaryPatternIds: ["p2", "p3"] });
    seedConfirmedAttempt("a1", "u1", q1, { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.patternsPracticed.slice().sort()).toEqual(["Padrão p1", "Padrão p2", "Padrão p3"]);
    // Nenhuma contagem agregada infla por a questão ter 3 padrões vinculados.
    expect(result.report.confirmedQuestionsCount).toBe(1);
    expect(result.report.correctCount).toBe(1);
  });

  it("3) o mesmo padrão nunca é duplicado: evidenciado como secundário de UMA questão e principal de OUTRA na mesma semana aparece uma única vez", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    // q1: p1 principal, p2 secundário. q2: p2 principal (sem p1).
    const q1 = seedQuestion(db.sqlite, { id: "q1", code: "C1", status: "published", version: 1, patternId: "p1", secondaryPatternIds: ["p2"] });
    const q2 = seedQuestion(db.sqlite, { id: "q2", code: "C2", status: "published", version: 1, patternId: "p2" });
    seedConfirmedAttempt("a1", "u1", q1, { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });
    seedConfirmedAttempt("a2", "u1", q2, { isCorrect: 1, startedAt: "2026-09-02 12:00:00", completedAt: "2026-09-02 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    // p2 apareceu em DUAS linhas de question_patterns nesta semana (secundário
    // de q1 e principal de q2) — mas só uma vez na lista.
    expect(result.report.patternsPracticed.slice().sort()).toEqual(["Padrão p1", "Padrão p2"]);
  });

  it("4) totais agregados/gerais são INVARIANTES ao número de padrões de uma questão (1 padrão vs 3 padrões, mesmas 2 tentativas confirmadas)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    const qSimples = seedPublishedQuestion("qs1", "CS1", "p1");
    seedConfirmedAttempt("as1", "u1", qSimples, { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });
    const resultSimples = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!resultSimples.ok) throw new Error("esperado ok");

    await seedUser("u2");
    seedPattern("p2", "PAD-02");
    seedPattern("p3", "PAD-03");
    seedPattern("p4", "PAD-04");
    const qTripla = seedQuestion(db.sqlite, { id: "qt1", code: "CT1", status: "published", version: 1, patternId: "p2", secondaryPatternIds: ["p3", "p4"] });
    seedConfirmedAttempt("at1", "u2", qTripla, { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });
    const resultTripla = await getReportForWeek(db as never, "u2", CURRENT_WEEK_START, CLOCK);
    if (!resultTripla.ok) throw new Error("esperado ok");

    // Mesma UMA tentativa confirmada em ambos os casos -> mesmos totais
    // agregados, apesar de a segunda questão ter 3 padrões vinculados contra 1.
    expect(resultTripla.report.confirmedQuestionsCount).toBe(resultSimples.report.confirmedQuestionsCount);
    expect(resultTripla.report.distinctQuestionsCount).toBe(resultSimples.report.distinctQuestionsCount);
    expect(resultTripla.report.correctCount).toBe(resultSimples.report.correctCount);
    expect(resultTripla.report.patternsPracticed.length).toBe(3); // só a distribuição por padrão muda
  });

  it("5) prática comum E revisão seguem a MESMA regra (principal + secundários) — revisão de uma questão com secundários também evidencia os secundários", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    const q1 = seedQuestion(db.sqlite, { id: "q1", code: "C1", status: "published", version: 1, patternId: "p1", secondaryPatternIds: ["p2"] });
    // Tentativa ORIGINAL (erro), fora da semana corrente, só para satisfazer
    // a FK de error_notebook_entries.original_attempt_id/latest_attempt_id —
    // mesmo padrão de seed já usado em "revisão é SEPARADA de erro comum" acima.
    seedConfirmedAttempt("a0", "u1", q1, { isCorrect: 0, startedAt: "2026-08-20 12:00:00", completedAt: "2026-08-20 12:05:00" });
    db.sqlite.exec(
      `INSERT INTO error_notebook_entries (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, primary_pattern_id, status, next_review_at)
       VALUES ('e1', 'u1', '${q1}', 'a0', 'a0', 'p1', 'in_review', '2026-09-01 00:00:00')`
    );
    // Tentativa de REVISÃO (error_entry_id preenchido) confirmada nesta semana.
    seedConfirmedAttempt("a1", "u1", q1, { isCorrect: 1, startedAt: "2026-09-02 12:00:00", completedAt: "2026-09-02 12:05:00", errorEntryId: "e1" });
    db.sqlite.exec(
      `INSERT INTO error_review_events (id, entry_id, user_id, attempt_id, reviewed_question_id, result, previous_stage, resulting_stage, previous_next_review_at, resulting_next_review_at, used_different_question)
       VALUES ('rev1', 'e1', 'u1', 'a1', '${q1}', 'correct', 0, 1, '2026-09-01 00:00:00', '2026-09-08 00:00:00', 0)`
    );

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.patternsPracticed.slice().sort()).toEqual(["Padrão p1", "Padrão p2"]);
    expect(result.report.reviewsCompletedCount).toBe(1);
  });

  it("6) isolamento entre alunos permanece: padrões (inclusive secundários) de um aluno nunca vazam para o relatório de outro", async () => {
    await seedUser("u1");
    await seedUser("u2");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    const q1 = seedQuestion(db.sqlite, { id: "q1", code: "C1", status: "published", version: 1, patternId: "p1", secondaryPatternIds: ["p2"] });
    seedConfirmedAttempt("a1", "u2", q1, { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.patternsPracticed).toEqual([]);
    expect(result.report.hasAnyEvidence).toBe(false);
  });
});

describe("comparação semana a semana — só diferenças factuais (seção 4.2 da ordem)", () => {
  it("indisponível quando a semana anterior não tem evidência comparável", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedConfirmedAttempt("a1", "u1", "q1", { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.comparison.available).toBe(false);
    expect(result.report.comparison.deltas).toBeNull();
  });

  it("disponível e com deltas factuais quando ambas as semanas têm evidência", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedPublishedQuestion("q2", "C2", "p1");
    seedConfirmedAttempt("a1", "u1", "q1", { isCorrect: 1, startedAt: "2026-08-24 12:00:00", completedAt: "2026-08-24 12:05:00" }); // semana anterior: 1 questão
    seedConfirmedAttempt("a2", "u1", "q1", { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" }); // semana corrente: 2 questões
    seedConfirmedAttempt("a3", "u1", "q2", { isCorrect: 1, startedAt: "2026-09-02 12:00:00", completedAt: "2026-09-02 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.comparison.available).toBe(true);
    expect(result.report.comparison.deltas!.confirmedQuestionsCount).toBe(1); // 2 - 1
    expect(result.report.comparison.deltas!.daysWithEvidenceCount).toBe(1); // 2 dias - 1 dia
  });
});

describe("isolamento entre usuários", () => {
  it("relatório de um aluno nunca inclui evidência de outro aluno", async () => {
    await seedUser("u1");
    await seedUser("u2");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedConfirmedAttempt("a1", "u2", "q1", { isCorrect: 1, startedAt: "2026-09-01 12:00:00", completedAt: "2026-09-01 12:05:00" });

    const result = await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    if (!result.ok) throw new Error("esperado ok");
    expect(result.report.hasAnyEvidence).toBe(false);
    expect(result.report.confirmedQuestionsCount).toBe(0);
  });

  it("aplicar uma meta para u1 nunca é visível/afetável por u2", async () => {
    await seedUser("u1");
    await seedUser("u2");
    const applied = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 120,
      targetQuestions: 20,
      availableDays: ["seg"],
      patternIds: [],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const patchAsOtherUser = await patchGoal(db as never, "u2", applied.value!.goalId, { targetMinutes: 999, version: 1, mutationId: "m2" });
    expect(patchAsOtherUser.ok).toBe(false);
    expect(patchAsOtherUser.notFound).toBe(true);

    const completeAsOtherUser = await completeGoal(db as never, "u2", applied.value!.goalId, "m3");
    expect(completeAsOtherUser.ok).toBe(false);
    expect(completeAsOtherUser.notFound).toBe(true);
  });
});

describe("GET nunca escreve nem audita (seção 4.1/7/10 da ordem)", () => {
  it("getReportForWeek/getHistory/previewGoal nunca criam meta, evento ou linha de auditoria", async () => {
    await seedUser("u1");
    await getReportForWeek(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    await getHistory(db as never, "u1", CLOCK);
    await previewGoal(db as never, "u1", CURRENT_WEEK_START, CLOCK);

    expect(countRows("weekly_study_goals")).toBe(0);
    expect(countRows("weekly_goal_patterns")).toBe(0);
    expect(countRows("weekly_goal_events")).toBe(0);
    expect(countRows("audit_log")).toBe(0);
  });

  it("chamar preview repetidamente é determinístico para o mesmo estado e o mesmo relógio", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    const r1 = await previewGoal(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    const r2 = await previewGoal(db as never, "u1", CURRENT_WEEK_START, CLOCK);
    expect(r1).toEqual(r2);
  });
});

describe("histórico semanal (seção 4.1 da ordem)", () => {
  it("a semana atual sempre aparece, mesmo sem evidência; semanas anteriores só aparecem se tiverem evidência real", async () => {
    await seedUser("u1");
    const result = await getHistory(db as never, "u1", CLOCK);
    expect(result.weeks.length).toBe(1);
    expect(result.weeks[0].weekStart).toBe(CURRENT_WEEK_START);
    expect(result.weeks[0].hasEvidence).toBe(false);
  });
});

describe("metas — limites e validação (seção 8/12.1 da ordem)", () => {
  it("rejeita minutos fora dos limites técnicos", async () => {
    await seedUser("u1");
    const result = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 99999,
      targetQuestions: 20,
      availableDays: [],
      patternIds: [],
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.targetMinutes).toBeTruthy();
  });

  it("rejeita mais de 3 padrões prioritários", async () => {
    await seedUser("u1");
    seedPattern("p1", "P1");
    seedPattern("p2", "P2");
    seedPattern("p3", "P3");
    seedPattern("p4", "P4");
    const result = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 120,
      targetQuestions: 20,
      availableDays: [],
      patternIds: ["p1", "p2", "p3", "p4"],
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.patternIds).toBeTruthy();
  });

  it("rejeita padrão prioritário duplicado", async () => {
    await seedUser("u1");
    seedPattern("p1", "P1");
    const result = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 120,
      targetQuestions: 20,
      availableDays: [],
      patternIds: ["p1", "p1"],
    });
    expect(result.ok).toBe(false);
  });

  it("padrão prioritário inexistente/não publicado responde notFound (nunca vaza rascunho)", async () => {
    await seedUser("u1");
    const result = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 120,
      targetQuestions: 20,
      availableDays: [],
      patternIds: ["padrao-inexistente"],
    });
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});

describe("apply — atômico (meta + padrões + evento juntos, seção 9 da ordem)", () => {
  it("cria a meta, os padrões prioritários e o evento goal_created no MESMO apply", async () => {
    await seedUser("u1");
    seedPattern("p1", "P1");
    seedPattern("p2", "P2");
    const result = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: ["seg", "qua"],
      patternIds: ["p1", "p2"],
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(countRows("weekly_study_goals")).toBe(1);
    expect(countRows("weekly_goal_patterns")).toBe(2);
    expect(countRows("weekly_goal_events", "WHERE event_type = 'goal_created'")).toBe(1);
  });

  it("retry idempotente: mesmo mutationId e mesmo conteúdo não duplica nada", async () => {
    await seedUser("u1");
    const input = { mutationId: "m1", weekStart: CURRENT_WEEK_START, targetMinutes: 150, targetQuestions: 30, availableDays: [], patternIds: [] };
    const r1 = await applyGoal(db as never, "u1", input);
    const r2 = await applyGoal(db as never, "u1", input);
    expect(r1.ok).toBe(true);
    expect(r1.changed).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
    expect(countRows("weekly_study_goals")).toBe(1);
    expect(countRows("weekly_goal_events")).toBe(1);
  });

  it("mesmo mutationId com conteúdo DIFERENTE do que já foi aplicado responde conflito (nunca aplica silenciosamente uma mutação diferente)", async () => {
    await seedUser("u1");
    const r1 = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: [],
    });
    expect(r1.ok).toBe(true);
    const r2 = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 200,
      targetQuestions: 30,
      availableDays: [],
      patternIds: [],
    });
    expect(r2.ok).toBe(false);
    expect(r2.conflict).toBe(true);
  });

  it("uma segunda meta ATIVA para a MESMA semana (mutationId diferente) responde activeElsewhere, nunca cria duas metas ativas", async () => {
    await seedUser("u1");
    const input = { weekStart: CURRENT_WEEK_START, targetMinutes: 150, targetQuestions: 30, availableDays: [], patternIds: [] };
    const r1 = await applyGoal(db as never, "u1", { ...input, mutationId: "m1" });
    expect(r1.ok).toBe(true);
    const r2 = await applyGoal(db as never, "u1", { ...input, mutationId: "m2" });
    expect(r2.ok).toBe(false);
    expect(r2.activeElsewhere).toBe(true);
    expect(countRows("weekly_study_goals", "WHERE status = 'active'")).toBe(1);
  });
});

describe("PATCH — parcial e limpeza explícita da coleção de padrões (seção 9/12.1 da ordem)", () => {
  it("PATCH parcial altera só o campo informado, preservando os demais", async () => {
    await seedUser("u1");
    const applied = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: ["seg"],
      patternIds: [],
    });
    if (!applied.ok) throw new Error("esperado ok");

    const patched = await patchGoal(db as never, "u1", applied.value!.goalId, { targetMinutes: 200, version: 1, mutationId: "m2" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.value!.goal.targetMinutes).toBe(200);
    expect(patched.value!.goal.targetQuestions).toBe(30); // preservado
  });

  it("PATCH que troca padrões substitui a coleção INTEIRA (remove os antigos, insere os novos)", async () => {
    await seedUser("u1");
    seedPattern("p1", "P1");
    seedPattern("p2", "P2");
    const applied = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: ["p1"],
    });
    if (!applied.ok) throw new Error("esperado ok");

    const patched = await patchGoal(db as never, "u1", applied.value!.goalId, { patternIds: ["p2"], version: 1, mutationId: "m2" });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.value!.goal.patterns.map((p) => p.patternId)).toEqual(["p2"]);
    expect(countRows("weekly_goal_patterns")).toBe(1);
  });

  it("conflito de versão: PATCH com versão obsoleta é rejeitado, sem escrita parcial", async () => {
    await seedUser("u1");
    const applied = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: [],
    });
    if (!applied.ok) throw new Error("esperado ok");
    await patchGoal(db as never, "u1", applied.value!.goalId, { targetMinutes: 200, version: 1, mutationId: "m2" });

    const stalePatch = await patchGoal(db as never, "u1", applied.value!.goalId, { targetMinutes: 300, version: 1, mutationId: "m3" });
    expect(stalePatch.ok).toBe(false);
    expect(stalePatch.conflict).toBe(true);
    const row = db.sqlite.prepare("SELECT target_minutes FROM weekly_study_goals WHERE id = ?").get(applied.value!.goalId) as { target_minutes: number };
    expect(row.target_minutes).toBe(200); // não foi para 300
  });

  it("PATCH numa meta já concluída/abandonada é rejeitado", async () => {
    await seedUser("u1");
    const applied = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: [],
    });
    if (!applied.ok) throw new Error("esperado ok");
    await completeGoal(db as never, "u1", applied.value!.goalId, "m2");

    const patched = await patchGoal(db as never, "u1", applied.value!.goalId, { targetMinutes: 200, version: 2, mutationId: "m3" });
    expect(patched.ok).toBe(false);
    expect(patched.fieldErrors?.status).toBeTruthy();
  });
});

describe("conclusão e abandono — idempotentes (seção 9 da ordem)", () => {
  it("completeGoal idempotente: repetir com mutationId diferente não gera erro nem duplica evento", async () => {
    await seedUser("u1");
    const applied = await applyGoal(db as never, "u1", {
      mutationId: "m1",
      weekStart: CURRENT_WEEK_START,
      targetMinutes: 150,
      targetQuestions: 30,
      availableDays: [],
      patternIds: [],
    });
    if (!applied.ok) throw new Error("esperado ok");
    const r1 = await completeGoal(db as never, "u1", applied.value!.goalId, "m2");
    expect(r1.ok).toBe(true);
    expect(r1.changed).toBe(true);
    const r2 = await completeGoal(db as never, "u1", applied.value!.goalId, "m3");
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
    expect(countRows("weekly_goal_events", "WHERE event_type = 'goal_completed'")).toBe(1);
  });

  it("acesso a meta inexistente retorna notFound", async () => {
    await seedUser("u1");
    const result = await completeGoal(db as never, "u1", "goal-inexistente", "m1");
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});
