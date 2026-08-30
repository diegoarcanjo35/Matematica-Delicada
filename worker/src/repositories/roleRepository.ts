/* Repositório de papéis (RBAC) — Sprint 7 v1.0, seção 4 da ordem.

   Consultas parametrizadas; nomes de tabela/coluna sempre literais fixos. O
   papel do usuário é SEMPRE derivado consultando este repositório a partir
   do `user_id` da sessão autenticada — nunca de um campo enviado pelo
   cliente. */

import type { Role } from "../lib/questionsValidation";

export interface RoleRow {
  id: string;
  name: string;
}

export async function findRoleByName(db: D1Database, name: Role): Promise<RoleRow | null> {
  const row = await db.prepare("SELECT * FROM roles WHERE name = ?").bind(name).first<RoleRow>();
  return row ?? null;
}

/** Todos os papéis (nomes) do usuário — nunca vazio significa "sem acesso
 *  editorial" na camada de cima; aqui é só leitura pura. */
export async function listRoleNamesForUser(db: D1Database, userId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT r.name as name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`
    )
    .bind(userId)
    .all<{ name: string }>();
  return (result.results ?? []).map((row) => row.name);
}

export async function userHasRole(db: D1Database, userId: string, roleName: Role): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 as found FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ? AND r.name = ? LIMIT 1`
    )
    .bind(userId, roleName)
    .first<{ found: number }>();
  return row !== null;
}

/** Idempotente: INSERT OR IGNORE numa linha determinística (roles.name é
 *  único) — reaplicar nunca duplica. Usado só pelo bootstrap local
 *  (gate isLocalEditorialFixturesAllowed) e pelos seeds de teste; nenhuma
 *  rota de produção normal chama isto fora do gate. */
export async function ensureRoleExists(db: D1Database, id: string, name: Role): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO roles (id, name) VALUES (?, ?)").bind(id, name).run();
}

/** Concede um papel a um usuário — idempotente via UNIQUE(user_id, role_id)
 *  + INSERT OR IGNORE (nunca duplica a mesma concessão). */
export async function grantRole(
  db: D1Database,
  params: { id: string; userId: string; roleId: string; grantedBy: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by) VALUES (?, ?, ?, ?)`
    )
    .bind(params.id, params.userId, params.roleId, params.grantedBy)
    .run();
}
