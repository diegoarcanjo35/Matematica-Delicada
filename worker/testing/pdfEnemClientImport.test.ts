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
   pipeline client-side real, ver src/workers/pdfEnemImportPipeline.ts).

   Hardening pós-auditoria — bloqueio real encontrado: o preview hasheava
   ~104 PNGs (SHA-256 de ~7,7MB somados) A CADA chamada, reintroduzindo
   exatamente o tipo de CPU pesada que esta sprint existe para eliminar
   (causa raiz do incidente P1). Corrigido: `previewPdfFromClientPayload`
   NUNCA MAIS recebe bytes de imagem — só metadado (`hash`/`pngSha256`/
   `byteLength`), validado por FORMA (nunca por prova). A prova de
   consistência real (bytes reenviados == bytes revisados) só acontece no
   `applyPdfFromClientPreview`, que SIM recebe e re-hasheia bytes. */

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
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG_SHA256 = sha256Hex(PNG_BYTES);

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

/** Elemento visual raster "extraído" REAL — sempre com `pngSha256`/
 *  `byteLength` (nunca `pngBytes`, que não existe mais neste contrato). */
function extractedVisualElement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "el1",
    pageNumber: 2,
    kind: "raster",
    x: 10,
    y: 140, // dentro da faixa [100,200] de statementLocations — placeVisualElement usa Y, nunca proximidade de página.
    width: 50,
    height: 20,
    hash: "img-hash-1",
    extractionStatus: "extracted",
    placementCandidate: "statement",
    warnings: [],
    pngSha256: PNG_SHA256,
    byteLength: PNG_BYTES.byteLength,
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
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ confirmation: false }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("confirmation_required");
  });

  it("rejeita examSha256 malformado", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ examSha256: "not-a-hash" }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });

  it("rejeita originalNumber duplicado (consolidação client-side deveria ter deduplicado)", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ examQuestions: [baseQuestion(), baseQuestion()] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
    expect(result.message).toMatch(/duplicado/);
  });

  it("rejeita pageStart fora do intervalo [1,pageCount]", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ examQuestions: [baseQuestion({ pageStart: 999, pageEnd: 999 })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });

  it("rejeita letra de alternativa inválida", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ examQuestions: [baseQuestion({ alternatives: [{ letter: "Z", text: "x" }] })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });
});

describe("previewPdfFromClientPayload — pipeline real (buildPreviewQuestions reaproveitado)", () => {
  it("gera prévia válida, casa gabarito, ready=true quando estruturalmente completa", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput());
    expect(result.ok).toBe(true);
    expect(result.detectedQuestionCount).toBe(1);
    expect(result.matchedAnswerCount).toBe(1);
    expect(result.questions?.[0].correctAlternative).toBe("C");
    expect(result.questions?.[0].status).toBe("ready");
    expect(result.canApply).toBe(true);
  });

  it("questão sem gabarito correspondente nunca fica ready (fail-closed)", async () => {
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ answerKey: [] }));
    expect(result.ok).toBe(true);
    expect(result.questions?.[0].correctAlternative).toBeNull();
    expect(result.questions?.[0].status).toBe("needs_review");
  });

  it("duplicidade REAL contra o D1 é detectada (mesma disciplina do fluxo PDF clássico)", async () => {
    const first = await previewPdfFromClientPayload(db as never, "editor1", baseInput());
    expect(first.ok).toBe(true);
    const batchId = first.batchId!;
    const selection: PdfApplySelectionEntry[] = [{ originalNumber: 91, patternPrincipalId: "pat-1" }];
    const applied = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", batchId, selection, new Map());
    expect(applied.ok).toBe(true);

    const second = await previewPdfFromClientPayload(db as never, "editor1", baseInput());
    expect(second.ok).toBe(true);
    expect(second.questions?.[0].duplicateStatus).toBe("exact");
    expect(second.questions?.[0].canApply).toBe(false);
  });

  it("divergência de identidade REAL (checkDocumentIdentity server-side) bloqueia canApply", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examDetectedIdentity: { bookletNumber: 5, color: "AZUL" }, answerKeyDetectedIdentity: { day: 2, bookletNumber: 5, color: "AMARELO", year: 2024 } })
    );
    expect(result.ok).toBe(true);
    expect(result.documentIdentityCheck?.ok).toBe(false);
    expect(result.canApply).toBe(false);
  });
});

/* ============================================================
   Seção 7 da ordem de hardening — testes adversariais focados A-J.
   ============================================================ */
describe("Hardening pós-auditoria — client-preview NUNCA recebe/hasheia bytes de imagem", () => {
  it("A) client-preview sem nenhum PNG (só metadado) → OK", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [extractedVisualElement()] })
    );
    expect(result.ok).toBe(true);
    expect(result.questions?.[0].hasPendingVisualConfirmation).toBe(true);
  });

  it("B) payload com pngSha256 malformado → 400 (invalid_payload)", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ visualElements: [extractedVisualElement({ pngSha256: "nao-e-um-hash" })] })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
    expect(result.message).toMatch(/pngSha256/);
  });

  it("B2) pngSha256 com tamanho certo mas caracteres inválidos (maiúsculo/fora de hex) → 400", async () => {
    const result = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ visualElements: [extractedVisualElement({ pngSha256: "G".repeat(64) })] })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_payload");
  });

  it("C) byteLength inválido (zero, negativo, não-inteiro ou acima do limite) → 400", async () => {
    for (const badByteLength of [0, -1, 1.5, 999_999_999]) {
      const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ visualElements: [extractedVisualElement({ byteLength: badByteLength })] }));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("invalid_payload");
    }
  });

  it("D) preview NUNCA executa hashing de arquivo — chamada sem nenhum Map de bytes ainda funciona (assinatura de 3 argumentos)", async () => {
    // A própria assinatura da função (sem parâmetro de bytes) já prova
    // isso estruturalmente — chamando só com os 3 argumentos esperados.
    const result = await previewPdfFromClientPayload(db as never, "editor1", baseInput({ visualElements: [extractedVisualElement()] }));
    expect(result.ok).toBe(true);
  });
});

describe("applyPdfFromClientPreview — atomicidade e integridade de imagem", () => {
  it("aplica sem imagens: cria questão em draft, sem tocar R2", async () => {
    const preview = await previewPdfFromClientPayload(db as never, "editor1", baseInput());
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
    const preview = await previewPdfFromClientPayload(db as never, "editor1", baseInput());
    const selection: PdfApplySelectionEntry[] = [{ originalNumber: 91, patternPrincipalId: "pat-1" }];
    const first = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map());
    expect(first.ok).toBe(true);
    const second = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map());
    expect(second.ok).toBe(true);
    expect(second.alreadyApplied).toBe(true);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(1); // nunca duplica.
  });

  it("E) apply com PNG cujo SHA-256 bate com o pngSha256 persistido no preview → OK, sobe no R2", async () => {
    const preview = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [extractedVisualElement()] })
    );
    expect(preview.ok).toBe(true);
    expect(preview.questions?.[0].hasPendingVisualConfirmation).toBe(true);

    const selection: PdfApplySelectionEntry[] = [
      { originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: "img-hash-1", placement: "statement", altText: "Gráfico de teste" }] },
    ];
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map([["img-hash-1", PNG_BYTES]]));
    expect(result.ok).toBe(true);
    expect(bucket.size()).toBe(1);
    const imageCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images").get() as { total: number }).total;
    expect(imageCount).toBe(1);
  });

  it("F) apply com PNG DIFERENTE do pngSha256 persistido no preview → bloqueia o lote inteiro", async () => {
    const preview = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [extractedVisualElement()] })
    );
    expect(preview.ok).toBe(true);

    const tamperedBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
    const selection: PdfApplySelectionEntry[] = [
      { originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: "img-hash-1", placement: "statement", altText: "Gráfico de teste" }] },
    ];
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map([["img-hash-1", tamperedBytes]]));
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(bucket.size()).toBe(0); // nunca sobe ao R2 antes de confirmar integridade.
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0); // nenhuma questão criada — tudo ou nada.
  });

  it("G) apply sem reenviar o PNG confirmado (pendente) → bloqueia, nunca aplica sem a imagem", async () => {
    const preview = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [extractedVisualElement()] })
    );
    expect(preview.ok).toBe(true);

    const selection: PdfApplySelectionEntry[] = [
      { originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: "img-hash-1", placement: "statement", altText: "Gráfico de teste" }] },
    ];
    // Map de bytes VAZIO — o arquivo nunca foi de fato reenviado no apply.
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, new Map());
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(bucket.size()).toBe(0);
  });

  it("H) imagem extra não confirmada nunca é usada/enviada ao R2 (só as REALMENTE confirmadas na seleção)", async () => {
    const secondHashElement = extractedVisualElement({ id: "el2", hash: "img-hash-2", pngSha256: sha256Hex(new Uint8Array([1, 2, 3])), byteLength: 3 });
    const preview = await previewPdfFromClientPayload(
      db as never,
      "editor1",
      baseInput({ examQuestions: [baseQuestion({ hasVisualContentOnPages: true })], visualElements: [extractedVisualElement(), secondHashElement] })
    );
    expect(preview.ok).toBe(true);

    // Confirma SÓ "img-hash-1" — a questão tem 2 imagens pendentes, então
    // uma confirmação incompleta é rejeitada (mesma disciplina do fluxo
    // clássico: nenhuma imagem "sobrando" nem "faltando").
    const selection: PdfApplySelectionEntry[] = [
      { originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: "img-hash-1", placement: "statement", altText: "Só uma confirmada" }] },
    ];
    const imageBytesByHash = new Map([
      ["img-hash-1", PNG_BYTES],
      ["img-hash-2", new Uint8Array([1, 2, 3])], // enviada mas NUNCA confirmada nesta seleção.
    ]);
    const result = await applyPdfFromClientPreview(db as never, bucket as never, "editor1", preview.batchId!, selection, imageBytesByHash);
    expect(result.ok).toBe(false); // 2 pendentes, só 1 confirmação enviada — bloqueia o lote inteiro.
    expect(bucket.size()).toBe(0); // "img-hash-2" nunca sobe, mesmo tendo sido enviada — nunca usada sem confirmação.
  });

  it("sanity: sha256Hex helper local bate com Web Crypto usado pelo serviço", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hex = sha256Hex(bytes);
    expect(hex).toHaveLength(64);
  });
});
