/* Sprint 12 v1.0 — algoritmo determinístico PROVISÓRIO de seleção dos
   Simulados em Blocos (seção 8 da ordem). Centralizado aqui, num único
   módulo puro e testável, mesmo padrão de worker/src/lib/
   dailyTrainingRules.ts (Sprint 11) e worker/src/lib/spacedReview.ts
   (Sprint 9). Nada aqui é uma fórmula pedagógica definitiva — são pesos,
   limites e uma ordem de prioridade TÉCNICOS, provisórios, pendentes de
   validação pedagógica da Andréia (ver docs/SIMULADOS_BLOCOS.md).

   Função PURA: nenhum acesso a banco/relógio real, só entradas explícitas
   já resolvidas pelo repositório/serviço (mesmo padrão de
   dailyTrainingService.ts:buildCandidates + dailyTrainingRules.ts:
   selectDailyTrainingItems). Resultado determinístico para o mesmo conjunto
   de candidatos — nunca Math.random() nem ORDER BY RANDOM() em lugar
   nenhum. */

import { FALLBACK_ITEM_MINUTES, estimateItemMinutes } from "./dailyTrainingRules";

export { FALLBACK_ITEM_MINUTES, estimateItemMinutes };

/** Seção 6 da ordem — só dois tipos de bloco oferecidos nesta sprint. */
export type SimulationBlockType = "mixed" | "pattern_focused";

/** Seção 6 da ordem — tamanhos técnicos provisórios permitidos. Nunca 45
 *  ("prova completa" não é implementada nesta sprint — seção 6/23). */
export const ALLOWED_BLOCK_SIZES = [5, 10, 15] as const;
export type SimulationBlockSize = (typeof ALLOWED_BLOCK_SIZES)[number];

export function isAllowedBlockSize(value: unknown): value is SimulationBlockSize {
  return typeof value === "number" && (ALLOWED_BLOCK_SIZES as readonly number[]).includes(value);
}

/** Uma questão publicada, treinável, candidata a compor um bloco — já
 *  resolvida pelo repositório (worker/src/repositories/
 *  simulationsRepository.ts) a partir de questions/question_patterns reais,
 *  nunca fabricada. `questionCode` é usado só para desempate determinístico
 *  (ordem alfabética, mesma convenção de listTrainableQuestionsForPattern). */
export interface RawSimulationCandidate {
  questionId: string;
  questionCode: string;
  patternId: string;
  estimatedMinutes: number;
}

export interface SimulationSelectionItem {
  questionId: string;
  patternId: string;
  estimatedMinutes: number;
  position: number;
}

export interface SimulationSelectionResult {
  items: SimulationSelectionItem[];
  totalMinutes: number;
  /** Quantidade de candidatas DISTINTAS oferecidas (antes do corte por
   *  `size`) — seção 7 da ordem: "quantidade disponível" no preview. Nunca
   *  conta a mesma questão duas vezes. */
  availableCount: number;
}

/** Seção 8 da ordem: "evitar questões concluídas muito recentemente quando
 *  houver alternativa" — questões NÃO concluídas recentemente vêm sempre
 *  primeiro (ordenadas por código, desempate estável); as concluídas
 *  recentemente só entram como fallback, ao final, na mesma ordem por
 *  código. Nunca EXCLUI uma questão recente — só a deprioriza, honrando
 *  "fallback honesto quando não houver quantidade suficiente" (nenhuma
 *  questão é descartada quando ela é a única alternativa disponível). */
function orderCandidatesForSelection(candidates: RawSimulationCandidate[], recentlyCompletedQuestionIds: ReadonlySet<string>): RawSimulationCandidate[] {
  const byCode = (a: RawSimulationCandidate, b: RawSimulationCandidate) => (a.questionCode < b.questionCode ? -1 : a.questionCode > b.questionCode ? 1 : a.questionId < b.questionId ? -1 : 1);
  const notRecent = candidates.filter((c) => !recentlyCompletedQuestionIds.has(c.questionId)).sort(byCode);
  const recent = candidates.filter((c) => recentlyCompletedQuestionIds.has(c.questionId)).sort(byCode);
  return [...notRecent, ...recent];
}

function toSelectionItem(candidate: RawSimulationCandidate, position: number): SimulationSelectionItem {
  return { questionId: candidate.questionId, patternId: candidate.patternId, estimatedMinutes: Math.max(1, candidate.estimatedMinutes), position };
}

/** Bloco FOCADO em um único padrão (seção 6 da ordem: "somente questões
 *  cujo padrão principal seja o padrão escolhido"). `candidates` já vem
 *  filtrado pelo repositório a exatamente esse padrão — esta função só
 *  ordena e corta em `size`, sem nenhuma exclusão adicional. Nunca duplica
 *  questão (cada `questionId` aparece no máximo uma vez em `candidates`, por
 *  construção da consulta de origem; ainda assim, dedupla defensivamente por
 *  segurança). */
export function selectPatternFocusedBlock(params: {
  candidates: RawSimulationCandidate[];
  size: SimulationBlockSize;
  recentlyCompletedQuestionIds: ReadonlySet<string>;
}): SimulationSelectionResult {
  const seen = new Set<string>();
  const deduped = params.candidates.filter((c) => {
    if (seen.has(c.questionId)) return false;
    seen.add(c.questionId);
    return true;
  });
  const ordered = orderCandidatesForSelection(deduped, params.recentlyCompletedQuestionIds);
  const chosen = ordered.slice(0, params.size);
  return {
    items: chosen.map((c, index) => toSelectionItem(c, index)),
    totalMinutes: chosen.reduce((sum, c) => sum + Math.max(1, c.estimatedMinutes), 0),
    availableCount: deduped.length,
  };
}

/** Bloco MISTO (seção 6 da ordem: "questões distribuídas entre padrões
 *  publicados... priorizar diversidade... evitar concentração excessiva").
 *  `patternGroups` já vem agrupado por padrão principal E ordenado por
 *  prioridade (ex.: padrão menos recentemente praticado primeiro — seção 6:
 *  "usar evidências do Mapa ENEM somente para ordenar, nunca para excluir
 *  definitivamente um padrão") pelo chamador (worker/src/services/
 *  simulationsService.ts); esta função nunca reordena os GRUPOS entre si,
 *  só ordena DENTRO de cada grupo (por recência de conclusão + código) e
 *  decide quais candidatos cabem.
 *
 *  Estratégia de diversidade: round-robin determinístico — uma questão de
 *  cada grupo por rodada, na ordem de prioridade dos grupos, até `size` ou
 *  esgotar todos os grupos. Isto distribui os itens o mais uniformemente
 *  possível entre os padrões disponíveis (nenhum padrão recebe uma segunda
 *  questão antes que todo padrão elegível já tenha recebido uma primeira),
 *  sem precisar de uma proporção máxima configurável separada — regra
 *  técnica provisória, documentada aqui e em docs/SIMULADOS_BLOCOS.md. */
export function selectMixedBlock(params: {
  patternGroups: RawSimulationCandidate[][];
  size: SimulationBlockSize;
  recentlyCompletedQuestionIds: ReadonlySet<string>;
}): SimulationSelectionResult {
  const usedQuestionIds = new Set<string>();
  let availableCount = 0;
  const orderedGroups = params.patternGroups.map((group) => {
    const seen = new Set<string>();
    const deduped = group.filter((c) => {
      if (seen.has(c.questionId)) return false;
      seen.add(c.questionId);
      return true;
    });
    availableCount += deduped.length;
    return orderCandidatesForSelection(deduped, params.recentlyCompletedQuestionIds);
  });

  const cursors = orderedGroups.map(() => 0);
  const selected: RawSimulationCandidate[] = [];

  let progressedThisPass = true;
  while (selected.length < params.size && progressedThisPass) {
    progressedThisPass = false;
    for (let groupIndex = 0; groupIndex < orderedGroups.length; groupIndex++) {
      if (selected.length >= params.size) break;
      const group = orderedGroups[groupIndex];
      let cursor = cursors[groupIndex];
      while (cursor < group.length && usedQuestionIds.has(group[cursor].questionId)) cursor++;
      if (cursor >= group.length) {
        cursors[groupIndex] = cursor;
        continue;
      }
      const candidate = group[cursor];
      usedQuestionIds.add(candidate.questionId);
      selected.push(candidate);
      cursors[groupIndex] = cursor + 1;
      progressedThisPass = true;
    }
  }

  return {
    items: selected.map((c, index) => toSelectionItem(c, index)),
    totalMinutes: selected.reduce((sum, c) => sum + Math.max(1, c.estimatedMinutes), 0),
    availableCount,
  };
}
