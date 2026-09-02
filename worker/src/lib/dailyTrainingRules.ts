/* Sprint 11 v1.0 — regra adaptativa PROVISÓRIA do Treino Diário (seção 7 da
   ordem). Centralizada aqui, num único módulo testável, exatamente como
   worker/src/lib/spacedReview.ts (Sprint 9) e
   worker/src/lib/studentMetricsRules.ts (Sprint 10) fizeram para seus
   respectivos domínios. Nada aqui é uma fórmula pedagógica definitiva —
   são pesos, limites e uma ordem de prioridade TÉCNICOS, provisórios,
   pendentes de validação pedagógica da Andréia (ver
   docs/TREINO_DIARIO_LISTAS.md).

   Esta é uma função PURA: nenhum acesso a banco/relógio real, só entradas
   explícitas já resolvidas pelo repositório/serviço (mesmo padrão de
   scheduleService.ts:computePlan). Resultado determinístico para o mesmo
   conjunto de candidatos e a mesma capacidade — nunca Math.random() nem
   ORDER BY RANDOM() em lugar nenhum. */

export type DailyTrainingReasonCode =
  | "overdue_review"
  | "schedule_commitment"
  | "pattern_in_development"
  | "pattern_initial_evidence"
  | "pattern_maintenance"
  | "pattern_exploration";

export type DailyTrainingOrigin = "overdue_review" | "scheduled_review" | "development" | "consistency" | "schedule_commitment";

export type DailyTrainingPlayerMode = "learning" | "practice" | "recognition";

/** Mapa FIXO reason → origin (nunca decidido ad-hoc por chamada) — ver
 *  comentário extenso em migrations/0016_daily_training_lists.sql sobre por
 *  que `origin` (amplo, 5 valores) e `reason` (estreito, 6 valores, 1:1 com
 *  as camadas de prioridade da seção 7) são campos separados. */
export const REASON_TO_ORIGIN: Record<DailyTrainingReasonCode, DailyTrainingOrigin> = {
  overdue_review: "overdue_review",
  schedule_commitment: "schedule_commitment",
  pattern_in_development: "development",
  pattern_initial_evidence: "development",
  pattern_maintenance: "consistency",
  pattern_exploration: "development",
};

/** Explicação curta "Por que este item?" (seção 12 da ordem) — sempre
 *  técnica e honesta, nunca promete nota/TRI/domínio definitivo. */
export const REASON_LABELS: Record<DailyTrainingReasonCode, string> = {
  overdue_review: "Revisão espaçada vencida — reforça algo que você já viu antes.",
  schedule_commitment: "Você tem um compromisso de treino de questões agendado para hoje.",
  pattern_in_development: "Padrão que você está desenvolvendo agora.",
  pattern_initial_evidence: "Padrão com evidências iniciais — poucas tentativas registradas ainda.",
  pattern_maintenance: "Manutenção de um padrão já consistente neste recorte.",
  pattern_exploration: "Padrão ainda sem nenhuma evidência registrada — hora de conhecer.",
};

/** Ordem de prioridade das seis camadas (seção 7 da ordem) — o ÍNDICE no
 *  array é a prioridade (0 = mais prioritário). Usado só para documentar/
 *  validar a ordem; `selectDailyTrainingItems` recebe os candidatos JÁ
 *  agrupados nesta ordem pelo chamador (worker/src/services/
 *  dailyTrainingService.ts), nunca reordena por conta própria. */
export const PRIORITY_TIER_REASONS: readonly DailyTrainingReasonCode[] = [
  "overdue_review",
  "schedule_commitment",
  "pattern_in_development",
  "pattern_initial_evidence",
  "pattern_maintenance",
  "pattern_exploration",
];

/** Fallback técnico centralizado (seção 8 da ordem: "questão sem estimativa
 *  usa fallback técnico centralizado") quando `questions.
 *  tempo_estimado_segundos` é nulo. */
export const FALLBACK_ITEM_MINUTES = 4;

/** Limite absoluto de itens (seção 8 da ordem: "limite de itens evita
 *  listas absurdas mesmo com durações inválidas") — nunca ultrapassado,
 *  mesmo que a capacidade em minutos sozinha permitisse mais. */
export const MAX_DAILY_TRAINING_ITEMS = 10;

/** Proporção MÁXIMA de itens do MESMO padrão dentro da lista (seção 7 da
 *  ordem: "evitar concentração excessiva em um único padrão") — só
 *  aplicada quando existe candidato de OUTRO padrão disponível (ver
 *  `selectDailyTrainingItems`: quando só um único padrão tem candidatos em
 *  toda a base, a restrição não faz sentido e é relaxada, nunca produzindo
 *  uma lista vazia por excesso de rigor). */
export const MAX_SAME_PATTERN_RATIO = 0.4;

function minutesFromSeconds(seconds: number | null): number {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return FALLBACK_ITEM_MINUTES;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** Converte a duração estimada de uma questão (segundos, pode ser nulo/
 *  inválido) para minutos inteiros — sempre ≥ 1, sempre o fallback quando
 *  ausente/inválido. Único ponto de conversão no código (nunca duplicado). */
export function estimateItemMinutes(tempoEstimadoSegundos: number | null): number {
  return minutesFromSeconds(tempoEstimadoSegundos);
}

export interface DailyTrainingCandidate {
  questionId: string;
  patternId: string | null;
  reason: DailyTrainingReasonCode;
  playerMode: DailyTrainingPlayerMode;
  estimatedMinutes: number;
  errorEntryId?: string | null;
  sourceScheduleAssignmentId?: string | null;
}

export interface DailyTrainingSelectionItem extends DailyTrainingCandidate {
  origin: DailyTrainingOrigin;
  position: number;
}

export interface DailyTrainingSelectionResult {
  items: DailyTrainingSelectionItem[];
  totalMinutes: number;
}

function maxItemsForPattern(maxItems: number): number {
  return Math.max(1, Math.ceil(maxItems * MAX_SAME_PATTERN_RATIO));
}

/** Núcleo do algoritmo — recebe os candidatos JÁ organizados em seis grupos
 *  (índice 0..5, um por camada de prioridade da seção 7), cada grupo já
 *  ordenado deterministicamente pelo chamador (ex.: por código de questão/
 *  padrão ASC). Nunca reordena entre grupos nem dentro de um grupo — só
 *  decide QUAIS candidatos cabem, respeitando, nesta ordem de restrição:
 *
 *    1) nenhuma questão repetida na lista (garantia adicional em JS —
 *       o banco também garante via índice único, seção 5/7 da ordem);
 *    2) a lista nunca excede `availableMinutes` (seção 8) — um item que
 *       não caiba NUNCA é parcialmente incluído;
 *    3) nunca mais que `maxItems` itens (seção 8);
 *    4) concentração por padrão limitada a `MAX_SAME_PATTERN_RATIO` do
 *       total de itens — RELAXADA automaticamente se, entre TODOS os
 *       candidatos oferecidos (de todas as camadas), só existir um único
 *       padrão distinto (não há o que diversificar).
 *
 *  `availableMinutes <= 0` devolve lista vazia sem examinar nada — preview
 *  vazio honesto (seção 8: "indisponibilidade do dia gera preview vazio
 *  honesto"), nunca um erro. */
export function selectDailyTrainingItems(params: {
  candidatesByTier: DailyTrainingCandidate[][];
  availableMinutes: number;
  maxItems?: number;
}): DailyTrainingSelectionResult {
  const maxItems = Math.max(1, Math.min(params.maxItems ?? MAX_DAILY_TRAINING_ITEMS, MAX_DAILY_TRAINING_ITEMS));
  if (params.availableMinutes <= 0) return { items: [], totalMinutes: 0 };

  const allCandidatesFlat = params.candidatesByTier.flat();
  const distinctPatterns = new Set(allCandidatesFlat.map((c) => c.patternId ?? `no-pattern:${c.questionId}`));
  const enforceConcentrationCap = distinctPatterns.size > 1;
  const patternCap = maxItemsForPattern(maxItems);

  const selected: DailyTrainingSelectionItem[] = [];
  const usedQuestionIds = new Set<string>();
  const countByPattern = new Map<string, number>();
  let totalMinutes = 0;

  function tryAdd(candidate: DailyTrainingCandidate): boolean {
    if (selected.length >= maxItems) return false;
    if (usedQuestionIds.has(candidate.questionId)) return false;
    const minutes = Math.max(1, candidate.estimatedMinutes);
    if (totalMinutes + minutes > params.availableMinutes) return false;

    const patternKey = candidate.patternId ?? `no-pattern:${candidate.questionId}`;
    const currentPatternCount = countByPattern.get(patternKey) ?? 0;
    // O cap de concentração (seção 7 da ordem) só é avaliado quando existe
    // MAIS DE UM padrão em toda a base de candidatos (`enforceConcentrationCap`,
    // calculado uma única vez acima, sobre TODOS os candidatos de TODAS as
    // camadas) — quando só um padrão existe, não há o que diversificar, e a
    // restrição nunca impede a lista de crescer até a capacidade/maxItems.
    // Diferente de uma tentativa de "preencher a vaga depois" quando o cap
    // barra um candidato: um candidato barrado pelo cap é DEFINITIVAMENTE
    // descartado (nunca readicionado numa segunda passagem) — relaxar o
    // cap depois de já ter decidido aplicá-lo devolveria exatamente a
    // concentração excessiva que a regra existe para evitar.
    if (enforceConcentrationCap && currentPatternCount >= patternCap) return false;

    usedQuestionIds.add(candidate.questionId);
    countByPattern.set(patternKey, currentPatternCount + 1);
    totalMinutes += minutes;
    selected.push({ ...candidate, origin: REASON_TO_ORIGIN[candidate.reason], position: selected.length });
    return true;
  }

  for (const tier of params.candidatesByTier) {
    for (const candidate of tier) {
      if (selected.length >= maxItems || totalMinutes >= params.availableMinutes) break;
      tryAdd(candidate);
    }
  }

  return { items: selected, totalMinutes };
}
