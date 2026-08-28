import { generateOpaqueToken, hashPassword, needsRehash, sha256Hex, verifyPassword } from "../lib/crypto";
import { SESSION_TTL_SECONDS } from "../lib/cookies";
import {
  createUser,
  findUserByNormalizedEmail,
  findUserById,
  markEmailConfirmed,
  touchLastLogin,
  updatePasswordAndBumpSessionVersion,
  upgradePasswordHash,
  type UserRow,
} from "../repositories/userRepository";
import {
  createSession,
  findActiveSessionByTokenHash,
  revokeAllSessionsForUser,
  revokeSessionByTokenHash,
  touchSession,
} from "../repositories/sessionRepository";
import { findValidToken, issueToken, markTokenUsed } from "../repositories/tokenRepository";
import type { EmailAdapter } from "../email/adapter";

const EMAIL_CONFIRMATION_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 30; // 30min

function newId(): string {
  return crypto.randomUUID();
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
  const expiresAt = new Date(Date.now() + EMAIL_CONFIRMATION_TTL_MS).toISOString();

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

export async function confirmEmail(
  db: D1Database,
  token: string
): Promise<{ ok: boolean }> {
  const tokenHash = await sha256Hex(token);
  const row = await findValidToken(db, "email_confirmation", tokenHash);
  if (!row) return { ok: false };

  await markTokenUsed(db, "email_confirmation", row.id);
  await markEmailConfirmed(db, row.user_id);
  return { ok: true };
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
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

  await issueToken(db, "password_reset", { id: newId(), userId: user.id, tokenHash, expiresAt });

  const link = `${origin}/redefinir-senha?token=${token}`;
  await email.send({
    to: user.email,
    subject: "Redefinição de senha — Matemática Delicada",
    body: `Olá, ${user.name}! Redefina sua senha acessando: ${link} (válido por 30 minutos)`,
    kind: "password_reset",
  });
}

export async function resetPassword(
  db: D1Database,
  token: string,
  newPassword: string
): Promise<{ ok: boolean }> {
  const tokenHash = await sha256Hex(token);
  const row = await findValidToken(db, "password_reset", tokenHash);
  if (!row) return { ok: false };

  await markTokenUsed(db, "password_reset", row.id);
  const passwordHash = await hashPassword(newPassword);
  await updatePasswordAndBumpSessionVersion(db, row.user_id, passwordHash);
  await revokeAllSessionsForUser(db, row.user_id);
  return { ok: true };
}
