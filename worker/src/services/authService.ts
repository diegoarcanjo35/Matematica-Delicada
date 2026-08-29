import { generateOpaqueToken, hashPassword, needsRehash, sha256Hex, verifyPassword } from "../lib/crypto";
import { SESSION_TTL_SECONDS } from "../lib/cookies";
import {
  buildConfirmEmailStatement,
  buildUpdatePasswordAndBumpSessionVersionStatement,
  createUser,
  findUserByNormalizedEmail,
  findUserById,
  touchLastLogin,
  upgradePasswordHash,
  type UserRow,
} from "../repositories/userRepository";
import {
  buildRevokeAllSessionsForUserStatement,
  createSession,
  findActiveSessionByTokenHash,
  revokeSessionByTokenHash,
  touchSession,
} from "../repositories/sessionRepository";
import {
  buildConsumeTokenStatement,
  findValidToken,
  issueToken,
  tokenStillValidGuardSql,
} from "../repositories/tokenRepository";
import type { EmailAdapter } from "../email/adapter";

const EMAIL_CONFIRMATION_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 30; // 30min

function newId(): string {
  return crypto.randomUUID();
}

/** Formata para o mesmo formato de datetime('now') do SQLite/D1
 *  ("YYYY-MM-DD HH:MM:SS", sem "T"/"Z"/milissegundos) — comparação
 *  lexicográfica com toISOString() bruto é incorreta (mesmo bug já corrigido
 *  em rateLimit.ts; aqui afetava a expiração real dos tokens de confirmação
 *  de e-mail e redefinição de senha, encontrado pelos testes de atomicidade
 *  da Sprint 2 v1.3, item 11: "token expirado não altera... "). */
function toSqliteExpiry(msFromNow: number): string {
  return new Date(Date.now() + msFromNow)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

export interface SignupResult {
  ok: boolean;
  reason?: "email_in_use";
  user?: UserRow;
}

export async function signup(
  db: D1Database,
  email: EmailAdapter,
  params: { name: string; email: string; password: string; origin: string }
): Promise<SignupResult> {
  const emailNormalized = params.email.trim().toLowerCase();
  const existing = await findUserByNormalizedEmail(db, emailNormalized);
  if (existing) return { ok: false, reason: "email_in_use" };

  const id = newId();
  const passwordHash = await hashPassword(params.password);
  await createUser(db, {
    id,
    name: params.name,
    email: params.email,
    emailNormalized,
    passwordHash,
  });

  await requestEmailConfirmation(db, email, emailNormalized, params.origin);

  const user = await findUserById(db, id);
  return { ok: true, user: user ?? undefined };
}

export interface LoginResult {
  ok: boolean;
  user?: UserRow;
  sessionToken?: string;
}

export async function login(
  db: D1Database,
  params: { email: string; password: string; userAgent: string | null }
): Promise<LoginResult> {
  const emailNormalized = params.email.trim().toLowerCase();
  const user = await findUserByNormalizedEmail(db, emailNormalized);
  if (!user) return { ok: false };

  const passwordOk = await verifyPassword(params.password, user.password_hash);
  if (!passwordOk) return { ok: false };

  // Upgrade oportunista: só depois de comprovar a senha correta, nunca em login
  // inválido. Não bump de session_version — o segredo não mudou.
  if (needsRehash(user.password_hash)) {
    const upgradedHash = await hashPassword(params.password);
    await upgradePasswordHash(db, user.id, upgradedHash);
  }

  const sessionToken = generateOpaqueToken();
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  await createSession(db, {
    id: newId(),
    userId: user.id,
    tokenHash,
    sessionVersion: user.session_version,
    expiresAt,
    userAgent: params.userAgent,
  });
  await touchLastLogin(db, user.id);

  return { ok: true, user, sessionToken };
}

export interface SessionCheckResult {
  ok: boolean;
  user?: UserRow;
}

/** Valida a sessão no servidor — nunca confia em estado do cliente. */
export async function checkSession(db: D1Database, sessionToken: string): Promise<SessionCheckResult> {
  const tokenHash = await sha256Hex(sessionToken);
  const session = await findActiveSessionByTokenHash(db, tokenHash);
  if (!session) return { ok: false };

  const user = await findUserById(db, session.user_id);
  if (!user) return { ok: false };

  // Sessão emitida antes da versão atual (ex.: senha trocada depois) — inválida.
  if (session.session_version !== user.session_version) return { ok: false };

  await touchSession(db, session.id);
  return { ok: true, user };
}

export async function logout(db: D1Database, sessionToken: string): Promise<void> {
  const tokenHash = await sha256Hex(sessionToken);
  await revokeSessionByTokenHash(db, tokenHash);
}

export async function requestEmailConfirmation(
  db: D1Database,
  email: EmailAdapter,
  emailNormalized: string,
  origin: string
): Promise<void> {
  const user = await findUserByNormalizedEmail(db, emailNormalized);
  // Resposta ao chamador é sempre genérica — não revela se o e-mail existe.
  if (!user || user.email_confirmed_at) return;

  const token = generateOpaqueToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = toSqliteExpiry(EMAIL_CONFIRMATION_TTL_MS);

  await issueToken(db, "email_confirmation", {
    id: newId(),
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const link = `${origin}/confirmar-email?token=${token}`;
  await email.send({
    to: user.email,
    subject: "Confirme seu e-mail — Matemática Delicada",
    body: `Olá, ${user.name}! Confirme seu e-mail acessando: ${link}`,
    kind: "email_confirmation",
  });
}

/** Confirmação de e-mail — consumo do token e confirmação do e-mail ocorrem
 *  no mesmo lote atômico do D1 (Sprint 2 v1.3, correção 3.2). A leitura
 *  inicial (findValidToken) só localiza o candidato; a validade real, dentro
 *  da transação, é revalidada pelo guard SQL nos dois statements do lote —
 *  por isso a corrida entre duas requisições concorrentes com o mesmo token
 *  é resolvida pelo D1, não pela leitura inicial (TOCTOU-safe). */
export async function confirmEmail(
  db: D1Database,
  token: string
): Promise<{ ok: boolean }> {
  const tokenHash = await sha256Hex(token);
  const row = await findValidToken(db, "email_confirmation", tokenHash);
  if (!row) return { ok: false };

  const guardSql = tokenStillValidGuardSql("email_confirmation");
  const results = await db.batch([
    buildConfirmEmailStatement(db, row.user_id, guardSql, [row.id, row.user_id]),
    buildConsumeTokenStatement(db, "email_confirmation", row.id, row.user_id),
  ]);

  const userUpdated = results[0]?.meta.changes === 1;
  const tokenConsumed = results[1]?.meta.changes === 1;
  // Ambos precisam ter afetado exatamente 1 linha — não basta a ausência de
  // exceção (Sprint 2 v1.3, correção 3.4). Se divergirem, algo inesperado
  // aconteceu no guard e o resultado é tratado como falha, nunca como sucesso parcial.
  return { ok: userUpdated && tokenConsumed };
}

export async function requestPasswordReset(
  db: D1Database,
  email: EmailAdapter,
  emailInput: string,
  origin: string
): Promise<void> {
  const emailNormalized = emailInput.trim().toLowerCase();
  const user = await findUserByNormalizedEmail(db, emailNormalized);
  // Resposta ao chamador é sempre genérica — não enumera usuários existentes.
  if (!user) return;

  const token = generateOpaqueToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = toSqliteExpiry(PASSWORD_RESET_TTL_MS);

  await issueToken(db, "password_reset", { id: newId(), userId: user.id, tokenHash, expiresAt });

  const link = `${origin}/redefinir-senha?token=${token}`;
  await email.send({
    to: user.email,
    subject: "Redefinição de senha — Matemática Delicada",
    body: `Olá, ${user.name}! Redefina sua senha acessando: ${link} (válido por 30 minutos)`,
    kind: "password_reset",
  });
}

/** Redefinição de senha — consumo do token, troca de senha (com bump de
 *  session_version) e revogação de todas as sessões ocorrem no mesmo lote
 *  atômico do D1 (Sprint 2 v1.3, correção 3.3): se qualquer statement
 *  falhar, nenhuma alteração parcial persiste. O hash da nova senha é
 *  calculado ANTES do lote (é CPU pura, não toca o banco) para que o lote em
 *  si seja só I/O e permaneça rápido. */
export async function resetPassword(
  db: D1Database,
  token: string,
  newPassword: string
): Promise<{ ok: boolean }> {
  const tokenHash = await sha256Hex(token);
  const row = await findValidToken(db, "password_reset", tokenHash);
  if (!row) return { ok: false };

  const passwordHash = await hashPassword(newPassword);
  const guardSql = tokenStillValidGuardSql("password_reset");
  const guardParams: [string, string] = [row.id, row.user_id];

  const results = await db.batch([
    buildUpdatePasswordAndBumpSessionVersionStatement(db, row.user_id, passwordHash, guardSql, guardParams),
    buildRevokeAllSessionsForUserStatement(db, row.user_id, guardSql, guardParams),
    buildConsumeTokenStatement(db, "password_reset", row.id, row.user_id),
  ]);

  const passwordUpdated = results[0]?.meta.changes === 1;
  const tokenConsumed = results[2]?.meta.changes === 1;
  // A revogação de sessões (results[1]) pode legitimamente afetar 0 linhas —
  // usuário sem sessão ativa não é falha. Só senha e token são obrigatórios.
  return { ok: passwordUpdated && tokenConsumed };
}
