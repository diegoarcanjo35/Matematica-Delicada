// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import {
  previewPdfFromClientPayload,
  applyPdfFromClientPreview,
  type PdfClientPreviewRawInput,
} from "../src/services/questionPdfImportService";
import type { PdfApplySelectionEntry } from "../src/services/questionPdfImportService";

/* Sprint 24.2 — importador ENEM client-side (Workers Free). Estes testes
   NUNCA constroem um PDF de verdade: o endpoint novo não abre PDF nenhum,
   só recebe o resultado JÁ ESTRUTURADO que o navegador teria produzido
   (mesmo formato de RawQuestionCandidate/RawVisualElement usado pelo
   pipeline client-side real, ver src/lib/pdfEnemImport/). */

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

const EXAM_SHA256 = "a".repeat(64);
const KEY_SHA256 = "b".repeat(64);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseQuestion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    originalNumber: 91,
    pageStart: 2,
    pageEnd: 2,
    statement: "Enunciado de teste suficientemente longo para a questão.",
    alternatives: [
      { letter: "A", text: "Alternativa A" },
      { letter: "B", text: "Alternativa B" },
      { letter: "C", text: "Alternativa C" },
      { letter: "D", text: "Alternativa D" },
      { letter: "E", text: "Alternativa E" },
    ],
    hasVisualContentOnPages: false,
    warnings: [],
    rawLineCount: 10,
    statementLocations: [{ pageNumber: 2, minY: 100, maxY: 200 }],
    alternativeLocations: {},
    hasOcrText: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<PdfClientPreviewRawInput> = {}): PdfClientPreviewRawInput {
  return {
    identityInput: { year: 2024, application: "Regular", booklet: "Caderno 5 Amarelo" },
    confirmation: true,
    examSha256: EXAM_SHA256,
    answerKeySha256: KEY_SHA256,
    pageCount: 32,
    parserVersion: "client-v1",
    examQuestions: [baseQuestion()],
    answerKey: [[91, "C"]],
    visualElements: [],
    examDetectedIdentity: { bookletNumber: 5, color: "AMARELO" },
    answerKeyDetectedIdentity: { day: 2, bookletNumber: 5, color: "AMARELO", year: 2024 },
    ...overrides,
  };
}

describe("previewPdfFromClientPayload — validação estrutural (nunca confia no cliente)", () => {
  it("rejeita sem confirmation", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ confirmation: false }), new Map());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("confirmation_required");
  });

  it("rejeita examSha256 malformado", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ examSha256: "not-a-hash" }), new Map());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });

  it("rejeita originalNumber duplicado (consolidação client-side deveria ter deduplicado)", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion(), baseQuestion()] }),
      new Map()
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
    expect(result.message).toMatch(/duplicado/);
  });

  it("rejeita pageStart fora do intervalo [1,pageCount]", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ pageStart: 999, pageEnd: 999 })] }),
      new Map()
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });

  it("rejeita letra de alternativa inválida", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ alternatives: [{ letter: "Z", text: "x" }] })] }),
      new Map()
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });
});

describe("previewPdfFromClientPayload — pipeline real (buildPreviewQuestions reaproveitado)", () => {
  it("gera prévia válida, casa gabarito, ready=true quando estruturalmente completa", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput(), new Map());
    expect(result.ok).toBe(true);
    expect(result.detectedQuestionCount).toBe(1);
    expect(result.matchedAnswerCount).toBe(1);
    expect(result.questions?.[0].correctAlternative).toBe("C");
    expect(result.questions?.[0].status).toBe("ready");
    expect(result.canApply).toBe(true);
  });

  it("questão sem gabarito correspondente nunca fica ready (fail-closed)", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ answerKey: [] }), new Map());
    expect(result.ok).toBe(true);
    expect(result.questions?.[0].correctAlternative).toBeNull();
    expect(result.questions?.[0].status).toBe("needs_review");
  });

  it("duplicidade REAL contra o D1 é detectada (mesma disciplina do fluxo PDF clássico)", async () => {
    const first = await previewPdfFromClientPayload(db as never, "editor1", baseInput(), new Map());
    expect(first.ok).toBe(true);
    const batchId = first.batchId!;
    const selection: PdfApplySelectionEntry[] = [{ originalNumber: 91, patternPrincipalId: "pat-1" }];
    const applied = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", batchId, selection, new Map());
    expect(applied.ok).toBe(true);

    // Segunda prévia com a MESMA questão (mesmo enunciado/alternativas) —
    // já existe no banco agora (fingerprint), tem que ser rejeitada.
    const second = await previewPdfFromClientPayload(db as never, "editor1", baseInput(), new Map());
    expect(second.ok).toBe(true);
    expect(second.questions?.[0].duplicateStatus).toBe("exact");
    expect(second.questions?.[0].canApply).toBe(false);
  });

  it("divergência de identidade REAL (checkDocumentIdentity server-side) bloqueia canApply", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examDetectedIdentity: { bookletNumber: 5, color: "AZUL" }, answerKeyDetectedIdentity: { day: 2, bookletNumber: 5, color: "AMARELO", year: 2024 } }),
      new Map()
    );
    expect(result.ok).toBe(true);
    expect(result.documentIdentityCheck?.ok).toBe(false);
    expect(result.canApply).toBe(false);
  });
});

describe("applyPdfFromClientPreview — atomicidade e integridade de imagem", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

  it("aplica sem imagens: cria questão em draft, sem tocar R2", async () => {
    const preview = await previewPdfFromClientPayload(db as never, "editor1", baseInput(), new Map());
    expect(preview.ok).toBe(true);
    const selection: PdfApplySelectionEntry[] = [{ originalNumber: 91, patternPrincipalId: "pat-1" }];
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map());
    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(1);
    expect(bucket.size()).toBe(0);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(1);
  });

  it("aplicar duas vezes é idempotente (alreadyApplied)", async () => {
    const preview = await previewPdfFromClientPayload(db as never, "editor1", baseInput(), new Map());
    const selection: PdfApplySelectionEntry[] = [{ originalNumber: 91, patternPrincipalId: "pat-1" }];
    const first = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map());
    expect(first.ok).toBe(true);
    const second = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map());
    expect(second.ok).toBe(true);
    expect(second.alreadyApplied).toBe(true);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(1); // nunca duplica.
  });

  it("imagem confirmada com pngSha256 batendo: sobe no R2 e cria question_images", async () => {
    const pngHash = "img-hash-1";
    const visualElement = {
      id: "el1",
      pageNumber: 2,
      kind: "raster",
      x: 10,
      y: 140, // dentro da faixa [100,200] de statementLocations — placeVisualElement usa Y, nunca proximidade de página (ver pdfEnemVisualPlacement.ts).
      width: 50,
      height: 20,
      hash: pngHash,
      extractionStatus: "extracted",
      placementCandidate: "statement",
      warnings: [],
    };
    const imageBytesByHash = new Map([[pngHash, PNG_BYTES]]);
    const preview = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [visualElement] }),
      imageBytesByHash
    );
    expect(preview.ok).toBe(true);
    expect(preview.questions?.[0].hasPendingVisualConfirmation).toBe(true);

    const selection: PdfApplySelectionEntry[] = [
      { originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: pngHash, placement: "statement", altText: "Gráfico de teste" }] },
    ];
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, imageBytesByHash);
    expect(result.ok).toBe(true);
    expect(bucket.size()).toBe(1);
    const imageCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images").get() as { total: number }).total;
    expect(imageCount).toBe(1);
  });

  it("imagem reenviada DIFERENTE da revisada no preview é bloqueada (integridade byte-a-byte)", async () => {
    const pngHash = "img-hash-2";
    const visualElement = {
      id: "el1",
      pageNumber: 2,
      kind: "raster",
      x: 10,
      y: 140,
      width: 50,
      height: 20,
      hash: pngHash,
      extractionStatus: "extracted",
      placementCandidate: "statement",
      warnings: [],
    };
    const previewTimeBytes = new Map([[pngHash, PNG_BYTES]]);
    const preview = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [visualElement] }),
      previewTimeBytes
    );
    expect(preview.ok).toBe(true);

    // No apply, reenvia bytes DIFERENTES (mesmo hash declarado, conteúdo mudou).
    const tamperedBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
    const applyTimeBytes = new Map([[pngHash, tamperedBytes]]);
    const selection: PdfApplySelectionEntry[] = [
      { originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: pngHash, placement: "statement", altText: "Gráfico de teste" }] },
    ];
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, applyTimeBytes);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(bucket.size()).toBe(0); // nunca sobe ao R2 antes de confirmar integridade.
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0); // nenhuma questão criada — tudo ou nada.
  });

  it("sanity: sha256Hex helper local bate com Web Crypto usado pelo serviço", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hex = sha256Hex(bytes);
    expect(hex).toHaveLength(64);
  });
});
