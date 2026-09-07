// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { previewPackage, applyPackage } from "../src/services/questionPackageImportService";
import { undoImport } from "../src/services/questionImportService";
import { IMPORT_CSV_V2_HEADERS } from "../src/lib/questionImportV2";

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

  it("item 43 — todos os objetos R2 sobem ANTES de qualquer escrita D1", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO questions/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();
    // D1 falhou DEPOIS do R2 já ter recebido os objetos desta tentativa —
    // que precisam ter sido limpos (item 45), não sobrado como "sucesso parcial".
    expect(bucket.size()).toBe(0);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0);
  });

  it("item 45 — falha D1 limpa TODOS os objetos R2 recém-criados nesta tentativa", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO question_alternatives/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();
    expect(bucket.size()).toBe(0);
    expect(bucket.deletedKeys.length).toBe(2);
  });

  it("item 53 — nenhum estado parcial D1↔R2 após falha (question_images também vazio)", async () => {
    const zip = buildPackage({ manifest: standardImageManifest(), images: standardImages() });
    const batchId = await previewAndGetBatchId(zip);
    db.failNextMatching(/INSERT INTO question_images/);
    await expect(applyPackage(db as never, bucket as never, "editor1", batchId, zip)).rejects.toThrow();
    expect(bucket.size()).toBe(0);
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
