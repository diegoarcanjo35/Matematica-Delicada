/* Opções de UI do cronograma — espelham os vocabulários fechados do Worker
   (worker/src/lib/scheduleValidation.ts). A validação real é sempre a do
   Worker; isto só existe para rotular a interface. */

export const VIEW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "today", label: "Hoje" },
  { value: "week", label: "Semana" },
  { value: "month", label: "Mês" },
  { value: "pending", label: "Pendências" },
  { value: "reviews", label: "Revisões" },
  { value: "assigned", label: "Atribuídas" },
  { value: "history", label: "Histórico" },
];

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  diagnostico: "Diagnóstico",
  reconhecimento: "Reconhecimento",
  estudo_de_padrao: "Estudo de padrão",
  conteudo_de_base: "Conteúdo de base",
  aula_video: "Aula/vídeo",
  treino_de_questoes: "Treino de questões",
  correcao_de_erro: "Correção de erro",
  revisao_espacada: "Revisão espaçada",
  lista_do_professor: "Lista do professor",
  simulado: "Simulado",
  live: "Live",
  leitura_de_resumo: "Leitura de resumo",
};

// Motivos técnicos fechados de bloqueio (correção v1.1, seção 3) — nunca
// texto livre, nunca oferecido como ação ao aluno (sem botão "Bloquear"
// genérico); só usado para rotular um estado já bloqueado.
export const BLOCK_REASON_LABELS: Record<string, string> = {
  dependency_unavailable: "Pré-requisito técnico indisponível",
  content_unavailable: "Conteúdo ainda não disponível",
  technical_unavailable: "Recurso técnico indisponível no momento",
};

export const STATUS_LABELS: Record<string, string> = {
  not_started: "Não iniciada",
  in_progress: "Em andamento",
  completed: "Concluída",
  overdue: "Atrasada",
  rescheduled: "Reagendada",
  dismissed: "Dispensada",
  blocked: "Bloqueada",
};
