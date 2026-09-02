// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FALLBACK_ITEM_MINUTES,
  MAX_DAILY_TRAINING_ITEMS,
  estimateItemMinutes,
  selectDailyTrainingItems,
  type DailyTrainingCandidate,
} from "../src/lib/dailyTrainingRules";

/* Sprint 11 v1.0 — testes diretos do algoritmo adaptativo provisório
   (worker/src/lib/dailyTrainingRules.ts), uma função PURA — nenhum banco,
   nenhum relógio real. Mesma convenção de worker/testing/schedule.test.ts
   para scheduleService.ts:computePlan (Sprint 5). */

function candidate(overrides: Partial<DailyTrainingCandidate> & Pick<DailyTrainingCandidate, "questionId" | "reason">): DailyTrainingCandidate {
  return {
    patternId: "pat-1",
    playerMode: "learning",
    estimatedMinutes: 5,
    ...overrides,
  };
}

describe("estimateItemMinutes — fallback técnico centralizado", () => {
  it("converte segundos para minutos, arredondando para cima", () => {
    expect(estimateItemMinutes(90)).toBe(2);
    expect(estimateItemMinutes(60)).toBe(1);
    expect(estimateItemMinutes(61)).toBe(2);
  });

  it("usa o fallback quando nulo, zero, negativo ou não finito", () => {
    expect(estimateItemMinutes(null)).toBe(FALLBACK_ITEM_MINUTES);
    expect(estimateItemMinutes(0)).toBe(FALLBACK_ITEM_MINUTES);
    expect(estimateItemMinutes(-10)).toBe(FALLBACK_ITEM_MINUTES);
    expect(estimateItemMinutes(Number.NaN)).toBe(FALLBACK_ITEM_MINUTES);
  });
});

describe("selectDailyTrainingItems — ordem de prioridade (seção 7 da ordem)", () => {
  it("respeita a ordem das camadas: revisão vencida antes de tudo, exploração por último", () => {
    const result = selectDailyTrainingItems({
      candidatesByTier: [
        [candidate({ questionId: "q-overdue", reason: "overdue_review", patternId: "p1" })],
        [candidate({ questionId: "q-commitment", reason: "schedule_commitment", patternId: "p2" })],
        [candidate({ questionId: "q-dev", reason: "pattern_in_development", patternId: "p3" })],
        [candidate({ questionId: "q-initial", reason: "pattern_initial_evidence", patternId: "p4" })],
        [candidate({ questionId: "q-maintenance", reason: "pattern_maintenance", patternId: "p5" })],
        [candidate({ questionId: "q-exploration", reason: "pattern_exploration", patternId: "p6" })],
      ],
      availableMinutes: 100,
    });
    expect(result.items.map((i) => i.questionId)).toEqual(["q-overdue", "q-commitment", "q-dev", "q-initial", "q-maintenance", "q-exploration"]);
    expect(result.items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.items.map((i) => i.origin)).toEqual([
      "overdue_review",
      "schedule_commitment",
      "development",
      "development",
      "consistency",
      "development",
    ]);
  });

  it("nunca repete a mesma questão mesmo se aparecer em duas camadas", () => {
    const result = selectDailyTrainingItems({
      candidatesByTier: [
        [candidate({ questionId: "q1", reason: "overdue_review" })],
        [],
        [candidate({ questionId: "q1", reason: "pattern_in_development" })],
        [],
        [],
        [],
      ],
      availableMinutes: 100,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].reason).toBe("overdue_review");
  });
});

describe("selectDailyTrainingItems — capacidade (seção 8 da ordem)", () => {
  it("nunca excede os minutos disponíveis — item que não cabe fica de fora inteiramente (nunca parcial)", () => {
    const result = selectDailyTrainingItems({
      candidatesByTier: [
        [],
        [],
        [
          candidate({ questionId: "q1", reason: "pattern_in_development", estimatedMinutes: 6, patternId: "p1" }),
          candidate({ questionId: "q2", reason: "pattern_in_development", estimatedMinutes: 6, patternId: "p2" }),
        ],
        [],
        [],
        [],
      ],
      availableMinutes: 10,
    });
    expect(result.items).toHaveLength(1);
    expect(result.totalMinutes).toBe(6);
  });

  it("0 minutos disponíveis produz lista vazia, sem examinar candidatos (preview vazio honesto)", () => {
    const result = selectDailyTrainingItems({
      candidatesByTier: [[candidate({ questionId: "q1", reason: "overdue_review" })]],
      availableMinutes: 0,
    });
    expect(result.items).toEqual([]);
    expect(result.totalMinutes).toBe(0);
  });

  it("nunca ultrapassa MAX_DAILY_TRAINING_ITEMS mesmo com capacidade de minutos sobrando", () => {
    const manyCandidates = Array.from({ length: MAX_DAILY_TRAINING_ITEMS + 5 }, (_, i) =>
      candidate({ questionId: `q${i}`, reason: "pattern_exploration", patternId: `p${i}`, estimatedMinutes: 1 })
    );
    const result = selectDailyTrainingItems({
      candidatesByTier: [[], [], [], [], [], manyCandidates],
      availableMinutes: 1000,
    });
    expect(result.items.length).toBeLessThanOrEqual(MAX_DAILY_TRAINING_ITEMS);
  });

  it("respeita um maxItems customizado menor que o padrão", () => {
    const result = selectDailyTrainingItems({
      candidatesByTier: [
        [],
        [],
        [],
        [],
        [],
        [
          candidate({ questionId: "q1", reason: "pattern_exploration", patternId: "p1" }),
          candidate({ questionId: "q2", reason: "pattern_exploration", patternId: "p2" }),
          candidate({ questionId: "q3", reason: "pattern_exploration", patternId: "p3" }),
        ],
      ],
      availableMinutes: 100,
      maxItems: 2,
    });
    expect(result.items).toHaveLength(2);
  });
});

describe("selectDailyTrainingItems — concentração por padrão (seção 7 da ordem)", () => {
  it("limita itens do mesmo padrão quando existem candidatos de outros padrões disponíveis", () => {
    const samePattern = Array.from({ length: 8 }, (_, i) => candidate({ questionId: `same-${i}`, reason: "pattern_exploration", patternId: "p-same" }));
    const otherPattern = candidate({ questionId: "other-1", reason: "pattern_exploration", patternId: "p-other" });
    const result = selectDailyTrainingItems({
      candidatesByTier: [[], [], [], [], [], [...samePattern, otherPattern]],
      availableMinutes: 1000,
      maxItems: 10,
    });
    const sameCount = result.items.filter((i) => i.patternId === "p-same").length;
    // MAX_SAME_PATTERN_RATIO = 0.4 de 10 = 4 (arredondado para cima).
    expect(sameCount).toBeLessThanOrEqual(4);
    expect(result.items.some((i) => i.patternId === "p-other")).toBe(true);
  });

  it("relaxa a restrição de concentração quando só existe UM padrão em toda a base de candidatos (nunca produz lista vazia por rigor excessivo)", () => {
    const onlyPattern = Array.from({ length: 6 }, (_, i) => candidate({ questionId: `q${i}`, reason: "pattern_exploration", patternId: "p-unico", estimatedMinutes: 1 }));
    const result = selectDailyTrainingItems({
      candidatesByTier: [[], [], [], [], [], onlyPattern],
      availableMinutes: 1000,
      maxItems: 10,
    });
    expect(result.items).toHaveLength(6);
  });
});

describe("selectDailyTrainingItems — determinismo", () => {
  it("mesmo conjunto de candidatos e mesma capacidade produzem sempre o mesmo resultado", () => {
    const build = () => ({
      candidatesByTier: [
        [candidate({ questionId: "q-overdue", reason: "overdue_review", patternId: "p1" })],
        [],
        [candidate({ questionId: "q-dev", reason: "pattern_in_development", patternId: "p2" })],
        [],
        [],
        [candidate({ questionId: "q-explore", reason: "pattern_exploration", patternId: "p3" })],
      ],
      availableMinutes: 30,
    });
    const r1 = selectDailyTrainingItems(build());
    const r2 = selectDailyTrainingItems(build());
    expect(r1).toEqual(r2);
  });
});
