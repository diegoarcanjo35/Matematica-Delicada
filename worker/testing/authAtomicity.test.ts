// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { generateOpaqueToken, hashPassword, sha256Hex, verifyPassword } from "../src/lib/crypto";
import { createUser, findUserById } from "../src/repositories/userRepository";
import { createSession, findActiveSessionByTokenHash } from "../src/repositories/sessionRepository";
import { issueToken } from "../src/repositories/tokenRepository";
import { confirmEmail, resetPassword } from "../src/services/authService";

/* Sprint 2 v1.3 — provas de atomicidade real (db.batch) para os três fluxos
   apontados na auditoria: emissão de token, consumo de token de confirmação
   de e-mail, consumo de token de redefinição de senha. Ver worker/testing/fakeD1.ts
   para a justificativa do seam usado (SQLite real embutido via node:sqlite,
   sem tocar o bundle de produção).

   Os testes de rollback checam o ESTADO DO BANCO depois da falha forçada —
   nunca só a resposta da função — conforme exigido pela ordem de correção. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
}

/* Mesmo formato de datetime('now') do SQLite/D1 ("YYYY-MM-DD HH:MM:SS") — a
   comparação `expires_at > datetime('now')` usada pelos guards é lexicográfica,
   então o valor de teste precisa estar no mesmo formato que a produção agora
   grava (ver toSqliteExpiry em worker/src/services/authService.ts). */
function toSqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function issueRawToken(
  kind: "email_confirmation" | "password_reset",
  userId: string,
  tokenId: string,
  expiresAt = toSqliteDatetime(new Date(Date.now() + 60_000))
): Promise<string> {
  const raw = generateOpaqueToken();
  const tokenHash = await sha256Hex(raw);
  await issueToken(db as never, kind, { id: tokenId, userId, tokenHash, expiresAt });
  return raw;
}

describe("confirmEmail — atomicidade do consumo do token de confirmação", () => {
  it("1. confirmação normal consome o token e confirma o e-mail", async () => {
    await seedUser("user-1");
    const raw = await issueRawToken("email_confirmation", "user-1", "token-1");

    const result = await confirmEmail(db as never, raw);

    expect(result.ok).toBe(true);
    const user = await findUserById(db as never, "user-1");
    expect(user?.email_confirmed_at).not.toBeNull();
    const tokenRow = db.sqlite
      .prepare("SELECT used_at FROM email_confirmation_tokens WHERE id = ?")
      .get("token-1") as { used_at: string | null };
    expect(tokenRow.used_at).not.toBeNull();
  });

  it("2. reutilização do token de confirmação falha", async () => {
    await seedUser("user-2");
    const raw = await issueRawToken("email_confirmation", "user-2", "token-2");

    const first = await confirmEmail(db as never, raw);
    const second = await confirmEmail(db as never, raw);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("3. duas confirmações concorrentes com o mesmo token resultam em exatamente um sucesso", async () => {
    await seedUser("user-3");
    const raw = await issueRawToken("email_confirmation", "user-3", "token-3");

    const [a, b] = await Promise.all([confirmEmail(db as never, raw), confirmEmail(db as never, raw)]);

    const successes = [a.ok, b.ok].filter(Boolean).length;
    expect(successes).toBe(1);
  });

  it("4. falha forçada na atualização do usuário reverte o consumo do token", async () => {
    await seedUser("user-4");
    const raw = await issueRawToken("email_confirmation", "user-4", "token-4");
    db.failNextMatching(/UPDATE users SET email_confirmed_at/);

    await expect(confirmEmail(db as never, raw)).rejects.toThrow("forced_failure_for_test");

    const user = await findUserById(db as never, "user-4");
    expect(user?.email_confirmed_at).toBeNull();
    const tokenRow = db.sqlite
      .prepare("SELECT used_at FROM email_confirmation_tokens WHERE id = ?")
      .get("token-4") as { used_at: string | null };
    expect(tokenRow.used_at).toBeNull();

    // Prova que o rollback realmente devolveu o token a um estado usável.
    const retry = await confirmEmail(db as never, raw);
    expect(retry.ok).toBe(true);
  });
});

describe("resetPassword — atomicidade do consumo do token de redefinição", () => {
  async function seedUserWithSession(id: string) {
    await seedUser(id);
    await createSession(db as never, {
      id: `${id}-session`,
      userId: id,
      tokenHash: await sha256Hex(`${id}-session-token`),
      sessionVersion: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      userAgent: null,
    });
    return sha256Hex(`${id}-session-token`);
  }

  it("5. redefinição normal consome token, troca senha, incrementa versão e revoga todas as sessões", async () => {
    const sessionTokenHash = await seedUserWithSession("user-5");
    const raw = await issueRawToken("password_reset", "user-5", "token-5");

    const result = await resetPassword(db as never, raw, "senha-nova-123456");

    expect(result.ok).toBe(true);
    const user = await findUserById(db as never, "user-5");
    expect(user?.session_version).toBe(2);
    expect(await verifyPassword("senha-nova-123456", user!.password_hash)).toBe(true);
    expect(await verifyPassword("senha-original-123", user!.password_hash)).toBe(false);
    const session = await findActiveSessionByTokenHash(db as never, sessionTokenHash);
    expect(session).toBeNull();
  });

  it("6. reutilização do token de reset falha", async () => {
    await seedUser("user-6");
    const raw = await issueRawToken("password_reset", "user-6", "token-6");

    const first = await resetPassword(db as never, raw, "senha-nova-123456");
    const second = await resetPassword(db as never, raw, "outra-senha-999999");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("7. duas redefinições concorrentes com o mesmo token resultam em exatamente um sucesso", async () => {
    await seedUser("user-7");
    const raw = await issueRawToken("password_reset", "user-7", "token-7");

    const [a, b] = await Promise.all([
      resetPassword(db as never, raw, "senha-concorrente-a11"),
      resetPassword(db as never, raw, "senha-concorrente-b22"),
    ]);

    const successes = [a.ok, b.ok].filter(Boolean).length;
    expect(successes).toBe(1);
  });

  it("8. falha forçada na troca de senha reverte o consumo do token e mantém senha/sessões anteriores", async () => {
    const sessionTokenHash = await seedUserWithSession("user-8");
    const raw = await issueRawToken("password_reset", "user-8", "token-8");
    db.failNextMatching(/UPDATE users SET password_hash/);

    await expect(resetPassword(db as never, raw, "senha-nova-123456")).rejects.toThrow(
      "forced_failure_for_test"
    );

    const user = await findUserById(db as never, "user-8");
    expect(user?.session_version).toBe(1);
    expect(await verifyPassword("senha-original-123", user!.password_hash)).toBe(true);
    const session = await findActiveSessionByTokenHash(db as never, sessionTokenHash);
    expect(session).not.toBeNull();
    const tokenRow = db.sqlite
      .prepare("SELECT used_at FROM password_reset_tokens WHERE id = ?")
      .get("token-8") as { used_at: string | null };
    expect(tokenRow.used_at).toBeNull();
  });

  it("9. falha forçada na revogação reverte consumo do token e a troca de senha", async () => {
    const sessionTokenHash = await seedUserWithSession("user-9");
    const raw = await issueRawToken("password_reset", "user-9", "token-9");
    db.failNextMatching(/UPDATE sessions SET revoked_at/);

    await expect(resetPassword(db as never, raw, "senha-nova-123456")).rejects.toThrow(
      "forced_failure_for_test"
    );

    const user = await findUserById(db as never, "user-9");
    // A troca de senha (statement anterior no mesmo lote) também foi revertida.
    expect(user?.session_version).toBe(1);
    expect(await verifyPassword("senha-original-123", user!.password_hash)).toBe(true);
    const session = await findActiveSessionByTokenHash(db as never, sessionTokenHash);
    expect(session).not.toBeNull();
    const tokenRow = db.sqlite
      .prepare("SELECT used_at FROM password_reset_tokens WHERE id = ?")
      .get("token-9") as { used_at: string | null };
    expect(tokenRow.used_at).toBeNull();
  });
});

describe("issueToken — atomicidade da emissão/substituição", () => {
  it("10. falha na inserção de novo token não invalida o token anterior", async () => {
    await seedUser("user-10");
    const rawA = await issueRawToken("email_confirmation", "user-10", "token-10-a");

    db.failNextMatching(/INSERT INTO email_confirmation_tokens/);
    const tokenHashB = await sha256Hex(generateOpaqueToken());
    await expect(
      issueToken(db as never, "email_confirmation", {
        id: "token-10-b",
        userId: "user-10",
        tokenHash: tokenHashB,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    ).rejects.toThrow();

    // Token anterior continua íntegro — a invalidação (statement 1 do batch) foi revertida.
    const result = await confirmEmail(db as never, rawA);
    expect(result.ok).toBe(true);
  });
});

describe("tokens expirados e inexistentes não alteram estado", () => {
  it("11. token expirado não altera usuário, senha ou sessões", async () => {
    const sessionTokenHash = await seedUserWithSessionHelper("user-11");
    const raw = await issueRawToken(
      "password_reset",
      "user-11",
      "token-11",
      toSqliteDatetime(new Date(Date.now() - 1_000)) // já expirado
    );

    const result = await resetPassword(db as never, raw, "senha-nova-123456");

    expect(result.ok).toBe(false);
    const user = await findUserById(db as never, "user-11");
    expect(user?.session_version).toBe(1);
    expect(await verifyPassword("senha-original-123", user!.password_hash)).toBe(true);
    const session = await findActiveSessionByTokenHash(db as never, sessionTokenHash);
    expect(session).not.toBeNull();
  });

  it("12. token inexistente não altera qualquer estado", async () => {
    await seedUser("user-12");

    const confirmResult = await confirmEmail(db as never, "token-que-nao-existe");
    const resetResult = await resetPassword(db as never, "token-que-tambem-nao-existe", "senha-nova-123456");

    expect(confirmResult.ok).toBe(false);
    expect(resetResult.ok).toBe(false);
    const user = await findUserById(db as never, "user-12");
    expect(user?.email_confirmed_at).toBeNull();
    expect(user?.session_version).toBe(1);
  });

  async function seedUserWithSessionHelper(id: string): Promise<string> {
    await seedUser(id);
    const sessionTokenHash = await sha256Hex(`${id}-session-token`);
    await createSession(db as never, {
      id: `${id}-session`,
      userId: id,
      tokenHash: sessionTokenHash,
      sessionVersion: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      userAgent: null,
    });
    return sessionTokenHash;
  }
});
