/* Regras técnicas PROVISÓRIAS da meta semanal — Sprint 13 v1.0.

   Centralizadas aqui, mesmo princípio de worker/src/lib/studentMetricsRules.ts
   (Sprint 10) e dailyTrainingRules.ts/simulationRules.ts (Sprints 11/12):
   nenhum limite aqui é uma decisão pedagógica definitiva da Andreia — são
   números TÉCNICOS provisórios, escolhidos para serem simples e
   explicáveis, nunca para otimizar nenhuma métrica ou prometer melhora de
   nota/aprovação (seção 8 da ordem). Documentados também em
   docs/RELATORIO_SEMANAL_METAS.md. 100% puro — nenhuma função aqui acessa
   banco, relógio real ou rede; toda entrada é explícita. */

export const MIN_WEEKLY_TARGET_MINUTES = 30;
export const MAX_WEEKLY_TARGET_MINUTES = 1500; // 25h/semana — teto técnico de digitação, nunca uma meta recomendada
export const MIN_WEEKLY_TARGET_QUESTIONS = 1;
export const MAX_WEEKLY_TARGET_QUESTIONS = 500;
export const MAX_GOAL_PATTERNS = 3;

/** Seção 8 da ordem: "quando não houver disponibilidade, usar uma sugestão
 *  conservadora e explicar que ela é editável" — usada só quando o aluno
 *  não tem `available_days`/`daily_minutes` declarados no onboarding (ou
 *  declarou uma capacidade semanal de 0 minutos). */
export const CONSERVATIVE_DEFAULT_WEEKLY_MINUTES = 150;

/** Estimativa TÉCNICA de minutos por questão, usada só para converter a
 *  sugestão de minutos numa sugestão de questões — nunca o tempo real
 *  medido de nenhuma questão específica (a sugestão da PRÓXIMA semana não
 *  pode depender de quais questões concretas serão praticadas, que ainda
 *  não foram escolhidas). */
export const AVG_MINUTES_PER_QUESTION = 3;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Seção 8 da ordem: "partir da disponibilidade do onboarding quando
 *  houver" e "não sugerir mais minutos do que a capacidade semanal
 *  declarada". `weeklyCapacityMinutes` já vem calculado pelo chamador
 *  (dailyMinutes × quantidade de dias disponíveis) — esta função só aplica
 *  o teto/piso técnico e o fallback conservador. */
export function suggestWeeklyMinutes(weeklyCapacityMinutes: number): number {
  const base = weeklyCapacityMinutes > 0 ? weeklyCapacityMinutes : CONSERVATIVE_DEFAULT_WEEKLY_MINUTES;
  return clamp(Math.round(base), MIN_WEEKLY_TARGET_MINUTES, MAX_WEEKLY_TARGET_MINUTES);
}

export function suggestWeeklyQuestions(suggestedMinutes: number): number {
  return clamp(Math.round(suggestedMinutes / AVG_MINUTES_PER_QUESTION), MIN_WEEKLY_TARGET_QUESTIONS, MAX_WEEKLY_TARGET_QUESTIONS);
}

export interface PatternCandidate {
  patternId: string;
  patternCode: string;
  patternName: string;
  /** 0 = revisão vencida (mais urgente), 1 = pendência ativa no Caderno de
   *  Erros, 2 = evidência recente em desenvolvimento — seção 8 da ordem,
   *  nesta ordem de prioridade. O CHAMADOR decide a que tier único cada
   *  padrão pertence (o mais urgente em que se qualifica), nunca duplicando
   *  o mesmo padrão em dois tiers. */
  urgencyRank: 0 | 1 | 2;
  /** Sinal de "atividade mais recente" deste padrão NESTE tier (seção 8:
   *  desempate por "atividade mais recente" depois da urgência) — string
   *  comparável lexicograficamente (ISO 8601 ou vazio). Vazio = nunca
   *  praticado/nunca vencido, tratado como o valor "mais antigo" possível
   *  (fica por último dentro do próprio tier). */
  recencyKey: string;
}

export interface SuggestedPattern {
  patternId: string;
  patternName: string;
  priorityPosition: number;
  reason: "overdue_review" | "error_notebook_pending" | "recent_development";
}

const REASON_BY_TIER: Record<number, SuggestedPattern["reason"]> = {
  0: "overdue_review",
  1: "error_notebook_pending",
  2: "recent_development",
};

/** Seção 8 da ordem — seleciona até `MAX_GOAL_PATTERNS` padrões, ordenados
 *  por urgência (tier ASC), depois por atividade mais recente (recencyKey
 *  DESC — mais recente primeiro), depois por código/slug ASC (desempate
 *  determinístico final) — nunca `ORDER BY RANDOM()`, nunca dependente da
 *  ordem de chegada da consulta SQL. Função pura: só ordena e corta a lista
 *  já montada pelo chamador. */
export function selectSuggestedPatterns(candidates: PatternCandidate[]): SuggestedPattern[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
    if (a.recencyKey !== b.recencyKey) return a.recencyKey > b.recencyKey ? -1 : 1;
    return a.patternCode < b.patternCode ? -1 : a.patternCode > b.patternCode ? 1 : 0;
  });
  return sorted.slice(0, MAX_GOAL_PATTERNS).map((candidate, index) => ({
    patternId: candidate.patternId,
    patternName: candidate.patternName,
    priorityPosition: index + 1,
    reason: REASON_BY_TIER[candidate.urgencyRank],
  }));
}

/* ------------------------------ Progresso factual (seção 4.4) ------------------------------ */

export interface GoalProgressPercentInput {
  targetMinutes: number;
  targetQuestions: number;
  /** `null` = evidência insuficiente/indisponível para este cálculo (nunca
   *  tratado como 0 — seção 4.4: "se o denominador for zero ou a evidência
   *  for insuficiente, não apresentar porcentagem enganosa"). */
  minutesDone: number | null;
  questionsDone: number | null;
}

export interface GoalProgressPercentResult {
  minutesPercent: number | null;
  questionsPercent: number | null;
}

/** Nunca persiste o resultado (seção 4.4: "não persistir porcentagem
 *  calculada") — recalculado a cada leitura, sempre a partir de evidência
 *  real já lida pelo chamador. `targetMinutes`/`targetQuestions` são sempre
 *  > 0 por construção (CHECK do banco, migrations/0018), então o único caso
 *  de denominador problemático é evidência ausente (`null`), nunca divisão
 *  por zero. */
export function computeGoalProgressPercents(input: GoalProgressPercentInput): GoalProgressPercentResult {
  return {
    minutesPercent: input.minutesDone !== null && input.targetMinutes > 0 ? Math.round((input.minutesDone / input.targetMinutes) * 100) : null,
    questionsPercent: input.questionsDone !== null && input.targetQuestions > 0 ? Math.round((input.questionsDone / input.targetQuestions) * 100) : null,
  };
}

/* ------------------------------ Validação de entrada ------------------------------ */

export interface FieldValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): FieldValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): FieldValidationResult<T> {
  return { ok: false, error };
}

export function validateTargetMinutes(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_WEEKLY_TARGET_MINUTES || value > MAX_WEEKLY_TARGET_MINUTES) {
    return fail(`Minutos semanais pretendidos devem ser um número inteiro entre ${MIN_WEEKLY_TARGET_MINUTES} e ${MAX_WEEKLY_TARGET_MINUTES}.`);
  }
  return ok(value);
}

export function validateTargetQuestions(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_WEEKLY_TARGET_QUESTIONS || value > MAX_WEEKLY_TARGET_QUESTIONS) {
    return fail(`Questões semanais pretendidas devem ser um número inteiro entre ${MIN_WEEKLY_TARGET_QUESTIONS} e ${MAX_WEEKLY_TARGET_QUESTIONS}.`);
  }
  return ok(value);
}

const VALID_WEEKDAY_CODES = new Set(["dom", "seg", "ter", "qua", "qui", "sex", "sab"]);

export function validateAvailableDays(value: unknown): FieldValidationResult<string[]> {
  if (!Array.isArray(value)) return fail("Dias disponíveis inválidos.");
  if (!value.every((day): day is string => typeof day === "string" && VALID_WEEKDAY_CODES.has(day))) {
    return fail("Dia da semana inválido.");
  }
  const days = value as string[];
  if (new Set(days).size !== days.length) return fail("Dias disponíveis duplicados.");
  return ok(days);
}

/** `undefined` (campo ausente) é tratado como "nenhum padrão prioritário" —
 *  seção 4.3 da ordem permite 0 a 3 padrões, nunca obrigatório. */
export function validatePatternIds(value: unknown): FieldValidationResult<string[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string" && id.trim().length > 0)) {
    return fail("Padrões prioritários inválidos.");
  }
  const ids = value as string[];
  if (ids.length > MAX_GOAL_PATTERNS) return fail(`No máximo ${MAX_GOAL_PATTERNS} padrões prioritários.`);
  if (new Set(ids).size !== ids.length) return fail("Padrões prioritários duplicados.");
  return ok(ids);
}

export function validateWeekStartFormat(value: unknown): FieldValidationResult<string> {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fail("Data de início de semana inválida.");
  }
  return ok(value);
}
