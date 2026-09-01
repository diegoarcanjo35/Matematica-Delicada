import type { Clock } from "../services/scheduleService";

/* Sprint 9 v1.0 — regras técnicas PROVISÓRIAS da revisão espaçada (seção 6
   da ordem). O Documento Mestre define que a revisão espaçada existe, mas
   NÃO define os intervalos exatos — por isso ficam centralizados aqui, num
   único módulo, facilmente substituível quando a Andreia validar os
   intervalos pedagogicamente de verdade. Nada aqui é uma decisão
   pedagógica definitiva (ver docs/CADERNO_ERROS_REVISAO.md).

   Relógio: reaproveita o MESMO `Clock` injetável já adotado desde a Sprint
   5 (scheduleService.ts) — nunca um novo tipo de relógio para este módulo.
   Todo cálculo de próxima revisão usa `clock.now()` (o timestamp EFETIVO
   do evento no servidor), nunca `new Date()` direto nem qualquer valor
   vindo do corpo da requisição/relógio do navegador. */

export type { Clock };

/** Estágio 0 = erro original ainda não revisado com sucesso nenhuma vez
 *  (ou resetado por uma revisão incorreta). Estágios 1-3 = 1ª/2ª/3ª
 *  revisão correta consecutiva. Estágio 4+ = toda confirmação correta
 *  subsequente ("confirmação posterior"), sempre +30 dias. */
export const REVIEW_INTERVAL_DAYS_BY_STAGE: Readonly<Record<number, number>> = {
  0: 1, // erro original ou revisão incorreta
  1: 3, // 1ª revisão correta
  2: 7, // 2ª revisão correta
  3: 14, // 3ª revisão correta
};
export const REVIEW_INTERVAL_DAYS_STEADY_STATE = 30; // confirmação posterior (estágio 4+)

function intervalDaysForStage(stage: number): number {
  if (stage in REVIEW_INTERVAL_DAYS_BY_STAGE) return REVIEW_INTERVAL_DAYS_BY_STAGE[stage];
  return REVIEW_INTERVAL_DAYS_STEADY_STATE;
}

function addDaysIso(base: Date, days: number): string {
  const next = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return next.toISOString();
}

export interface ReviewScheduleResult {
  resultingStage: number;
  nextReviewAt: string;
}

/** Calcula o próximo estágio/data a partir do resultado de UMA revisão
 *  (ou do erro original, chamando com `previousStage = 0` e
 *  `result = "incorrect"` na prática — ver `scheduleFirstReview` abaixo
 *  para o caso do registro automático inicial, que não é uma "revisão"
 *  ainda). Nunca declara domínio nem calcula os três índices — só agenda
 *  a PRÓXIMA data técnica. */
export function computeNextReviewSchedule(previousStage: number, result: "correct" | "incorrect", now: Date): ReviewScheduleResult {
  if (result === "incorrect") {
    // Seção 6 da ordem: resposta incorreta em revisão SEMPRE volta o
    // estágio para zero e agenda +1 dia — nunca decrementa gradualmente.
    return { resultingStage: 0, nextReviewAt: addDaysIso(now, REVIEW_INTERVAL_DAYS_BY_STAGE[0]) };
  }
  const resultingStage = previousStage + 1;
  return { resultingStage, nextReviewAt: addDaysIso(now, intervalDaysForStage(resultingStage)) };
}

/** Agendamento da PRIMEIRA revisão, no momento em que o erro é registrado
 *  automaticamente (seção 5 da ordem) — sempre +1 dia, estágio 0, a
 *  partir do timestamp efetivo da própria confirmação (nunca do relógio
 *  do navegador). */
export function scheduleFirstReview(now: Date): { reviewStage: number; nextReviewAt: string } {
  return { reviewStage: 0, nextReviewAt: addDaysIso(now, REVIEW_INTERVAL_DAYS_BY_STAGE[0]) };
}

/* --------------------------- Critério de "corrected" --------------------------- */

/* Seção 6.1 da ordem — critério técnico PROVISÓRIO de correção, também
   centralizado aqui e sujeito a revisão pedagógica futura. NUNCA considerar
   corrigido por acertar de novo a MESMA questão uma única vez. */

export const MIN_CORRECT_REVIEWS_FOR_CORRECTED = 2;
export const MIN_DISTINCT_QUESTIONS_FOR_CORRECTED = 2;

export interface CorrectionCriteriaInput {
  /** Total de eventos de revisão CORRETOS já registrados para a entrada,
   *  incluindo o que acabou de ser confirmado nesta chamada. */
  totalCorrectReviews: number;
  /** Quantidade de questões DISTINTAS com pelo menos uma revisão correta,
   *  incluindo a desta chamada (error_notebook_entries.distinct_review_questions_succeeded
   *  já recalculado). */
  distinctQuestionsSucceeded: number;
  /** Verdadeiro se PELO MENOS UMA revisão correta já registrada (histórico
   *  completo, incluindo esta) usou uma questão DIFERENTE da original. */
  hasSuccessOnDifferentQuestion: boolean;
}

/** Verdadeiro somente quando as três condições da seção 6.1 se cumprem
 *  simultaneamente. Se `hasSuccessOnDifferentQuestion` for falso (só
 *  existe a questão original disponível, ou o aluno só acertou a
 *  original até agora), a entrada PERMANECE ativa — o chamador deve
 *  surfacear honestamente que "outro contexto" ainda não foi comprovado
 *  (nunca fingir correção). */
export function meetsCorrectionCriteria(input: CorrectionCriteriaInput): boolean {
  return (
    input.totalCorrectReviews >= MIN_CORRECT_REVIEWS_FOR_CORRECTED &&
    input.distinctQuestionsSucceeded >= MIN_DISTINCT_QUESTIONS_FOR_CORRECTED &&
    input.hasSuccessOnDifferentQuestion
  );
}
