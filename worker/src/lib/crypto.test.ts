// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./crypto";
import { FakeD1Database } from "../../testing/fakeD1";
import { NoProviderEmailAdapter } from "../email/devOutboxAdapter";
import { login, signup } from "../services/authService";

describe("hashPassword / verifyPassword", () => {
  it("aceita a senha correta", async () => {
    const hash = await hashPassword("senha-correta-123");
    expect(await verifyPassword("senha-correta-123", hash)).toBe(true);
  });

  it("rejeita a senha incorreta", async () => {
    const hash = await hashPassword("senha-correta-123");
    expect(await verifyPassword("senha-errada-456", hash)).toBe(false);
  });

  it("gera salts diferentes para a mesma senha, e ambos os hashes verificam", async () => {
    const hashA = await hashPassword("mesma-senha-123");
    const hashB = await hashPassword("mesma-senha-123");

    expect(hashA).not.toBe(hashB);
    expect(await verifyPassword("mesma-senha-123", hashA)).toBe(true);
    expect(await verifyPassword("mesma-senha-123", hashB)).toBe(true);
  });

  // Item 1 (ordem de correção, seção 8) — geração de hash com o fator real
  // suportado pelo runtime Workers em produção (100.000 — ver crypto.ts para
  // o histórico completo de por que 600.000 nunca funcionou de verdade).
  it("usa o formato versionado com fator 100000 (limite real do runtime Workers)", async () => {
    const hash = await hashPassword("qualquer-senha-123");
    const [version, iterations] = hash.split("$");
    expect(version).toBe("pbkdf2-sha256-v1");
    expect(iterations).toBe("100000");
  });

  it("continua compatível com um hash mais antigo, gerado com um fator menor (50000)", async () => {
    // Hash real, gerado com um fator DELIBERADAMENTE menor que o atual
    // (50.000) para o salt fixo abaixo, provando que verifyPassword usa as
    // iterações do PRÓPRIO hash armazenado — nunca a constante atual — sem
    // depender de hardcodar um valor de bit derivado manualmente.
    const salt = new Uint8Array(16); // 16 bytes zero — corresponde ao base64url "AAAA...AA" abaixo
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("senha-antiga-50k"),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 50_000, hash: "SHA-256" },
      keyMaterial,
      256
    );
    let binary = "";
    for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);
    const hashB64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const oldHash = `pbkdf2-sha256-v1$50000$AAAAAAAAAAAAAAAAAAAAAA$${hashB64}`;

    expect(await verifyPassword("senha-antiga-50k", oldHash)).toBe(true);
    expect(await verifyPassword("senha-errada", oldHash)).toBe(false);
    // Fator abaixo do atual (100.000) — upgrade oportunista deveria disparar.
    expect(needsRehash(oldHash)).toBe(true);
  });

  it("needsRehash: verdadeiro para hash com iterações abaixo do atual", async () => {
    const oldFormatHash = "pbkdf2-sha256-v1$50000$c2FsdA$aGFzaA";
    expect(needsRehash(oldFormatHash)).toBe(true);
  });

  it("needsRehash: falso para hash já no fator atual (100000)", async () => {
    const currentHash = await hashPassword("qualquer-senha-123");
    expect(needsRehash(currentHash)).toBe(false);
  });

  it("needsRehash: verdadeiro para formato desconhecido/corrompido", () => {
    expect(needsRehash("formato-invalido")).toBe(true);
    expect(needsRehash("")).toBe(true);
  });

  // Item 5/6 (ordem de correção, seção 8) — hash malformado e iteration
  // count inválido nunca lançam exceção; sempre tratados como credencial
  // inválida (nunca um 500 genérico via o catch global do Worker).
  it("rejeita entradas malformadas sem lançar exceção", async () => {
    await expect(verifyPassword("qualquer", "lixo-sem-formato")).resolves.toBe(false);
    await expect(verifyPassword("qualquer", "")).resolves.toBe(false);
  });

  it("rejeita hash com base64 inválido no salt/hash sem lançar exceção", async () => {
    await expect(
      verifyPassword("qualquer", "pbkdf2-sha256-v1$100000$***não-é-base64***$***também-não***")
    ).resolves.toBe(false);
  });

  it("rejeita iteration count inválido (zero, negativo, não-inteiro, NaN) sem lançar exceção", async () => {
    await expect(verifyPassword("qualquer", "pbkdf2-sha256-v1$0$c2FsdA$aGFzaA")).resolves.toBe(false);
    await expect(verifyPassword("qualquer", "pbkdf2-sha256-v1$-100$c2FsdA$aGFzaA")).resolves.toBe(false);
    await expect(verifyPassword("qualquer", "pbkdf2-sha256-v1$12.5$c2FsdA$aGFzaA")).resolves.toBe(false);
    await expect(verifyPassword("qualquer", "pbkdf2-sha256-v1$nao-e-numero$c2FsdA$aGFzaA")).resolves.toBe(
      false
    );
  });

  // Item 7 (ordem de correção, seção 8) — um hash que reivindique MAIS
  // iterações do que o runtime Workers consegue executar (>100.000, ex. um
  // resíduo do valor antigo de 600.000, ou um valor malicioso/corrompido)
  // precisa ser rejeitado de forma previsível e controlada — nunca deixar
  // verifyPassword tentar rodar deriveBits com esse valor (é exatamente isso
  // que lançava NotSupportedError e virava "Erro interno" em produção).
  it("rejeita hash com iteration count acima do limite suportado (>100000) sem lançar exceção", async () => {
    await expect(
      verifyPassword("qualquer", "pbkdf2-sha256-v1$600000$c2FsdA$aGFzaA")
    ).resolves.toBe(false);
    await expect(
      verifyPassword("qualquer", "pbkdf2-sha256-v1$100001$c2FsdA$aGFzaA")
    ).resolves.toBe(false);
  });

  it("aceita exatamente o limite suportado (100000) quando o hash é válido", async () => {
    const salt = new Uint8Array(16);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("senha-no-limite"),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      keyMaterial,
      256
    );
    let binary = "";
    for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);
    const hashB64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hashAtLimit = `pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$${hashB64}`;

    expect(await verifyPassword("senha-no-limite", hashAtLimit)).toBe(true);
  });
});

describe("cadastro e login locais usando o crypto real (FakeD1)", () => {
  // Item 8 (ordem de correção, seção 8) — cadastro completo local usando o
  // crypto real: exercita signup() de ponta a ponta (hashPassword real,
  // persistência real via FakeD1) para provar que o fluxo inteiro funciona
  // com o novo fator de 100.000 iterações.
  it("cadastro completo grava o usuário com um hash pbkdf2-sha256-v1 de 100000 iterações", async () => {
    const db = new FakeD1Database();
    const email = new NoProviderEmailAdapter();

    const result = await signup(db as never, email, {
      name: "Usuário de Teste",
      email: "usuario.teste@exemplo.com",
      password: "senha-de-teste-123",
      origin: "http://localhost:8793",
    });

    expect(result.ok).toBe(true);
    expect(result.user).toBeDefined();
    const [, iterations] = (result.user!.password_hash as string).split("$");
    expect(iterations).toBe("100000");
  });

  // Item 9 (ordem de correção, seção 8) — login usando o hash gerado pelo
  // próprio cadastro real (nunca um hash fabricado à mão para o teste).
  it("login aceita a senha correta contra o hash gerado pelo cadastro real, e rejeita a errada", async () => {
    const db = new FakeD1Database();
    const email = new NoProviderEmailAdapter();

    await signup(db as never, email, {
      name: "Usuário de Login",
      email: "login.teste@exemplo.com",
      password: "senha-correta-do-login",
      origin: "http://localhost:8793",
    });

    const ok = await login(db as never, {
      email: "login.teste@exemplo.com",
      password: "senha-correta-do-login",
      userAgent: "vitest",
    });
    expect(ok.ok).toBe(true);
    expect(ok.sessionToken).toBeDefined();

    const wrong = await login(db as never, {
      email: "login.teste@exemplo.com",
      password: "senha-errada-no-login",
      userAgent: "vitest",
    });
    expect(wrong.ok).toBe(false);
  });
});
