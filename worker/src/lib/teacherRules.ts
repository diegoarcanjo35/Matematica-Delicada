/* Regras técnicas do Painel do Professor — Sprint 14 v1.0.

   Só constantes e funções PURAS (nenhum acesso a banco aqui) — mesmo padrão
   de dailyTrainingRules.ts/weeklyGoalRules.ts/studentMetricsRules.ts.
   Nenhuma fórmula pedagógica nova é criada neste arquivo: toda classificação
   aqui é um recorte FACTUAL sobre contadores já existentes, produzidos por
   worker/src/repositories/teacherRepository.ts — nunca um julgamento sobre o
   aluno (ordem seção 11: proibido "fraco"/"ruim"/"desinteressado"/
   "atrasado"/"em risco"). */

// Janela técnica de "atividade recente" (ordem seção 11: "constante técnica
// centralizada e claramente documentada"). Um aluno sem NENHUMA tentativa
// confirmada nos últimos RECENT_ACTIVITY_WINDOW_DAYS dias corridos é
// classificado como "sem atividade recente" — nunca como "fraco" ou
// "desinteressado". Conceito técnico próprio deste painel, independente de
// qualquer janela usada do lado do aluno (ex.: exclusão de repetição do
// treino diário) — documentado também em docs/PAINEL_PROFESSOR.md.
export const RECENT_ACTIVITY_WINDOW_DAYS = 7;

export const STUDENT_LIST_SORTS = [
  "nome_asc",
  "nome_desc",
  "atividade_recente_desc",
  "revisoes_vencidas_desc",
] as const;
export type StudentListSort = (typeof STUDENT_LIST_SORTS)[number];
export function isStudentListSort(value: string): value is StudentListSort {
  return (STUDENT_LIST_SORTS as readonly string[]).includes(value);
}
export const DEFAULT_STUDENT_LIST_SORT: StudentListSort = "nome_asc";

export const STUDENT_LIST_FILTERS = [
  "com_atividade_recente",
  "sem_atividade_recente",
  "com_revisao_vencida",
  "com_meta_ativa",
  "com_caderno_pendente",
] as const;
export type StudentListFilter = (typeof STUDENT_LIST_FILTERS)[number];
export function isStudentListFilter(value: string): value is StudentListFilter {
  return (STUDENT_LIST_FILTERS as readonly string[]).includes(value);
}

export const STUDENT_LIST_PAGE_SIZE_DEFAULT = 20;
export const STUDENT_LIST_PAGE_SIZE_MAX = 50;

/** Motivos factuais da seção "Para acompanhar" (ordem seção 11) — cada um é
 *  um FATO objetivo, nunca uma recomendação pedagógica definitiva. */
export type AttentionReasonCode =
  | "revisao_vencida"
  | "sem_atividade_recente"
  | "meta_ativa_sem_evidencia_recente"
  | "caderno_pendente";

export const ATTENTION_REASON_LABELS: Record<AttentionReasonCode, string> = {
  revisao_vencida: "Há revisão vencida no Caderno de Erros.",
  sem_atividade_recente: `Sem atividade registrada nos últimos ${RECENT_ACTIVITY_WINDOW_DAYS} dias.`,
  meta_ativa_sem_evidencia_recente: "Meta semanal ativa sem evidência registrada até o momento.",
  caderno_pendente: "Há entrada pendente no Caderno de Erros.",
};

export interface StudentAttentionInput {
  hasRecentActivity: boolean;
  overdueReviewsCount: number;
  hasActiveWeeklyGoal: boolean;
  errorNotebookPendingCount: number;
}

/** Seção 11 da ordem — "Para acompanhar": só critérios factuais objetivos,
 *  nunca uma inferência sobre desempenho. Um aluno pode ter 0..N motivos;
 *  0 motivos significa que ele simplesmente não aparece nesta seção. */
export function deriveAttentionReasons(input: StudentAttentionInput): AttentionReasonCode[] {
  const reasons: AttentionReasonCode[] = [];
  if (input.overdueReviewsCount > 0) reasons.push("revisao_vencida");
  if (!input.hasRecentActivity) reasons.push("sem_atividade_recente");
  if (input.hasActiveWeeklyGoal && !input.hasRecentActivity) reasons.push("meta_ativa_sem_evidencia_recente");
  if (input.errorNotebookPendingCount > 0) reasons.push("caderno_pendente");
  return reasons;
}
