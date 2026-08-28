// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./crypto";

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

  it("usa o formato versionado com fator 600000", async () => {
    const hash = await hashPassword("qualquer-senha-123");
    const [version, iterations] = hash.split("$");
    expect(version).toBe("pbkdf2-sha256-v1");
    expect(iterations).toBe("600000");
  });

  it("continua compatível com um hash antigo de 100000 iterações", async () => {
    // Hash real, gerado com os parâmetros antigos (100.000 iterações) para a
    // senha "senha-antiga-100k", fixado aqui para provar compatibilidade
    // retroativa sem depender do valor atual de PBKDF2_ITERATIONS.
    const oldHash =
      "pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$" +
      (await (async () => {
        // deriva o hash real de 100k para o salt fixo acima, para o teste ser
        // determinístico sem hardcodar um valor de bit derivado manualmente
        const salt = new Uint8Array(16); // 16 bytes zero — corresponde ao base64url "AAAA...AA" acima
        const keyMaterial = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode("senha-antiga-100k"),
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
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      })());

    expect(await verifyPassword("senha-antiga-100k", oldHash)).toBe(true);
    expect(await verifyPassword("senha-errada", oldHash)).toBe(false);
  });

  it("needsRehash: verdadeiro para hash com iterações abaixo do atual", async () => {
    const oldFormatHash = "pbkdf2-sha256-v1$100000$c2FsdA$aGFzaA";
    expect(needsRehash(oldFormatHash)).toBe(true);
  });

  it("needsRehash: falso para hash já no fator atual (600000)", async () => {
    const currentHash = await hashPassword("qualquer-senha-123");
    expect(needsRehash(currentHash)).toBe(false);
  });

  it("needsRehash: verdadeiro para formato desconhecido/corrompido", () => {
    expect(needsRehash("formato-invalido")).toBe(true);
    expect(needsRehash("")).toBe(true);
  });

  it("rejeita entradas malformadas sem lançar exceção", async () => {
    await expect(verifyPassword("qualquer", "lixo-sem-formato")).resolves.toBe(false);
    await expect(verifyPassword("qualquer", "")).resolves.toBe(false);
  });
});
