/* Validação e constantes técnicas do catálogo de padrões ENEM — Sprint 6
   v1.0. Mesma convenção de worker/src/lib/scheduleValidation.ts e
   diagnosticValidation.ts: enums fechados e validação de parâmetro vivem só
   aqui; rotas/serviço apenas chamam estas funções. Nenhuma regra pedagógica
   (as fórmulas dos três índices continuam pendentes — seção 3 da ordem). */

/** Status editorial técnico fechado (seção 4.1 da ordem). Só `published` é
 *  exposto ao aluno — nunca `draft`/`in_review`/`changes_requested`/
 *  `approved`/`archived`. */
export const PATTERN_EDITORIAL_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "published",
  "archived",
] as const;
export type PatternEditorialStatus = (typeof PATTERN_EDITORIAL_STATUSES)[number];

/** Único status visível ao aluno nesta sprint. */
export const STUDENT_VISIBLE_EDITORIAL_STATUS: PatternEditorialStatus = "published";

/** Enum fechado da tabela genérica de atributos multivalorados
 *  (migration 0007, `pattern_attributes.attribute_type`). Decisão de
 *  modelagem justificada em docs/PADROES_ENEM.md. */
export const PATTERN_ATTRIBUTE_TYPES = [
  "frequent_clue",
  "recurring_phrase",
  "recurring_visual_element",
  "alternative_strategy",
  "required_content",
  "prerequisite_content",
  "common_mistake",
  "tag",
] as const;
export type PatternAttributeType = (typeof PATTERN_ATTRIBUTE_TYPES)[number];

export const PATTERN_RELATION_TYPES = ["related", "prerequisite", "often_confused_with"] as const;
export type PatternRelationType = (typeof PATTERN_RELATION_TYPES)[number];

/** Filtro por disponibilidade de evidência (seção 4.3 da ordem). Como as
 *  fórmulas dos três índices estão pendentes, "com evidência" significa
 *  apenas que EXISTE uma linha de progresso deste aluno com pelo menos um
 *  índice não nulo — nunca um valor calculado por nós. */
export const PATTERN_EVIDENCE_FILTERS = ["todos", "com_evidencia", "sem_evidencia"] as const;
export type PatternEvidenceFilter = (typeof PATTERN_EVIDENCE_FILTERS)[number];

/** Ordenações determinísticas suportadas. Toda ordenação termina com
 *  desempate por `code` e por `id` no repositório — nunca ordem de inserção. */
export const PATTERN_SORTS = ["codigo", "nome"] as const;
export type PatternSort = (typeof PATTERN_SORTS)[number];

export const PATTERNS_DEFAULT_LIMIT = 6;
export const PATTERNS_MAX_LIMIT = 50;
export const PATTERNS_MAX_SEARCH_LENGTH = 120;
export const PATTERNS_MAX_FILTER_LENGTH = 120;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PATTERN_SLUG_MAX_LENGTH = 80;

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

/** Formato de slug aceito: minúsculas, dígitos e hífens simples, sem hífen
 *  no início/fim e sem hífens consecutivos. Um slug malformado nunca chega a
 *  virar consulta — a rota responde 404 (mesma resposta de "não existe" e de
 *  "não publicado", para não vazar a existência de rascunho editorial). */
export function isValidPatternSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PATTERN_SLUG_MAX_LENGTH &&
    SLUG_RE.test(value)
  );
}

/** Busca textual opcional. String vazia/só espaços equivale a "sem busca"
 *  (nunca vira `LIKE '%%'` desnecessário). */
export function validatePatternSearch(value: string | null): FieldValidationResult<string | null> {
  if (value === null) return ok(null);
  if (typeof value !== "string") return fail("Busca inválida.");
  if (value.length > PATTERNS_MAX_SEARCH_LENGTH) {
    return fail(`A busca não pode passar de ${PATTERNS_MAX_SEARCH_LENGTH} caracteres.`);
  }
  const trimmed = value.trim();
  return ok(trimmed === "" ? null : trimmed);
}

/** Filtro por conteúdo matemático ou por tag — valor livre curto, sempre
 *  comparado por statement parametrizado (nunca concatenado no SQL). */
export function validatePatternTextFilter(
  value: string | null,
  fieldLabel: string
): FieldValidationResult<string | null> {
  if (value === null) return ok(null);
  if (typeof value !== "string") return fail(`${fieldLabel} inválido.`);
  if (value.length > PATTERNS_MAX_FILTER_LENGTH) {
    return fail(`${fieldLabel} não pode passar de ${PATTERNS_MAX_FILTER_LENGTH} caracteres.`);
  }
  const trimmed = value.trim();
  return ok(trimmed === "" ? null : trimmed);
}

export function validatePatternEvidenceFilter(
  value: string | null
): FieldValidationResult<PatternEvidenceFilter> {
  if (value === null || value === "") return ok("todos");
  if (!(PATTERN_EVIDENCE_FILTERS as readonly string[]).includes(value)) {
    return fail("Filtro de evidência inválido.");
  }
  return ok(value as PatternEvidenceFilter);
}

export function validatePatternSort(value: string | null): FieldValidationResult<PatternSort> {
  if (value === null || value === "") return ok("codigo");
  if (!(PATTERN_SORTS as readonly string[]).includes(value)) {
    return fail("Ordenação inválida.");
  }
  return ok(value as PatternSort);
}

/** Limite de página com teto validado no Worker (seção 4.3 da ordem):
 *  ausente → padrão; não inteiro, < 1 ou > PATTERNS_MAX_LIMIT → 400. Nunca
 *  "satura" silenciosamente no teto — um limite inválido é rejeitado. */
export function validatePatternLimit(value: string | null): FieldValidationResult<number> {
  if (value === null || value === "") return ok(PATTERNS_DEFAULT_LIMIT);
  if (!/^\d+$/.test(value)) return fail("Limite inválido.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > PATTERNS_MAX_LIMIT) {
    return fail(`O limite precisa ser um inteiro entre 1 e ${PATTERNS_MAX_LIMIT}.`);
  }
  return ok(parsed);
}

/** Página 1-based. Ausente → 1; não inteiro ou < 1 → 400. */
export function validatePatternPage(value: string | null): FieldValidationResult<number> {
  if (value === null || value === "") return ok(1);
  if (!/^\d+$/.test(value)) return fail("Página inválida.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fail("A página precisa ser um inteiro maior ou igual a 1.");
  return ok(parsed);
}
