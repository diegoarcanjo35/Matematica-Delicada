// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { Zip, ZipPassThrough, zipSync } from "fflate";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { previewPackage, applyPackage, plannedD1StatementCount, IMPORT_BATCH_MAX_D1_STATEMENTS } from "../src/services/questionPackageImportService";
import { undoImport } from "../src/services/questionImportService";
import { IMPORT_CSV_V2_HEADERS } from "../src/lib/questionImportV2";
import { IMPORT_BATCH_PAYLOAD_MAX_BYTES, measureUtf8Bytes, isPayloadWithinBatchLimit } from "../src/lib/importBatchLimits";

/* Sprint 19, seções 5-15/19 da ordem — pipeline completo do Pacote ZIP
   (CSV V2 + imagens + manifest). Fixtures geradas com `fflate.zipSync`
   (mesma biblioteca escolhida para o leitor real) — determinístico, sempre
   grava tamanho no cabeçalho local. Mesmo padrão de harness das demais
   suítes desta sprint (FakeD1Database real, FakeR2Bucket em memória). */

let db: FakeD1Database;
let bucket: FakeR2Bucket;

beforeEach(async () => {
  db = new FakeD1Database();
  bucket = new FakeR2Bucket();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-escala', 'Escala e Proporção', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
  await createUser(db as never, { id: "editor1", name: "Editora Teste", email: "editor1@teste.dev", emailNormalized: "editor1@teste.dev", passwordHash: "hash" });
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
function webpBytes(): Uint8Array {
  const b = new Uint8Array(16);
  "RIFF".split("").forEach((c, i) => (b[i] = c.charCodeAt(0)));
  "WEBP".split("").forEach((c, i) => (b[8 + i] = c.charCodeAt(0)));
  return b;
}
const NOT_AN_IMAGE = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function csvRow(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    codigo: "ZIP-001",
    enunciado: "Enunciado de teste de pacote ZIP suficientemente longo.",
    resolucao_comentada: "Resolução comentada de teste.",
    dificuldade: "media",
    origem: "autoral",
    prova: "ENEM",
    ano: "2024",
    alt_a: "Alternativa A",
    alt_b: "Alternativa B",
    alt_c: "Alternativa C",
    alt_d: "Alternativa D",
    alt_e: "Alternativa E",
    correta: "B",
    macete: "Macete de teste.",
    padrao_principal: "Escala e Proporção",
    padroes_secundarios: "",
    tags: "zip;teste",
    titular_direitos: "Fixture",
    base_licenca: "Interno",
    texto_atribuicao: "",
  };
  return { ...base, ...overrides };
}

function buildCsvV2(rows: Array<Record<string, string>>): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = IMPORT_CSV_V2_HEADERS.join(",");
  const lines = rows.map((row) => IMPORT_CSV_V2_HEADERS.map((h) => escape(row[h] ?? "")).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

interface ManifestImage {
  file: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter?: string | null;
  altText: string;
  caption?: string | null;
}
interface ManifestQ {
  code: string;
  images: ManifestImage[];
}

function buildManifest(questions: ManifestQ[], version = 1): string {
  return JSON.stringify({ version, questions });
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Sprint 19.1, correção 2, item 4 — `zipSync`/`buildPackage` (objeto JS)
 *  não conseguem produzir duas entradas com o MESMO nome. Mesma técnica de
 *  `zip.test.ts`: API de streaming (`Zip`/`ZipPassThrough`) para fabricar
 *  um ZIP com uma entrada física duplicada de verdade. */
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

/** Monta o pacote ZIP em memória — sempre com questoes.csv+manifest.json,
 *  mais quaisquer imagens/arquivos extras informados. */
function buildPackage(options: {
  csvRows?: Array<Record<string, string>>;
  csvText?: string;
  manifest?: ManifestQ[] | string;
  manifestVersion?: number;
  images?: Record<string, Uint8Array>;
  extraFiles?: Record<string, Uint8Array>;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files["questoes.csv"] = textBytes(options.csvText ?? buildCsvV2(options.csvRows ?? [csvRow()]));
  const manifestContent = typeof options.manifest === "string" ? options.manifest : buildManifest(options.manifest ?? [], options.manifestVersion ?? 1);
  files["manifest.json"] = textBytes(manifestContent);
  for (const [path, bytes] of Object.entries(options.images ?? {})) files[path] = bytes;
  for (const [path, bytes] of Object.entries(options.extraFiles ?? {})) files[path] = bytes;
  return zipSync(files);
}

function standardImageManifest(): ManifestQ[] {
  return [
    {
      code: "ZIP-001",
      images: [
        { file: "imagens/enunciado.png", placement: "enunciado", altText: "Gráfico do enunciado" },
        { file: "imagens/alt-c.jpg", placement: "alternativa", alternativeLetter: "C", altText: "Imagem da alternativa C" },
      ],
    },
  ];
}

function standardImages(): Record<string, Uint8Array> {
  return { "imagens/enunciado.png": PNG_BYTES, "imagens/alt-c.jpg": JPEG_BYTES };
}

describe("previewPackage — pacote válido (itens 10-14/37-39)", () => {
  it("item 10 — ZIP válido SEM imagens gera preview aplicável, sem criar question", async () => {
    const zip = buildPackage({ manifest: [] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.imageCount).toBe(0);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0); // item 37
    expect(bucket.size()).toBe(0); // item 38
  });

  it("item 11 — ZIP válido com imagem no ENUNCIADO", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "enunciado", altText: "Foto do enunciado" }] }],
      images: { "imagens/foto.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.imageCount).toBe(1);
    expect(result.questions![0].images[0].placement).toBe("enunciado");
  });

  it("item 12 — imagem na ALTERNATIVA A-E", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/opcao-c.png", placement: "alternativa", alternativeLetter: "C", altText: "Opção C" }] }],
      images: { "imagens/opcao-c.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
    expect(result.questions![0].images[0].placement).toBe("alternativa");
    expect(result.questions![0].images[0].alternativeLetter).toBe("C");
  });

  it("item 13 — múltiplas imagens por questão (enunciado + alternativa)", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
    expect(result.imageCount).toBe(2);
  });

  it("item 14 — ordem determinística (índice 0-based por grupo placement/letra)", async () => {
    const zip = buildPackage({
      manifest: [
        {
          code: "ZIP-001",
          images: [
            { file: "imagens/e1.png", placement: "enunciado", altText: "Primeira" },
            { file: "imagens/e2.jpg", placement: "enunciado", altText: "Segunda" },
          ],
        },
      ],
      images: { "imagens/e1.png": PNG_BYTES, "imagens/e2.jpg": JPEG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
    // ordem preservada exatamente como no manifest.
    expect(result.questions![0].images.map((i) => i.path)).toEqual(["imagens/e1.png", "imagens/e2.jpg"]);
  });

  it("item 39 — IDs de question/image são estáveis (não mudam entre chamadas de leitura do mesmo preview)", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
    const batch = db.sqlite.prepare("SELECT payload FROM question_import_batches WHERE id = ?").get(result.batchId!) as { payload: string };
    const payload = JSON.parse(batch.payload);
    expect(payload.rows[0].questionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.images[0].imageId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("previewPackage — validações bloqueantes (itens 15-27)", () => {
  it("item 15 — missing image (referenciada no manifest, ausente do ZIP) bloqueia", async () => {
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "imagens/nao-existe.png", placement: "enunciado", altText: "X" }] }] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("ausente do ZIP"))).toBe(true);
  });

  it("item 16 — orphan image (em imagens/ mas não referenciada) bloqueia", async () => {
    const zip = buildPackage({ manifest: [], images: { "imagens/orfa.png": PNG_BYTES } });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("órfã"))).toBe(true);
  });

  it("item 17 — mesma imagem referenciada duas vezes no manifest bloqueia", async () => {
    const zip = buildPackage({
      manifest: [
        {
          code: "ZIP-001",
          images: [
            { file: "imagens/foto.png", placement: "enunciado", altText: "Primeira" },
            { file: "imagens/foto.png", placement: "alternativa", alternativeLetter: "A", altText: "Repetida" },
          ],
        },
      ],
      images: { "imagens/foto.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("mais de uma vez"))).toBe(true);
  });

  it("item 18 — duplicate normalized path (mesma imagem em cases diferentes) bloqueia", async () => {
    const zip = buildPackage({
      manifest: [
        {
          code: "ZIP-001",
          images: [
            { file: "imagens/Foto.png", placement: "enunciado", altText: "Original" },
            { file: "imagens/foto.png", placement: "alternativa", alternativeLetter: "A", altText: "Case diferente" },
          ],
        },
      ],
      images: { "imagens/Foto.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    // A segunda referência não encontra "imagens/foto.png" no ZIP (só
    // "imagens/Foto.png" existe) — ausência é o próprio bloqueio esperado
    // para uma colisão de normalização.
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("item 4 (correção 19.1, seção 2) — duplicidade FÍSICA de entrada no ZIP nunca chega ao manifest/cross-validation: bloqueia direto no leitor", async () => {
    const csv = buildCsvV2([csvRow()]);
    const manifest = buildManifest(standardImageManifest());
    const zip = await buildRawZipWithEntries([
      { name: "questoes.csv", data: textBytes(csv) },
      { name: "manifest.json", data: textBytes(manifest) },
      { name: "imagens/enunciado.png", data: PNG_BYTES },
      { name: "imagens/enunciado.png", data: PNG_BYTES }, // entrada física duplicada — mesmo nome, mesmo conteúdo.
      { name: "imagens/alt-c.jpg", data: JPEG_BYTES },
    ]);
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    // A mensagem vem do leitor de ZIP (seção 8), nunca do cross-validation
    // do manifest (que produziria "ausente do ZIP"/"órfã"/etc.) — prova que
    // a colisão é barrada ANTES de qualquer uso ambíguo da entrada.
    expect(result.errors!.some((e) => e.message.includes("duplicada"))).toBe(true);
    expect(result.errors!.some((e) => e.message.includes("órfã") || e.message.includes("ausente do ZIP"))).toBe(false);
  });

  it("item 19 — path traversal ('../') no manifest bloqueia", async () => {
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "imagens/../../etc/passwd", placement: "enunciado", altText: "X" }] }] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("inválido/inseguro"))).toBe(true);
  });

  it("item 20 — caminho absoluto no manifest bloqueia", async () => {
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "/etc/passwd", placement: "enunciado", altText: "X" }] }] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
  });

  it("item 21 — arquivo fora de imagens/ no ZIP bloqueia (arquivo não esperado)", async () => {
    const zip = buildPackage({ manifest: [], extraFiles: { "outro.txt": textBytes("x") } });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("não esperado"))).toBe(true);
  });

  it("item 22 — manifest.json inválido (JSON malformado) bloqueia", async () => {
    const zip = buildPackage({ manifest: "{ isto não é json" });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("JSON válido"))).toBe(true);
  });

  it("item 23 — version desconhecida no manifest bloqueia", async () => {
    const zip = buildPackage({ manifest: [], manifestVersion: 99 });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("Versão"))).toBe(true);
  });

  it("item 24 — code inexistente em questoes.csv bloqueia", async () => {
    const zip = buildPackage({ manifest: [{ code: "CODIGO-QUE-NAO-EXISTE", images: [] }] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("não existe (ou tem erro)"))).toBe(true);
  });

  it("code duplicado NO MANIFEST bloqueia", async () => {
    const zip = buildPackage({
      manifest: [
        { code: "ZIP-001", images: [] },
        { code: "ZIP-001", images: [] },
      ],
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("duplicado no manifest"))).toBe(true);
  });

  it("item 25 — altText vazio bloqueia", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "enunciado", altText: "" }] }],
      images: { "imagens/foto.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("altText"))).toBe(true);
  });

  it("item 26 — placement incoerente (alternativa sem alternativeLetter) bloqueia", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "alternativa", altText: "X" }] }],
      images: { "imagens/foto.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("alternativeLetter"))).toBe(true);
  });

  it("placement=enunciado com alternativeLetter preenchido bloqueia", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "enunciado", alternativeLetter: "A", altText: "X" }] }],
      images: { "imagens/foto.png": PNG_BYTES },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
  });

  it("item 27 — mais de 15 imagens por questão bloqueia", async () => {
    const images: ManifestImage[] = Array.from({ length: 16 }, (_, i) => ({ file: `imagens/e${i}.png`, placement: "enunciado" as const, altText: `Imagem ${i}` }));
    const imageBytes: Record<string, Uint8Array> = {};
    images.forEach((img) => (imageBytes[img.file] = PNG_BYTES));
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images }], images: imageBytes });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("excede o limite de 15"))).toBe(true);
  });
});

describe("previewPackage — validação de imagem real (itens 28-33)", () => {
  it("item 28 — PNG válido é aceito", async () => {
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "enunciado", altText: "X" }] }], images: { "imagens/foto.png": PNG_BYTES } });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
  });

  it("item 29 — JPEG válido é aceito", async () => {
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.jpg", placement: "enunciado", altText: "X" }] }], images: { "imagens/foto.jpg": JPEG_BYTES } });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
  });

  it("item 30 — WebP válido é aceito", async () => {
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.webp", placement: "enunciado", altText: "X" }] }], images: { "imagens/foto.webp": webpBytes() } });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
  });

  it("item 31 — SVG é bloqueado explicitamente", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.svg", placement: "enunciado", altText: "X" }] }],
      images: { "imagens/foto.svg": textBytes("<svg></svg>") },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("SVG"))).toBe(true);
  });

  it("item 32 — extensão declarada divergente do conteúdo real (MIME sniffado) bloqueia", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "enunciado", altText: "X" }] }],
      images: { "imagens/foto.png": JPEG_BYTES }, // extensão .png, bytes reais de JPEG.
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("extensão não corresponde"))).toBe(true);
  });

  it("formato não reconhecido (PDF disfarçado) bloqueia", async () => {
    const zip = buildPackage({
      manifest: [{ code: "ZIP-001", images: [{ file: "imagens/foto.png", placement: "enunciado", altText: "X" }] }],
      images: { "imagens/foto.png": NOT_AN_IMAGE },
    });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("não reconhecido"))).toBe(true);
  });

  it("item 33 — arquivo de imagem acima de 8MB bloqueia", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(PNG_BYTES, 0);
    const zip = buildPackage({ manifest: [{ code: "ZIP-001", images: [{ file: "imagens/grande.png", placement: "enunciado", altText: "X" }] }], images: { "imagens/grande.png": big } });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("excede o limite"))).toBe(true);
  });
});

describe("previewPackage — limites estruturais adicionais", () => {
  it("mais de 100 questões no pacote bloqueia", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => csvRow({ codigo: `ZIP-${i}` }));
    const zip = buildPackage({ csvRows: rows, manifest: [] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
  });

  it("questoes.csv fora do formato V2 (faltando cabeçalho) bloqueia com mensagem clara", async () => {
    const zip = buildPackage({ csvText: "codigo,enunciado\nX,Y\n", manifest: [] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("CSV V2"))).toBe(true);
  });
});

/* Sprint 19.1, correção 3 da ordem — teto de bytes UTF-8 REAIS do payload
   gravado em `question_import_batches.payload` (limite real do D1: 2.000.000
   bytes por linha/coluna). Unitários da fronteira exata em
   `measureUtf8Bytes`/`isPayloadWithinBatchLimit`; integração fim a fim
   provando o bloqueio ANTES de `insertImportBatch` via `previewPackage`. */
describe("importBatchLimits — medição de bytes UTF-8 reais (correção 19.1, seção 3)", () => {
  it("mede bytes UTF-8 REAIS, nunca string.length (todo acento ocupa 2 bytes em UTF-8, 1 em string.length)", () => {
    const text = "á".repeat(1000);
    expect(text.length).toBe(1000); // string.length SUBESTIMARIA — exatamente o erro que a correção evita.
    expect(measureUtf8Bytes(text)).toBe(2000);
  });

  it("payload exatamente no teto é permitido; 1 byte acima já bloqueia", () => {
    const atLimit = "A".repeat(IMPORT_BATCH_PAYLOAD_MAX_BYTES); // "A" = 1 byte UTF-8, fronteira exata.
    expect(isPayloadWithinBatchLimit(atLimit)).toBe(true);
    const overLimit = "A".repeat(IMPORT_BATCH_PAYLOAD_MAX_BYTES + 1);
    expect(isPayloadWithinBatchLimit(overLimit)).toBe(false);
  });
});

describe("previewPackage — limite de bytes do payload (correção 19.1, seção 3)", () => {
  it("payload grande mas DENTRO do teto passa normalmente", async () => {
    const zip = buildPackage({ csvRows: [csvRow({ resolucao_comentada: "R".repeat(1_000_000) })], manifest: [] });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(true);
  });

  it("payload acima do teto é bloqueado ANTES de insertImportBatch — nenhuma linha question_import_batches criada", async () => {
    const hugeText = "R".repeat(1_900_000); // garante ultrapassar 1.800.000 bytes mesmo com overhead de JSON/CSV.
    const zip = buildPackage({ csvRows: [csvRow({ resolucao_comentada: hugeText })], manifest: [] });
    const countBefore = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_import_batches").get() as { total: number }).total;
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("prévia grande demais"))).toBe(true);
    const countAfter = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_import_batches").get() as { total: number }).total;
    expect(countAfter).toBe(countBefore);
  });
});

/* Sprint 19.1, correção 4 da ordem — teto de QUANTIDADE de statements que
   o apply monta em `db.batch()`. `plannedD1StatementCount` é testado
   diretamente (fórmula exata) e via `previewPackage`/`applyPackage`
   (bloqueio real, nunca dependente só do limite de 100 questões — um
   pacote com poucas questões mas muitas tags/imagens já ultrapassa). */
describe("plannedD1StatementCount — fórmula exata (correção 19.1, seção 4)", () => {
  it("conta 1 (marca lote) + por questão (question+dna+alternativas+padroes+tags+history+item) + 1 por imagem", () => {
    const payload = {
      sourceKind: "zip",
      rows: [
        { alternativas: new Array(5).fill(0), padroes: new Array(1).fill(0), tags: new Array(2).fill(0) },
        { alternativas: new Array(5).fill(0), padroes: new Array(2).fill(0), tags: [] },
      ],
      images: new Array(3).fill(0),
    };
    // linha1 = 1+1+5+1+2+1+1 = 12; linha2 = 1+1+5+2+0+1+1 = 11; +1 (marca) +3 (imagens).
    expect(plannedD1StatementCount(payload as never)).toBe(1 + 12 + 11 + 3);
  });

  it("mais alternativas/padrões/tags/imagens sempre elevam a contagem (nunca reduz)", () => {
    const base = { sourceKind: "zip", rows: [{ alternativas: [], padroes: [], tags: [] }], images: [] };
    const withMore = { sourceKind: "zip", rows: [{ alternativas: [1], padroes: [1], tags: [1, 2] }], images: [1] };
    expect(plannedD1StatementCount(withMore as never)).toBeGreaterThan(plannedD1StatementCount(base as never));
  });
});

describe("previewPackage/applyPackage — orçamento de statements D1 (correção 19.1, seção 4)", () => {
  it("pacote dentro do orçamento passa normalmente (preview e apply)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => csvRow({ codigo: `ZIP-${i}`, enunciado: `Enunciado de teste de pacote ZIP suficientemente longo, variante ${i}.` }));
    const zip = buildPackage({ csvRows: rows, manifest: [] });
    const preview = await previewPackage(db as never, "editor1", zip);
    expect(preview.ok).toBe(true);
    const applied = await applyPackage(db as never, bucket as never, "editor1", preview.batchId!, zip);
    expect(applied.ok).toBe(true);
  });

  it("muitas tags por questão elevam o orçamento e podem ultrapassá-lo — bloqueia no PREVIEW, antes de qualquer INSERT", async () => {
    const manyTags = Array.from({ length: 500 }, (_, i) => `tag-${i}`).join(";");
    const zip = buildPackage({ csvRows: [csvRow({ tags: manyTags })], manifest: [] });
    const countBefore = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_import_batches").get() as { total: number }).total;
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("operações no banco de dados"))).toBe(true);
    expect(result.errors!.some((e) => e.message.includes(`${IMPORT_BATCH_MAX_D1_STATEMENTS}`))).toBe(true);
    const countAfter = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_import_batches").get() as { total: number }).total;
    expect(countAfter).toBe(countBefore); // nenhuma linha criada.
  });

  it("muitas imagens por questão elevam o orçamento e podem ultrapassá-lo (mesmo dentro do limite de 15 imagens/questão e 100 questões/pacote)", async () => {
    const QUESTIONS = 15;
    const IMAGES_PER_QUESTION = 15; // teto do item 27 — nunca violado por este teste.
    const manyTags = Array.from({ length: 10 }, (_, i) => `t${i}`).join(";");
    const rows = Array.from({ length: QUESTIONS }, (_, i) =>
      csvRow({ codigo: `ZIP-${i}`, tags: manyTags, enunciado: `Enunciado de teste de pacote ZIP suficientemente longo, variante ${i}.` })
    );
    const manifest: ManifestQ[] = [];
    const images: Record<string, Uint8Array> = {};
    for (let q = 0; q < QUESTIONS; q++) {
      const qImages: ManifestImage[] = [];
      for (let im = 0; im < IMAGES_PER_QUESTION; im++) {
        const file = `imagens/q${q}-${im}.png`;
        qImages.push({ file, placement: "enunciado", altText: `Imagem ${im}` });
        images[file] = PNG_BYTES;
      }
      manifest.push({ code: `ZIP-${q}`, images: qImages });
    }
    const zip = buildPackage({ csvRows: rows, manifest, images });
    const result = await previewPackage(db as never, "editor1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.message.includes("operações no banco de dados"))).toBe(true);
  });

  it("orçamento ultrapassado bloqueia ANTES do R2 também no apply (defesa em profundidade — nunca só o preview)", async () => {
    // Preview legítimo e pequeno primeiro (payload real, válido).
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    // Simula um payload que ultrapassa o orçamento chegando ao apply de
    // alguma forma que não passou pelo gate do preview desta correção
    // (ex.: prévia antiga) — infla as tags da linha já persistida
    // diretamente no banco, sem tocar em nenhum padrão/código (não dispara
    // nenhuma outra revalidação) só para provar que o APPLY também
    // verifica, de forma independente do preview.
    const batch = db.sqlite.prepare("SELECT payload FROM question_import_batches WHERE id = ?").get(batchId) as { payload: string };
    const payload = JSON.parse(batch.payload);
    payload.rows[0].tags = new Array(500).fill(0);
    db.sqlite.exec(`UPDATE question_import_batches SET payload = '${JSON.stringify(payload).replace(/'/g, "''")}' WHERE id = '${batchId}'`);

    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.tooManyStatements).toBe(true);
    expect(bucket.size()).toBe(0); // NENHUM objeto R2 sobe quando o orçamento é ultrapassado.
  });
});

/* --------------------------------- APPLY --------------------------------- */

async function previewAndGetBatchId(zip: Uint8Array): Promise<string> {
  const result = await previewPackage(db as never, "editor1", zip);
  if (!result.ok) throw new Error(`preview falhou inesperadamente: ${JSON.stringify(result.errors)}`);
  return result.batchId!;
}

describe("applyPackage — sucesso e consistência R2↔D1 (itens 40-53)", () => {
  it("item 46/47/48/49 — sucesso cria tudo como draft, com placement/storage_kind/hash corretos", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(result.imageCount).toBe(2);

    const question = db.sqlite.prepare("SELECT editorial_status FROM questions WHERE id = ?").get(result.questionIds![0]) as { editorial_status: string };
    expect(question.editorial_status).toBe("draft");

    const images = db.sqlite
      .prepare("SELECT placement, alternative_letter, storage_kind, content_sha256, mime_type FROM question_images WHERE question_id = ? ORDER BY placement, position")
      .all(result.questionIds![0]) as Array<{ placement: string; alternative_letter: string | null; storage_kind: string; content_sha256: string; mime_type: string }>;
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.storage_kind).toBe("r2");
      expect(img.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const alt = images.find((i) => i.placement === "alternativa")!;
    expect(alt.alternative_letter).toBe("C");
    expect(bucket.size()).toBe(2);
  });

  it("item 43 (revisado 19.1) — todos os objetos R2 sobem ANTES de qualquer escrita D1; falha de D1 NUNCA apaga esses objetos", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO questions/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();
    // Sprint 19.1, correção 1 — o R2 já recebeu os objetos desta tentativa
    // ANTES da falha de D1; a correção deliberada é NUNCA apagá-los (um
    // órfão recuperável por retry é preferível a qualquer risco de D1
    // apontar para um objeto inexistente). Nenhum question criado (D1 fez
    // ROLLBACK completo da transação).
    expect(bucket.size()).toBe(2);
    expect(bucket.deletedKeys).toEqual([]);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0);
  });

  it("item 45 (revisado 19.1) — falha D1 NUNCA apaga objetos R2 recém-criados nesta tentativa (órfão aceitável, retry reutiliza)", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO question_alternatives/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();
    expect(bucket.size()).toBe(2);
    expect(bucket.deletedKeys).toEqual([]);

    // Retry do MESMO lote reconhece as chaves órfãs (idênticas por hash) e
    // completa com sucesso, sem duplicar nada no R2.
    const retry = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(retry.ok).toBe(true);
    expect(bucket.size()).toBe(2);
  });

  it("item 53 (revisado 19.1) — nenhuma linha D1 parcial após falha (question_images vazio), mas objetos R2 permanecem órfãos", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO question_images/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();
    expect(bucket.size()).toBe(2);
    expect(bucket.deletedKeys).toEqual([]);
    const imgCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images").get() as { total: number }).total;
    expect(imgCount).toBe(0);
  });

  it("item 50 — retry (mesmo batchId, mesmo ZIP) já aplicado não duplica nada", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    const first = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(first.ok).toBe(true);

    const retry = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(retry.ok).toBe(true);
    expect(retry.alreadyApplied).toBe(true);

    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(1);
    expect(bucket.size()).toBe(2);
  });

  it("item 40 — ZIP reenviado com hash DIFERENTE do preview → conflito, nada escrito", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    const differentZip = buildPackage({ manifest: [], csvRows: [csvRow({ codigo: "OUTRO-CODIGO" })] });

    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, differentZip);
    expect(result.ok).toBe(false);
    expect(result.fingerprintMismatch).toBe(true);
    expect(bucket.size()).toBe(0);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0);
  });

  it("item 41 — revalidação de código duplicado (criado no banco DEPOIS do preview) bloqueia o apply", async () => {
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    // Simula outra questão com o MESMO código criada entre o preview e o apply.
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('outra-q', 'ZIP-001', 'Outro enunciado', 'media', 'autoral', 'fp-outra')`
    );
    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("item 42 — revalidação de fingerprint duplicado bloqueia o apply", async () => {
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    // Descobre o fingerprint real gravado no preview e cria uma questão colidente.
    const batch = db.sqlite.prepare("SELECT payload FROM question_import_batches WHERE id = ?").get(batchId) as { payload: string };
    const fingerprint = JSON.parse(batch.payload).rows[0].fingerprint as string;
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('outra-q2', 'OUTRO-COD', 'Outro enunciado', 'media', 'autoral', '${fingerprint}')`
    );
    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("padrão removido entre preview e apply bloqueia (revalidação de padrões)", async () => {
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    db.sqlite.exec(`DELETE FROM patterns WHERE id = 'pat-1'`);
    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it("item 51 — key R2 órfã IDÊNTICA (mesmo hash/mime/tamanho) é reutilizada sem erro", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    const batch = db.sqlite.prepare("SELECT payload FROM question_import_batches WHERE id = ?").get(batchId) as { payload: string };
    const payload = JSON.parse(batch.payload);
    const questionId = payload.rows[0].questionId as string;
    const image = payload.images[0] as { imageId: string; mimeType: string; contentSha256: string; sizeBytes: number };

    // Simula um resto órfão de uma tentativa anterior: mesmo conteúdo, já no R2.
    const key = `questions/${questionId}/${image.imageId}.png`;
    await bucket.put(key, PNG_BYTES, { httpMetadata: { contentType: image.mimeType }, customMetadata: { contentSha256: image.contentSha256 } });
    expect(bucket.size()).toBe(1);

    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(true);
    expect(bucket.size()).toBe(2); // 1 reutilizado + 1 novo (a segunda imagem do fixture).
  });

  it("item 52 — key R2 existente com hash DIFERENTE bloqueia (conflito fail-closed, nunca sobrescreve)", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    const batch = db.sqlite.prepare("SELECT payload FROM question_import_batches WHERE id = ?").get(batchId) as { payload: string };
    const payload = JSON.parse(batch.payload);
    const questionId = payload.rows[0].questionId as string;
    const image = payload.images[0] as { imageId: string; mimeType: string };

    const key = `questions/${questionId}/${image.imageId}.png`;
    await bucket.put(key, new Uint8Array([9, 9, 9]), { httpMetadata: { contentType: image.mimeType }, customMetadata: { contentSha256: "hash-completamente-diferente" } });

    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    // Nunca sobrescreveu — o conteúdo original (adulterado) permanece intocado.
    const stillThere = await bucket.get(key);
    expect(new Uint8Array((await new Response(stillThere!.body).arrayBuffer()))).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("preview expirado bloqueia o apply", async () => {
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    // Mesmo formato ISO8601 que o serviço realmente grava (`toISOString()`)
    // — o formato "space-separated" nativo do SQLite `datetime()` não é o
    // que a aplicação usa, e testar com ele mascararia um parse ambíguo.
    const expiredIso = new Date(Date.now() - 3600_000).toISOString();
    db.sqlite.exec(`UPDATE question_import_batches SET expires_at = '${expiredIso}' WHERE id = '${batchId}'`);
    const result = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.expired).toBe(true);
  });

  it("batch de outro usuário retorna notFound (nunca vaza existência)", async () => {
    await createUser(db as never, { id: "editor2", name: "Outra", email: "editor2@teste.dev", emailNormalized: "editor2@teste.dev", passwordHash: "hash" });
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    const result = await applyPackage(db as never, bucket as never, "editor2", batchId, zip);
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});

/* Sprint 19.1, correção 1 da ordem — testes adversariais A/B/C/D
   (verbatim da ordem). A "porta" `db.pauseReadsMatching` (já existente no
   fake, criada para o TOCTOU de `dailyTrainingService.startItem`) deixa
   duas chamadas concorrentes de `applyPackage` no MESMO batchId lerem o
   estado (limpo, idêntico) da revalidação ANTES de qualquer uma escrever —
   exatamente a janela em que o bug original de corrida R2↔D1 acontecia.
   `db.batch()` do fake serializa como o D1 real (uma transação por vez),
   então a PRIMEIRA chamada a alcançar `db.batch()` sempre "vence" a
   corrida — a ordem de chegada em `db.batch()` é determinística aqui
   porque as duas chamadas seguem exatamente o mesmo caminho de `await`s a
   partir da liberação da porta (FIFO de microtasks do Node), mas os testes
   abaixo nunca assumem qual delas "ganha" por nome de variável — sempre
   filtram pelo resultado. */
describe("applyPackage — testes adversariais de corrida R2↔D1 (correção 19.1, seção 1)", () => {
  it("Teste A — duas chamadas concorrentes no MESMO batch: só uma aplica no D1; a outra recebe alreadyApplied controlado; nada duplica; todas as chaves do vencedor continuam no R2", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);

    const gate = db.pauseReadsMatching(/SELECT \* FROM questions WHERE code = \?/, 2);
    const callA = applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    const callB = applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    await gate.arrived;
    gate.release();

    const results = await Promise.all([callA, callB]);
    // Nenhuma exceção não tratada — as duas chamadas retornam controladamente.
    const winners = results.filter((r) => r.ok && !r.alreadyApplied);
    const losers = results.filter((r) => !(r.ok && !r.alreadyApplied));
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].ok).toBe(true);
    expect(losers[0].alreadyApplied).toBe(true);

    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(1); // nunca duplica.
    const imageCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images").get() as { total: number }).total;
    expect(imageCount).toBe(2); // nunca duplica.

    const winnerQuestionId = winners[0].questionIds![0];
    const images = db.sqlite.prepare("SELECT asset_ref FROM question_images WHERE question_id = ?").all(winnerQuestionId) as Array<{ asset_ref: string }>;
    expect(images.length).toBe(2);
    for (const img of images) expect(bucket.has(img.asset_ref)).toBe(true); // TODAS as chaves do vencedor existem no R2.
  });

  it("Teste B — tentativa A sobe R2 e falha no D1 enquanto B está em voo: A não apaga chave que B usa; ao aplicar, TODAS as referências D1 de B apontam para objetos existentes no R2", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);

    const gate = db.pauseReadsMatching(/SELECT \* FROM questions WHERE code = \?/, 2);
    // Atinge a PRIMEIRA transação a chegar em `db.batch()` (== a primeira
    // chamada a terminar o upload R2 e tentar aplicar) — consumida uma
    // única vez, então só "a tentativa A" falha; a que roda depois (B, já
    // sem status 'previewed' disputado) aplica normalmente.
    db.failNextMatching(/INSERT INTO question_alternatives/);
    const callA = applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    const callB = applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    await gate.arrived;
    gate.release();

    const settled = await Promise.allSettled([callA, callB]);
    const failures = settled.filter((r) => r.status === "rejected");
    const successes = settled.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof applyPackage>>> => r.status === "fulfilled" && r.value.ok === true
    );
    expect(failures.length).toBe(1);
    expect(successes.length).toBe(1);
    expect(successes[0].value.alreadyApplied).toBeFalsy(); // aplicou de verdade — não é um retry de "já aplicado".

    // A falha de A NUNCA apagou os objetos R2 que B (em voo) precisava.
    expect(bucket.deletedKeys).toEqual([]);
    expect(bucket.size()).toBe(2);

    const questionId = successes[0].value.questionIds![0];
    const images = db.sqlite.prepare("SELECT asset_ref FROM question_images WHERE question_id = ?").all(questionId) as Array<{ asset_ref: string }>;
    expect(images.length).toBe(2);
    for (const img of images) expect(bucket.has(img.asset_ref)).toBe(true); // TODAS as referências D1 de B existem no R2.

    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(1);
  });

  it("Teste C — falha de upload NO MEIO do laço: D1 sem escrita parcial; objeto que restou no R2 é órfão aceitável; retry do MESMO lote o reutiliza e completa", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);

    bucket.failNthPut(1); // 1ª imagem (enunciado) sobe normalmente; a 2ª (alternativa) falha.
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();

    // D1 sem NENHUMA escrita — o laço de upload falhou ANTES de montar o db.batch().
    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(0);
    const imgCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images").get() as { total: number }).total;
    expect(imgCount).toBe(0);

    // Só o objeto que subiu ANTES da falha permanece — órfão aceitável, nunca apagado.
    expect(bucket.size()).toBe(1);
    expect(bucket.deletedKeys).toEqual([]);

    const retry = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(retry.ok).toBe(true);
    expect(bucket.size()).toBe(2);
    const finalQuestionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(finalQuestionCount).toBe(1);
  });

  it("Teste D — falha D1 SEM concorrência: nenhuma linha parcial de questions/question_images; órfão R2 eventual documentado; retry posterior o reutiliza", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO question_history/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();

    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(0);
    const imgCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images").get() as { total: number }).total;
    expect(imgCount).toBe(0);
    expect(bucket.size()).toBe(2); // ambos os objetos desta tentativa ficam como órfãos documentados, nunca apagados.
    expect(bucket.deletedKeys).toEqual([]);

    const retry = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(retry.ok).toBe(true);
    expect(bucket.size()).toBe(2); // reutilizados, nenhum objeto novo.
  });
});

/* --------------------------------- UNDO --------------------------------- */

describe("undo de lote ZIP (itens 54-58)", () => {
  it("item 54/55 — undo remove as questões draft do lote e limpa os objetos R2 do lote", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    const applied = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    expect(applied.ok).toBe(true);
    expect(bucket.size()).toBe(2);

    const result = await undoImport(db as never, "editor1", batchId, bucket as never);
    expect(result.ok).toBe(true);
    expect(result.undoneCount).toBe(1);

    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(0);
    expect(bucket.size()).toBe(0);
  });

  it("item 56 — falha na limpeza R2 nunca recria a referência D1 (D1 já não aponta para o objeto)", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    await applyPackage(db as never, bucket as never, "editor1", batchId, zip);

    const originalDelete = bucket.delete.bind(bucket);
    bucket.delete = async () => {
      throw new Error("falha simulada de rede no R2");
    };
    const result = await undoImport(db as never, "editor1", batchId, bucket as never);
    expect(result.ok).toBe(true); // undo D1 é o que importa — sucesso do usuário já alcançado.
    const questionCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(questionCount).toBe(0); // D1 confirmadamente limpo mesmo com R2 falhando.
    bucket.delete = originalDelete;
  });

  it("item 57 — retry de undo é idempotente", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    const first = await undoImport(db as never, "editor1", batchId, bucket as never);
    expect(first.ok).toBe(true);
    const retry = await undoImport(db as never, "editor1", batchId, bucket as never);
    expect(retry.ok).toBe(true);
    expect(retry.alreadyUndone).toBe(true);
  });

  it("item 58 — undo bloqueado se a questão do lote saiu de draft continua funcionando", async () => {
    const zip = buildPackage({ manifest: [] });
    const batchId = await previewAndGetBatchId(zip);
    const applied = await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'in_review' WHERE id = '${applied.questionIds![0]}'`);
    const result = await undoImport(db as never, "editor1", batchId, bucket as never);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("undo de lote ZIP nunca apaga imagem de OUTRA questão fora do lote", async () => {
    // Questão real, alheia ao lote, com sua própria imagem R2.
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint, editorial_status) VALUES ('q-alheia', 'ALHEIA-1', 'Enunciado alheio', 'media', 'autoral', 'fp-alheia', 'draft')`
    );
    db.sqlite.exec(
      `INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, storage_kind) VALUES ('img-alheia', 'q-alheia', 'questions/q-alheia/img-alheia.png', 'Alheia', 0, 'enunciado', 'r2')`
    );
    await bucket.put("questions/q-alheia/img-alheia.png", PNG_BYTES, { httpMetadata: { contentType: "image/png" } });

    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    await applyPackage(db as never, bucket as never, "editor1", batchId, zip);
    await undoImport(db as never, "editor1", batchId, bucket as never);

    expect(bucket.has("questions/q-alheia/img-alheia.png")).toBe(true);
    const alheiaCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = 'q-alheia'").get() as { total: number }).total;
    expect(alheiaCount).toBe(1);
  });
});
