// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ALLOWED_BLOCK_SIZES,
  isAllowedBlockSize,
  selectMixedBlock,
  selectPatternFocusedBlock,
  type RawSimulationCandidate,
} from "../src/lib/simulationRules";

/* Sprint 12 v1.0 — testes da função PURA de seleção determinística (seção 8
   da ordem), sem nenhum acesso a banco. Mesmo padrão de
   worker/testing/dailyTrainingAlgorithm.test.ts (Sprint 11). */

function candidate(id: string, code: string, patternId: string, minutes = 5): RawSimulationCandidate {
  return { questionId: id, questionCode: code, patternId, estimatedMinutes: minutes };
}

describe("isAllowedBlockSize", () => {
  it("aceita somente 5, 10 e 15", () => {
    expect(ALLOWED_BLOCK_SIZES).toEqual([5, 10, 15]);
    expect(isAllowedBlockSize(5)).toBe(true);
    expect(isAllowedBlockSize(10)).toBe(true);
    expect(isAllowedBlockSize(15)).toBe(true);
    expect(isAllowedBlockSize(45)).toBe(false);
    expect(isAllowedBlockSize(1)).toBe(false);
    expect(isAllowedBlockSize("5")).toBe(false);
    expect(isAllowedBlockSize(undefined)).toBe(false);
  });
});

describe("selectPatternFocusedBlock", () => {
  it("seleciona até `size` questões do único padrão, ordenadas por código (estabilidade determinística)", () => {
    const candidates = [candidate("q3", "C-03", "p1"), candidate("q1", "C-01", "p1"), candidate("q2", "C-02", "p1")];
    const result = selectPatternFocusedBlock({ candidates, size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.map((i) => i.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(result.availableCount).toBe(3);
    expect(result.items.length).toBe(3); // menos que o tamanho pedido — honesto, nunca preenchido artificialmente
  });

  it("corta exatamente em `size` quando há candidatas suficientes", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => candidate(`q${i}`, `C-0${i}`, "p1"));
    const result = selectPatternFocusedBlock({ candidates, size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.length).toBe(5);
    expect(result.availableCount).toBe(8);
  });

  it("mesma entrada e mesmo relógio produzem a MESMA ordem sempre (determinismo)", () => {
    const candidates = [candidate("q3", "C-03", "p1"), candidate("q1", "C-01", "p1"), candidate("q2", "C-02", "p1")];
    const r1 = selectPatternFocusedBlock({ candidates, size: 5, recentlyCompletedQuestionIds: new Set() });
    const r2 = selectPatternFocusedBlock({ candidates, size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(r1.items.map((i) => i.questionId)).toEqual(r2.items.map((i) => i.questionId));
  });

  it("questões concluídas recentemente são deprioridadas, mas ainda entram como fallback quando são a única alternativa", () => {
    const candidates = [candidate("q1", "C-01", "p1"), candidate("q2", "C-02", "p1")];
    const result = selectPatternFocusedBlock({ candidates, size: 2, recentlyCompletedQuestionIds: new Set(["q1"]) });
    // q2 (não recente) vem primeiro; q1 (recente) entra depois, nunca excluída.
    expect(result.items.map((i) => i.questionId)).toEqual(["q2", "q1"]);
  });

  it("nunca duplica uma questão mesmo se ela aparecer duas vezes na entrada (deduplicação defensiva)", () => {
    const candidates = [candidate("q1", "C-01", "p1"), candidate("q1", "C-01", "p1")];
    const result = selectPatternFocusedBlock({ candidates, size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.length).toBe(1);
    expect(result.availableCount).toBe(1);
  });

  it("nenhuma candidata disponível gera resultado vazio honesto, nunca erro", () => {
    const result = selectPatternFocusedBlock({ candidates: [], size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items).toEqual([]);
    expect(result.totalMinutes).toBe(0);
    expect(result.availableCount).toBe(0);
  });

  it("soma dos minutos estimados usa fallback centralizado (mínimo 1 minuto) e nunca fabrica duração zero", () => {
    const candidates = [candidate("q1", "C-01", "p1", 0)];
    const result = selectPatternFocusedBlock({ candidates, size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.totalMinutes).toBeGreaterThanOrEqual(1);
  });
});

describe("selectMixedBlock", () => {
  it("distribui por round-robin entre os grupos, priorizando diversidade (uma questão por padrão antes de repetir padrão)", () => {
    const groupA = [candidate("a1", "A-01", "pA"), candidate("a2", "A-02", "pA"), candidate("a3", "A-03", "pA")];
    const groupB = [candidate("b1", "B-01", "pB"), candidate("b2", "B-02", "pB")];
    const result = selectMixedBlock({ patternGroups: [groupA, groupB], size: 4, recentlyCompletedQuestionIds: new Set() });
    // Rodada 1: a1, b1 — Rodada 2: a2, b2 (grupo B já esgotado depois) — nunca a2,a3 antes de b1.
    expect(result.items.map((i) => i.questionId)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("quando um grupo esgota, continua puxando dos grupos restantes até `size` ou esgotar tudo", () => {
    const groupA = [candidate("a1", "A-01", "pA")];
    const groupB = [candidate("b1", "B-01", "pB"), candidate("b2", "B-02", "pB"), candidate("b3", "B-03", "pB")];
    const result = selectMixedBlock({ patternGroups: [groupA, groupB], size: 4, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.map((i) => i.questionId)).toEqual(["a1", "b1", "b2", "b3"]);
    expect(result.availableCount).toBe(4);
  });

  it("nunca ultrapassa `size` mesmo com candidatas de sobra", () => {
    const groupA = Array.from({ length: 10 }, (_, i) => candidate(`a${i}`, `A-${i}`, "pA"));
    const result = selectMixedBlock({ patternGroups: [groupA], size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.length).toBe(5);
  });

  it("nunca duplica questão entre grupos diferentes", () => {
    const groupA = [candidate("q1", "A-01", "pA")];
    const groupB = [candidate("q1", "A-01", "pB")]; // mesma questão, hipoteticamente listada em dois grupos
    const result = selectMixedBlock({ patternGroups: [groupA, groupB], size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.length).toBe(1);
  });

  it("respeita a ordem de prioridade dos GRUPOS recebida do chamador (nunca reordena grupos)", () => {
    const groupLowPriority = [candidate("low1", "L-01", "pLow")];
    const groupHighPriority = [candidate("high1", "H-01", "pHigh")];
    // Grupo de alta prioridade vem PRIMEIRO na entrada — a função nunca
    // reordena os grupos entre si, só decide QUAIS candidatos cabem.
    const result = selectMixedBlock({ patternGroups: [groupHighPriority, groupLowPriority], size: 1, recentlyCompletedQuestionIds: new Set() });
    expect(result.items.map((i) => i.questionId)).toEqual(["high1"]);
  });

  it("nenhum grupo disponível gera resultado vazio honesto, nunca erro", () => {
    const result = selectMixedBlock({ patternGroups: [], size: 5, recentlyCompletedQuestionIds: new Set() });
    expect(result.items).toEqual([]);
    expect(result.availableCount).toBe(0);
  });

  it("questões recentes são deprioridadas dentro de cada grupo, mas nunca excluídas quando são a única alternativa do grupo", () => {
    const groupA = [candidate("a1", "A-01", "pA"), candidate("a2", "A-02", "pA")];
    const result = selectMixedBlock({ patternGroups: [groupA], size: 2, recentlyCompletedQuestionIds: new Set(["a1"]) });
    expect(result.items.map((i) => i.questionId)).toEqual(["a2", "a1"]);
  });
});
