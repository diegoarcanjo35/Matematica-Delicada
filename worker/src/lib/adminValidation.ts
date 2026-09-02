/* Validação da área administrativa — Sprint 15 v1.0. Mesma convenção de
   questionsValidation.ts/scheduleValidation.ts: enums fechados e validação
   de parâmetro vivem só aqui; rotas/serviço só chamam estas funções.
   Reaproveita ALL_ROLES/isValidMutationId de questionsValidation.ts —
   nenhuma segunda lista de papéis, nenhum segundo protocolo de
   idempotência (ordem seção 6/15: "reutilizar RBAC/mutationId já
   existentes"). */

import { ALL_ROLES, isValidMutationId, type Role } from "./questionsValidation";
import { isValidEmail, normalizeEmail } from "./validation";

export { isValidMutationId };

export const ADMIN_USERS_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_USERS_MAX_PAGE_SIZE = 100;

export const ADMIN_USER_SORTS = ["nome_asc", "nome_desc", "criado_recente", "criado_antigo"] as const;
export type AdminUserSort = (typeof ADMIN_USER_SORTS)[number];
export const DEFAULT_ADMIN_USER_SORT: AdminUserSort = "nome_asc";

export function isAdminUserSort(value: string): value is AdminUserSort {
  return (ADMIN_USER_SORTS as readonly string[]).includes(value);
}

/** Papel válido para atribuição/remoção — o MESMO enum fechado do resto do
 *  projeto (migration 0008/questionsValidation.ts), nunca uma role
 *  arbitrária vinda do cliente (ordem seção 12, proteção 1). */
export function isAssignableRole(value: unknown): value is Role {
  return typeof value === "string" && (ALL_ROLES as readonly string[]).includes(value);
}

/** Filtro de papel na listagem — qualquer papel válido, OU o pseudo-valor
 *  "sem_papel" (usuário sem nenhuma linha em user_roles). Nunca aceito como
 *  papel atribuível — só como filtro de leitura. */
export function isValidRoleFilter(value: string): value is Role | "sem_papel" {
  return value === "sem_papel" || isAssignableRole(value);
}

const MAX_SEARCH_LENGTH = 200;

/** Sanitiza o termo de busca para uso em LIKE — escapa os coringas próprios
 *  do SQLite (`%`/`_`) para que um usuário buscando por um nome que
 *  contenha esses caracteres nunca vire um curinga acidental (nunca uma
 *  vulnerabilidade de injeção — os parâmetros continuam sempre bind()ados
 *  — só uma correção de comportamento de busca). */
export function sanitizeSearchTerm(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, MAX_SEARCH_LENGTH);
  if (trimmed.length === 0) return null;
  return trimmed.replace(/[%_]/g, (match) => `\\${match}`);
}

/** Identificador de conta-alvo do bootstrap (adendo seção G) — hoje só
 *  e-mail é aceito, por ser o único identificador estável e único já
 *  legítimo no modelo de usuário (users.email_normalized, UNIQUE desde a
 *  migration 0001). Nunca aceita um `userId` bruto (evitaria a checagem
 *  "conta já existe de fato pelo canal normal de cadastro" pedida pela
 *  seção F do adendo). */
export function validateBootstrapIdentifier(value: unknown): { ok: true; emailNormalized: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !isValidEmail(value)) {
    return { ok: false, error: "Identificador inválido — informe um e-mail válido." };
  }
  return { ok: true, emailNormalized: normalizeEmail(value) };
}

export interface AdminListUsersQuery {
  search: string | null;
  roleFilter: string | null;
  statusFilter: string | null;
  sort: AdminUserSort;
  page: number;
  pageSize: number;
}
