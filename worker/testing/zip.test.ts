// @vitest-environment node
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { isSafeZipEntryPath, normalizeZipPathForComparison, readZipSafely } from "../src/lib/zip";

/* Sprint 19, seção 8/19 da ordem — leitor de ZIP hardened. Fixtures geradas
   com `fflate.zipSync` (a mesma biblioteca escolhida para o leitor) —
   determinístico, sempre grava tamanho no cabeçalho local (nunca modo
   streaming/data-descriptor), o que é o caso comum e o que os testes de
   "declarado" cobrem; os testes de "real" (seção incremental) usam bytes
   compactáveis reais para provar que a contagem incremental por si só já
   protegeria mesmo se o cabeçalho mentisse. */

function textEntry(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("readZipSafely — leitura básica", () => {
  it("lê um ZIP simples com múltiplas entradas", async () => {
    const zip = zipSync({
      "questoes.csv": textEntry("codigo,enunciado\nQ1,Teste\n"),
      "manifest.json": textEntry('{"version":1,"questions":[]}'),
      "imagens/foto.png": textEntry("fake-png-bytes"),
    });
    const result = await readZipSafely(zip);
    expect(result.ok).toBe(true);
    const paths = result.entries!.map((e) => e.path).sort();
    expect(paths).toEqual(["imagens/foto.png", "manifest.json", "questoes.csv"]);
    const csvEntry = result.entries!.find((e) => e.path === "questoes.csv")!;
    expect(new TextDecoder().decode(csvEntry.bytes)).toBe("codigo,enunciado\nQ1,Teste\n");
  });

  it("entradas de diretório são ignoradas (nunca extraídas, mas contam no limite)", async () => {
    const zip = zipSync({ "imagens/": new Uint8Array(0), "imagens/foto.png": textEntry("x") });
    const result = await readZipSafely(zip);
    expect(result.ok).toBe(true);
    expect(result.entries!.map((e) => e.path)).toEqual(["imagens/foto.png"]);
  });

  it("ZIP vazio (0 bytes) é rejeitado", async () => {
    const result = await readZipSafely(new Uint8Array(0));
    expect(result.ok).toBe(false);
  });
});

describe("readZipSafely — limites de segurança (seção 8/19)", () => {
  it("ZIP comprimido acima do limite é rejeitado ANTES de qualquer parse", async () => {
    const zip = zipSync({ "a.txt": textEntry("x") });
    const result = await readZipSafely(zip, {
      maxCompressedBytes: zip.byteLength - 1,
      maxTotalUncompressedBytes: 1_000_000,
      maxEntries: 100,
      maxSingleFileBytes: 1_000_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/comprimidos/);
  });

  it("mais entradas que o limite abortam, sem extrair as demais", async () => {
    const zip = zipSync({ "a.txt": textEntry("1"), "b.txt": textEntry("2"), "c.txt": textEntry("3") });
    const result = await readZipSafely(zip, {
      maxCompressedBytes: 1_000_000,
      maxTotalUncompressedBytes: 1_000_000,
      maxEntries: 2,
      maxSingleFileBytes: 1_000_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/entradas/);
  });

  it("arquivo individual acima do limite (tamanho REAL, verificado durante a descompressão) aborta", async () => {
    const big = new Uint8Array(2000).fill(65); // conteúdo repetitivo comprime bem — prova que a checagem é sobre o tamanho REAL entregue, não o comprimido.
    const zip = zipSync({ "big.bin": big });
    const result = await readZipSafely(zip, {
      maxCompressedBytes: 1_000_000,
      maxTotalUncompressedBytes: 1_000_000,
      maxEntries: 100,
      maxSingleFileBytes: 500,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limite individual/);
  });

  it("total descomprimido acima do limite (zip bomb) aborta sem terminar a extração", async () => {
    const a = new Uint8Array(400).fill(1);
    const b = new Uint8Array(400).fill(2);
    const zip = zipSync({ "a.bin": a, "b.bin": b });
    const result = await readZipSafely(zip, {
      maxCompressedBytes: 1_000_000,
      maxTotalUncompressedBytes: 600, // menor que a soma (800), maior que um só arquivo (400).
      maxEntries: 100,
      maxSingleFileBytes: 1_000_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/total descomprimido/);
  });

  it("dentro de todos os limites: aceito normalmente", async () => {
    const zip = zipSync({ "a.bin": new Uint8Array(100).fill(9) });
    const result = await readZipSafely(zip, {
      maxCompressedBytes: 1_000_000,
      maxTotalUncompressedBytes: 1_000_000,
      maxEntries: 100,
      maxSingleFileBytes: 1_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.entries![0].bytes.length).toBe(100);
  });
});

describe("isSafeZipEntryPath — segurança de path (seção 7/8)", () => {
  it("aceita caminhos normais dentro do namespace", () => {
    expect(isSafeZipEntryPath("questoes.csv")).toBe(true);
    expect(isSafeZipEntryPath("manifest.json")).toBe(true);
    expect(isSafeZipEntryPath("imagens/grafico.png")).toBe(true);
    expect(isSafeZipEntryPath("imagens/sub/opcao-c.png")).toBe(true);
  });

  it("rejeita path traversal em qualquer profundidade", () => {
    expect(isSafeZipEntryPath("../etc/passwd")).toBe(false);
    expect(isSafeZipEntryPath("imagens/../../../etc/passwd")).toBe(false);
    expect(isSafeZipEntryPath("imagens/../secreto.png")).toBe(false);
  });

  it("rejeita caminho absoluto", () => {
    expect(isSafeZipEntryPath("/etc/passwd")).toBe(false);
  });

  it("rejeita drive letter (Windows)", () => {
    expect(isSafeZipEntryPath("C:/Windows/system32")).toBe(false);
    expect(isSafeZipEntryPath("D:evil.png")).toBe(false);
  });

  it("rejeita backslash (namespace único, sempre '/')", () => {
    expect(isSafeZipEntryPath("imagens\\foto.png")).toBe(false);
  });

  it("rejeita segmentos vazios/ambíguos", () => {
    expect(isSafeZipEntryPath("imagens//foto.png")).toBe(false);
    expect(isSafeZipEntryPath("imagens/./foto.png")).toBe(false);
  });
});

describe("normalizeZipPathForComparison — colisão case-fold", () => {
  it("dois nomes que só diferem em maiúsculas/minúsculas normalizam igual", () => {
    expect(normalizeZipPathForComparison("Imagens/Foto.PNG")).toBe(normalizeZipPathForComparison("imagens/foto.png"));
  });
});
