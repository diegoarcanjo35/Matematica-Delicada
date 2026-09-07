// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Zip, ZipPassThrough, zipSync } from "fflate";
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

/** `zipSync({...})` recebe um objeto JS comum — impossível ter duas chaves
 *  idênticas (ou só diferindo em maiúsculas/minúsculas seria PERMITIDO pelo
 *  JS, mas exatamente iguais nunca). Para fabricar um ZIP com entradas
 *  fisicamente duplicadas (o cenário real que a correção 19.1 precisa
 *  bloquear), usamos a API de escrita EM STREAMING (`Zip`/`ZipPassThrough`),
 *  que permite `.add()` duas vezes com o MESMO nome — o formato ZIP em si
 *  não proíbe isso, só o objeto JS de `zipSync` proibiria por acidente. */
async function buildRawZipWithEntries(entries: Array<{ name: string; data: Uint8Array }>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      if (chunk) chunks.push(chunk);
      if (final) {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        resolve(merged);
      }
    });
    for (const entry of entries) {
      const file = new ZipPassThrough(entry.name);
      zip.add(file);
      file.push(entry.data, true);
    }
    zip.end();
  });
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

/* Sprint 19.1, correção 2 — duplicidade FÍSICA de entradas no ZIP nunca
   pode ser resolvida silenciosamente por um Map/objeto que aceitaria só a
   última ocorrência. Toda entrada real é checada, inclusive
   questoes.csv/manifest.json — nunca só imagens/. */
describe("readZipSafely — duplicidade física de entradas (correção 19.1, seção 2)", () => {
  it("item 1 — duas entradas EXATAMENTE iguais bloqueiam o pacote inteiro", async () => {
    const zip = await buildRawZipWithEntries([
      { name: "imagens/a.png", data: textEntry("primeira") },
      { name: "imagens/a.png", data: textEntry("segunda") },
    ]);
    const result = await readZipSafely(zip);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicada/);
  });

  it("item 2 — 'imagens/a.png' + 'imagens/A.PNG' (só case diferente) bloqueia", async () => {
    const zip = await buildRawZipWithEntries([
      { name: "imagens/a.png", data: textEntry("primeira") },
      { name: "imagens/A.PNG", data: textEntry("segunda") },
    ]);
    const result = await readZipSafely(zip);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicada/);
  });

  it("item 3 — dois 'questoes.csv' bloqueiam (não é exclusivo de imagens/)", async () => {
    const zip = await buildRawZipWithEntries([
      { name: "questoes.csv", data: textEntry("codigo\nA\n") },
      { name: "questoes.csv", data: textEntry("codigo\nB\n") },
      { name: "manifest.json", data: textEntry('{"version":1,"questions":[]}') },
    ]);
    const result = await readZipSafely(zip);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicada/);
  });

  it("item 5 — ZIP normal (sem duplicidade) continua funcionando", async () => {
    const zip = await buildRawZipWithEntries([
      { name: "questoes.csv", data: textEntry("codigo\nA\n") },
      { name: "manifest.json", data: textEntry('{"version":1,"questions":[]}') },
      { name: "imagens/a.png", data: textEntry("conteudo-a") },
      { name: "imagens/b.png", data: textEntry("conteudo-b") },
    ]);
    const result = await readZipSafely(zip);
    expect(result.ok).toBe(true);
    expect(result.entries!.map((e) => e.path).sort()).toEqual(["imagens/a.png", "imagens/b.png", "manifest.json", "questoes.csv"]);
  });
});
