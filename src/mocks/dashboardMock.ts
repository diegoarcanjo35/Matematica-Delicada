/* DADOS DEMONSTRATIVOS (MOCK) — Sprint 1.
   Nenhum valor aqui vem de cálculo real ou de dado de aluno verdadeiro.
   Fonte dos números: Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md, seção 22.
   Esta camada deve ser substituída por dados reais em sprint futura (diagnóstico,
   índices de reconhecimento/resolução/domínio ainda não existem nesta sprint). */

import type { BadgeStatus } from "../components/Badge";

export const MOCK_STUDENT = {
  firstName: "Ana Cláudia",
  greeting: "Boa tarde, Ana Cláudia! ♡",
  tagline: "Foco hoje, vitória no ENEM",
  streakDays: 12,
};

export const MOCK_ENEM_MAP = {
  patternsDominated: 12,
  patternsTotal: 20,
  overallPercent: 60,
  recognitionPercent: 78,
  resolutionPercent: 71,
};

export const MOCK_TODAY_TRAINING = {
  questionCount: 7,
  estimatedMinutes: 18,
  patterns: [
    { code: "P03", name: "Razão em Gráfico", questionCount: 3 },
    { code: "P12", name: "Escala", questionCount: 2 },
    { code: "P08", name: "Porcentagem Direta", questionCount: 1 },
  ],
  spacedReviewCount: 1,
  message: "Hoje vamos atacar justamente o que ainda está roubando seus pontos.",
};

export const MOCK_BIGGEST_BOTTLENECK = {
  code: "P03",
  name: "Razão em Gráfico",
  masteryPercent: 42,
  cause: "reconhecimento e resolução" as const,
  recommendation:
    "Comece pelos enunciados com gráfico de barras — é onde você mais hesita antes de escolher a estratégia.",
};

export const MOCK_WEEK_EVOLUTION = {
  days: ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"],
  values: [52, 55, 58, 57, 61, 63, 60],
  variationPercent: 8,
  sessionsCompleted: 6,
};

export const MOCK_PATTERN_CARDS: Array<{
  code: string;
  name: string;
  masteryPercent: number;
  recognitionPercent: number;
  resolutionPercent: number;
  status: BadgeStatus;
}> = [
  {
    code: "P03",
    name: "Razão em Gráfico",
    masteryPercent: 42,
    recognitionPercent: 61,
    resolutionPercent: 35,
    status: "prioridade-alta",
  },
  {
    code: "P08",
    name: "Porcentagem Direta",
    masteryPercent: 91,
    recognitionPercent: 94,
    resolutionPercent: 88,
    status: "dominado",
  },
  {
    code: "P12",
    name: "Escala",
    masteryPercent: 67,
    recognitionPercent: 72,
    resolutionPercent: 61,
    status: "em-evolucao",
  },
  {
    code: "P15",
    name: "Mediana e Frequência",
    masteryPercent: 48,
    recognitionPercent: 52,
    resolutionPercent: 43,
    status: "prioridade-alta",
  },
  {
    code: "P18",
    name: "Projeção Ortogonal",
    masteryPercent: 30,
    recognitionPercent: 42,
    resolutionPercent: 21,
    status: "muito-fragil",
  },
];
