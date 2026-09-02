// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import {
  abandonList,
  applyList,
  completeList,
  getCurrent,
  getListDetail,
  preview,
  skipItem,
  startItem,
  syncItem,
} from "../src/services/dailyTrainingService";
import { confirmAnswer, saveAnswer } from "../src/services/playerService";
import { civilDateInTimezone, weekdayCodeForCivilDate } from "../src/lib/scheduleValidation";
import type { Clock } from "../src/services/scheduleService";

/* Sprint 11 v1.0 — testes de serviço do Treino Diário, contra um SQLite
   real embutido (FakeD1Database, ver worker/testing/fakeD1.ts) — nunca só
   mocks de chamada. Cobre: preview somente-leitura/determinístico,
   prioridade/capacidade/timezone, apply atômico/idempotente, isolamento
   entre alunos, integração real com o Player, conclusão/resumo factual.
   Concorrência e falhas forçadas ficam em
   worker/testing/dailyTrainingAtomicity.test.ts. */

let db: FakeD1Database;

function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

// Instante fixo cujo dia civil em America/Sao_Paulo (fuso padrão do
// projeto) é 2026-09-01 — usado como relógio padrão da maioria dos testes.
const NOW_ISO = "2026-09-01T15:00:00.000Z";
const CLOCK = fixedClock(NOW_ISO);
const TIMEZONE = "America/Sao_Paulo";
const TODAY_CIVIL = civilDateInTimezone(new Date(NOW_ISO), TIMEZONE);
const TODAY_WEEKDAY = weekdayCodeForCivilDate(TODAY_CIVIL);

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: "hash",
  });
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

/** Registra uma revisão vencida ATIVA (Caderno de Erros) para `patternId`,
 *  vinculada a uma tentativa `completed` real (satisfaz as FKs) — camada 1
 *  da seleção (seção 7 da ordem). */
function seedOverdueReviewEntry(userId: string, entryId: string, originalQuestionId: string, patternId: string): void {
  const attemptId = `${entryId}-attempt`;
  db.sqlite.exec(
    `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status, is_correct, selected_alternative, answered_at, completed_at)
     VALUES ('${attemptId}', '${userId}', '${originalQuestionId}', 1, 'learning', 'completed', 0, 'A', datetime('now'), datetime('now'))`
  );
  db.sqlite.exec(
    `INSERT INTO error_notebook_entries
       (id, user_id, original_question_id, original_attempt_id, latest_attempt_id, primary_pattern_id, status, next_review_at)
     VALUES ('${entryId}', '${userId}', '${originalQuestionId}', '${attemptId}', '${attemptId}', '${patternId}', 'scheduled', '2020-01-01T00:00:00.000Z')`
  );
}

describe("preview — somente leitura (seção 6 da ordem)", () => {
  it("nunca cria lista, item, evento ou auditoria", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    await preview(db as never, "u1", CLOCK);

    expect(countRows("daily_training_lists")).toBe(0);
    expect(countRows("daily_training_items")).toBe(0);
    expect(countRows("daily_training_events")).toBe(0);
    expect(countRows("audit_log")).toBe(0);
  });

  it("é determinístico para o mesmo estado do banco e o mesmo relógio", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const r1 = await preview(db as never, "u1", CLOCK);
    const r2 = await preview(db as never, "u1", CLOCK);
    expect(r1).toEqual(r2);
  });

  it("sem disponibilidade hoje (dia fora de available_days) gera preview vazio honesto, sem erro", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    const otherWeekday = (["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const).find((d) => d !== TODAY_WEEKDAY)!;
    seedProfile("u1", [otherWeekday], 60);

    const result = await preview(db as never, "u1", CLOCK);
    expect(result.hasAvailabilityToday).toBe(false);
    expect(result.itemCount).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("sem nenhuma questão publicada elegível gera preview vazio honesto (itemCount 0, mas disponibilidade real)", async () => {
    await seedUser("u1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const result = await preview(db as never, "u1", CLOCK);
    expect(result.hasAvailabilityToday).toBe(true);
    expect(result.itemCount).toBe(0);
  });
});

describe("prioridade de revisão vencida (seção 7 da ordem)", () => {
  it("revisão vencida vem antes de um padrão sem evidência", async () => {
    await seedUser("u1");
    seedPattern("p-overdue", "PAD-OV");
    seedPattern("p-explore", "PAD-EX");
    seedPublishedQuestion("q-overdue", "C-OV", "p-overdue");
    seedPublishedQuestion("q-explore", "C-EX", "p-explore");
    seedOverdueReviewEntry("u1", "entry-1", "q-overdue", "p-overdue");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await preview(db as never, "u1", CLOCK);
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.items[0].reason).toBe("overdue_review");
    expect(result.items[0].questionId).toBe("q-overdue");
  });
});

describe("capacidade diária (seção 8 da ordem)", () => {
  it("lista nunca excede os minutos disponíveis do perfil", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPattern("p2", "PAD-02");
    seedPublishedQuestion("q1", "C1", "p1"); // 90s -> 2min (fixture fixa)
    seedPublishedQuestion("q2", "C2", "p2");
    seedProfile("u1", [TODAY_WEEKDAY], 2); // só cabe 1 questão de 2min

    const result = await preview(db as never, "u1", CLOCK);
    expect(result.estimatedMinutes).toBeLessThanOrEqual(2);
    expect(result.itemCount).toBe(1);
  });
});

describe("padrão principal apenas (seção 7 da ordem)", () => {
  it("questão vinculada só como padrão SECUNDÁRIO nunca é candidata", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedQuestion(db.sqlite, { id: "q1", code: "C1", status: "published", version: 1, patternId: "p1", withPrincipalPattern: false, secondaryPatternIds: ["p1"] });
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await preview(db as never, "u1", CLOCK);
    expect(result.itemCount).toBe(0);
  });
});

describe("timezone/data (seção 8 da ordem)", () => {
  it("usa relógio injetável e o fuso configurado do aluno para calcular a data civil", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    // 2026-09-01T02:00:00Z é 2026-08-31 em America/Sao_Paulo (UTC-3).
    const earlyClock = fixedClock("2026-09-01T02:00:00.000Z");
    const weekdayForAugust31 = weekdayCodeForCivilDate("2026-08-31");
    seedProfile("u1", [weekdayForAugust31], 60);

    const result = await preview(db as never, "u1", earlyClock);
    expect(result.date).toBe("2026-08-31");
    expect(result.timezone).toBe("America/Sao_Paulo");
  });
});

describe("apply — atômico e idempotente (seção 6 da ordem)", () => {
  it("cria a lista com itens e evento list_created atomicamente", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await applyList(db as never, "u1", "mut-1", CLOCK);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const listId = result.value!.listId;

    expect(countRows("daily_training_lists", `WHERE id = '${listId}'`)).toBe(1);
    expect(countRows("daily_training_items", `WHERE list_id = '${listId}'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE list_id = '${listId}' AND event_type = 'list_created'`)).toBe(1);
  });

  it("retry com mutationId diferente para o MESMO dia devolve a lista existente, nunca cria uma segunda", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const first = await applyList(db as never, "u1", "mut-1", CLOCK);
    const second = await applyList(db as never, "u1", "mut-2", CLOCK);

    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.value!.listId).toBe(first.value!.listId);
    expect(countRows("daily_training_lists", `WHERE user_id = 'u1' AND status = 'active'`)).toBe(1);
  });

  it("nenhuma lista vazia é persistida — sem candidatos elegíveis, apply devolve empty:true e não escreve nada", async () => {
    await seedUser("u1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const result = await applyList(db as never, "u1", "mut-1", CLOCK);
    expect(result.ok).toBe(false);
    expect(result.empty).toBe(true);
    expect(countRows("daily_training_lists")).toBe(0);
  });
});

describe("isolamento entre alunos (seção 9/14 da ordem)", () => {
  it("a lista de um aluno nunca é lida por outro", async () => {
    await seedUser("u1");
    await seedUser("u2");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    seedProfile("u2", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;

    const ownDetail = await getListDetail(db as never, "u1", listId);
    const otherDetail = await getListDetail(db as never, "u2", listId);
    expect(ownDetail).not.toBeNull();
    expect(otherDetail).toBeNull();

    const otherCurrent = await getCurrent(db as never, "u2", CLOCK);
    expect(otherCurrent).toBeNull();
  });
});

describe("integração com o Player (seção 10 da ordem)", () => {
  it("iniciar um item cria uma tentativa real do Player e a associa ao item; sync só conclui com tentativa completed", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    const list = await getListDetail(db as never, "u1", listId);
    const itemId = list!.items[0].id;

    const startResult = await startItem(db as never, "u1", listId, itemId, "start-mut-1");
    expect(startResult.ok).toBe(true);
    const attemptId = startResult.value!.attemptId;
    expect(countRows("question_attempts", `WHERE id = '${attemptId}' AND status = 'in_progress'`)).toBe(1);

    const midSync = await syncItem(db as never, "u1", listId, itemId, "sync-mut-1");
    expect(midSync.ok).toBe(true);
    expect(midSync.value!.itemStatus).toBe("in_progress"); // resposta não confirmada não conclui item

    await saveAnswer(db as never, "u1", attemptId, 1, "B"); // gabarito real é B (seedQuestion)
    await confirmAnswer(db as never, "u1", attemptId, 2);

    const finalSync = await syncItem(db as never, "u1", listId, itemId, "sync-mut-2");
    expect(finalSync.ok).toBe(true);
    expect(finalSync.value!.itemStatus).toBe("completed");
    expect(finalSync.value!.isCorrect).toBe(true);
    expect(countRows("daily_training_items", `WHERE id = '${itemId}' AND status = 'completed'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemId}' AND event_type = 'item_completed'`)).toBe(1);
  });

  it("retomar (retry do start) devolve a MESMA tentativa, nunca cria uma segunda", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    const list = await getListDetail(db as never, "u1", listId);
    const itemId = list!.items[0].id;

    const first = await startItem(db as never, "u1", listId, itemId, "start-mut-1");
    const second = await startItem(db as never, "u1", listId, itemId, "start-mut-2");
    expect(second.ok).toBe(true);
    expect(second.value!.attemptId).toBe(first.value!.attemptId);
    expect(countRows("question_attempts", `WHERE user_id = 'u1'`)).toBe(1);
  });
});

describe("pular item (seção 12 da ordem)", () => {
  it("pular com motivo técnico fechado move o item para skipped, idempotente em retry", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    const list = await getListDetail(db as never, "u1", listId);
    const itemId = list!.items[0].id;

    const result = await skipItem(db as never, "u1", listId, itemId, "skip-mut-1", "too_hard");
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(countRows("daily_training_items", `WHERE id = '${itemId}' AND status = 'skipped' AND skip_reason = 'too_hard'`)).toBe(1);

    const retry = await skipItem(db as never, "u1", listId, itemId, "skip-mut-2", "already_know");
    expect(retry.ok).toBe(true);
    expect(retry.changed).toBe(false);
    expect(countRows("daily_training_events", `WHERE item_id = '${itemId}' AND event_type = 'item_skipped'`)).toBe(1);
  });

  it("motivo de pular fora do enum fechado é rejeitado", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    const list = await getListDetail(db as never, "u1", listId);
    const itemId = list!.items[0].id;

    const result = await skipItem(db as never, "u1", listId, itemId, "skip-mut-1", "motivo_livre");
    expect(result.ok).toBe(false);
    expect(result.fieldErrors).toBeTruthy();
  });
});

describe("conclusão e resumo factual (seção 11 da ordem)", () => {
  it("só conclui quando todos os itens estão em estado terminal, e devolve um resumo factual", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    const list = await getListDetail(db as never, "u1", listId);
    const itemId = list!.items[0].id;

    const tooEarly = await completeList(db as never, "u1", listId, "complete-mut-1");
    expect(tooEarly.ok).toBe(false);
    expect(tooEarly.fieldErrors).toBeTruthy();

    await skipItem(db as never, "u1", listId, itemId, "skip-mut-1", "not_now");
    const completed = await completeList(db as never, "u1", listId, "complete-mut-2");
    expect(completed.ok).toBe(true);
    expect(completed.value!.summary.skippedCount).toBe(1);
    expect(completed.value!.summary.completedCount).toBe(0);
    expect(countRows("daily_training_lists", `WHERE id = '${listId}' AND status = 'completed'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE list_id = '${listId}' AND event_type = 'list_completed'`)).toBe(1);
  });
});

describe("GET current — refresh sem perda de progresso (seção 12 da ordem)", () => {
  it("depois de concluída, a lista deixa de ser 'active' mas GET current continua devolvendo ela (nunca volta a um preview novo)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    const list = await getListDetail(db as never, "u1", listId);
    const itemId = list!.items[0].id;
    await skipItem(db as never, "u1", listId, itemId, "skip-1", "not_now");
    await completeList(db as never, "u1", listId, "complete-1");

    const current = await getCurrent(db as never, "u1", CLOCK);
    expect(current).not.toBeNull();
    expect(current!.id).toBe(listId);
    expect(current!.status).toBe("completed");
  });

  it("depois de abandonada, GET current também continua devolvendo a MESMA lista (nunca some silenciosamente)", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);

    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;
    await abandonList(db as never, "u1", listId, "abandon-1");

    const current = await getCurrent(db as never, "u1", CLOCK);
    expect(current).not.toBeNull();
    expect(current!.id).toBe(listId);
    expect(current!.status).toBe("abandoned");
  });

  it("sem NENHUMA lista para hoje, GET current devolve null (cai para o preview)", async () => {
    await seedUser("u1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const current = await getCurrent(db as never, "u1", CLOCK);
    expect(current).toBeNull();
  });
});

describe("abandonar treino", () => {
  it("abandona uma lista active, idempotente em retry", async () => {
    await seedUser("u1");
    seedPattern("p1", "PAD-01");
    seedPublishedQuestion("q1", "C1", "p1");
    seedProfile("u1", [TODAY_WEEKDAY], 60);
    const applied = await applyList(db as never, "u1", "mut-1", CLOCK);
    const listId = applied.value!.listId;

    const result = await abandonList(db as never, "u1", listId, "abandon-mut-1");
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(countRows("daily_training_lists", `WHERE id = '${listId}' AND status = 'abandoned'`)).toBe(1);
    expect(countRows("daily_training_events", `WHERE list_id = '${listId}' AND event_type = 'list_abandoned'`)).toBe(1);

    const retry = await abandonList(db as never, "u1", listId, "abandon-mut-2");
    expect(retry.ok).toBe(true);
    expect(retry.changed).toBe(false);
    expect(countRows("daily_training_events", `WHERE list_id = '${listId}' AND event_type = 'list_abandoned'`)).toBe(1);
  });
});
