/* RBAC do Banco de Questões — Sprint 7 v1.0, seção 4.1 da ordem.

   `resolveEditorialRole` deriva o papel efetivo SEMPRE consultando o banco
   pelo user_id da sessão já validada — nunca a partir de qualquer campo
   enviado pelo cliente. `admin` herda tudo que `editor` pode fazer. Ausência
   de qualquer um dos dois papéis significa "sem acesso editorial": a rota
   traduz isso em 403 sem revelar nenhum conteúdo. */

import { listRoleNamesForUser } from "../repositories/roleRepository";

export type EditorialRole = "editor" | "admin" | null;

export async function resolveEditorialRole(db: D1Database, userId: string): Promise<EditorialRole> {
  const roleNames = await listRoleNamesForUser(db, userId);
  if (roleNames.includes("admin")) return "admin";
  if (roleNames.includes("editor")) return "editor";
  return null;
}

export function roleSatisfies(role: EditorialRole, minimum: "editor" | "admin"): boolean {
  if (role === null) return false;
  if (minimum === "editor") return role === "editor" || role === "admin";
  return role === "admin";
}

/* Sprint 14 v1.0, seção 8 da ordem — papel Professor/Mentor. REUTILIZA o
   mesmo mecanismo de RBAC do resto do projeto (roles/user_roles,
   migration 0008): 'teacher' já fazia parte do CHECK de roles.name desde a
   Sprint 7, só nunca tinha sido consultado até agora. Nenhum segundo campo
   de role, nenhuma tabela paralela, nenhuma string mágica fora daqui —
   exatamente o mesmo padrão de resolveEditorialRole acima. `admin`/`editor`
   NUNCA herdam acesso de professor por conveniência (ordem seção 8: "não
   ampliar permissões de editor/admin") — só quem tem a linha
   user_roles->roles.name='teacher' passa. */
export type TeacherRole = "teacher" | null;

export async function resolveTeacherRole(db: D1Database, userId: string): Promise<TeacherRole> {
  const roleNames = await listRoleNamesForUser(db, userId);
  return roleNames.includes("teacher") ? "teacher" : null;
}

/* Sprint 15 v1.0, seção 5/6 da ordem — RBAC da área administrativa. `admin`
   JÁ EXISTIA no CHECK de roles.name desde a migration 0008 (Sprint 7),
   sempre reservado para o topo do RBAC editorial (resolveEditorialRole
   acima já trata `admin` como superconjunto de `editor`), mas nunca antes
   consultado como um papel próprio e independente de área administrativa —
   exatamente a mesma situação de `teacher` até a Sprint 14. MESMO padrão:
   nenhuma tabela paralela, nenhum campo novo, só mais uma função
   `resolveXRole` que consulta user_roles/roles pelo `userId` da sessão já
   validada — NUNCA por qualquer campo enviado pelo cliente (ordem seção 5:
   "nunca aceitar role/adminId enviados pelo cliente como fonte de
   verdade"). Deliberadamente NÃO herda de editor/teacher nem é herdado por
   eles — um editor sem `admin` explícito não deve conseguir gerenciar
   usuários/papéis/vínculos, e um `admin` administrativo não precisa também
   ser `teacher` para gerenciar vínculos alheios (a área admin gerencia o
   vínculo dos OUTROS, nunca precisa "ser" professor). */
export type AdminRole = "admin" | null;

export async function resolveAdminRole(db: D1Database, userId: string): Promise<AdminRole> {
  const roleNames = await listRoleNamesForUser(db, userId);
  return roleNames.includes("admin") ? "admin" : null;
}
