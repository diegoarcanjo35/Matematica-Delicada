/* Opções de UI para o onboarding — espelham os conjuntos fechados de
   worker/src/lib/onboardingValidation.ts. Mantidas separadas de propósito:
   frontend e Worker são bundles diferentes; a validação real e definitiva é
   sempre a do Worker (nunca confiar só na validação do cliente). */

export const GRADE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "8_ano_ef", label: "8º ano do Ensino Fundamental" },
  { value: "9_ano_ef", label: "9º ano do Ensino Fundamental" },
  { value: "1_serie_em", label: "1ª série do Ensino Médio" },
  { value: "2_serie_em", label: "2ª série do Ensino Médio" },
  { value: "3_serie_em", label: "3ª série do Ensino Médio" },
  { value: "concluido_em", label: "Já concluí o Ensino Médio" },
];

export const GOAL_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "acertos", label: "Quantidade de acertos" },
  { value: "nota", label: "Nota (escala do ENEM)" },
];

export const TIME_PREFERENCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "manha", label: "Manhã" },
  { value: "tarde", label: "Tarde" },
  { value: "noite", label: "Noite" },
  { value: "variavel", label: "Variável" },
];

export const WEEKDAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "seg", label: "Segunda" },
  { value: "ter", label: "Terça" },
  { value: "qua", label: "Quarta" },
  { value: "qui", label: "Quinta" },
  { value: "sex", label: "Sexta" },
  { value: "sab", label: "Sábado" },
  { value: "dom", label: "Domingo" },
];

export const ENEM_MATH_QUESTION_COUNT = 45;
export const GOAL_SCORE_MIN = 0;
export const GOAL_SCORE_MAX = 1000;
export const DAILY_MINUTES_MIN = 10;
export const DAILY_MINUTES_MAX = 240;
export const DIFFICULTIES_MAX_ITEMS = 6;
export const DIFFICULTY_TEXT_MAX_LENGTH = 80;
export const ACCESSIBILITY_TEXT_MAX_LENGTH = 200;

export const STEP_COUNT = 7;
export const STEP_TITLES = [
  "Momento escolar e ENEM",
  "Meta e ponto atual",
  "Disponibilidade e rotina",
  "Dificuldades percebidas",
  "Preferências e acessibilidade",
  "Diagnóstico",
  "Revisão e conclusão",
];
