/* Rótulos e opções fixas da interface de padrões ENEM — Sprint 6 v1.0.
   Mesma convenção de src/pages/schedule/scheduleOptions.ts: só vocabulário
   técnico fechado (nunca conteúdo pedagógico, nunca quantidade fixa de
   padrões). As listas de conteúdo e de tag NÃO estão aqui de propósito —
   são derivadas dos padrões realmente publicados pela API, nunca de uma
   taxonomia inventada no frontend. */

export const PATTERN_SORT_OPTIONS = [
  { value: "codigo", label: "Código" },
  { value: "nome", label: "Nome" },
] as const;

export const PATTERN_EVIDENCE_OPTIONS = [
  { value: "todos", label: "Todos" },
  { value: "com_evidencia", label: "Com evidência registrada" },
  { value: "sem_evidencia", label: "Sem evidência ainda" },
] as const;

export const RELATION_TYPE_LABELS: Record<string, string> = {
  related: "Relacionado",
  prerequisite: "Pré-requisito",
  often_confused_with: "Frequentemente confundido com",
};

/** Copy única e literal para índice indisponível — usada em todos os lugares
 *  que mostram um dos três índices. NUNCA substituída por 0%, por traço ou
 *  por qualquer valor que sugira cálculo (seção 4.1/4.5 da ordem). */
export const INDEX_UNAVAILABLE_LABEL = "Ainda sem evidências suficientes";

export const PROVISIONAL_CONTENT_NOTICE =
  "CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR";
