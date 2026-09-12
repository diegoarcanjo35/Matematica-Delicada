// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleEditorialImportsRequest } from "../src/routes/editorialImports";
import { buildAnswerKeyPdf, buildFixturePdfWithVisuals, type FixtureImageSpec, type FixturePageSpec } from "./pdfFixtureBuilder";
import { extractPdfPages } from "../src/lib/pdfEnemExtractor";
import { segmentExamQuestions } from "../src/lib/pdfEnemSegmenter";
import { buildPreviewQuestions } from "../src/lib/pdfEnemMatch";
import { validateExamIdentityInput } from "../src/lib/pdfEnemExamIdentity";
import { placeVisualElement } from "../src/lib/pdfEnemVisualPlacement";
import { classifyDecorativeRasterElements, isStructurallyRepeated } from "../src/lib/pdfEnemVisualExtractor";
import type { RawVisualElement } from "../src/lib/pdfEnemVisualModel";

/* Sprint 23 — extração automática e segura de imagens/gráficos do PDF.
   Cobre: extração raster real (via pdfjs-dist, fixture com XObject de
   imagem sem filtro), detecção de vetor (constructPath real), decorativo
   (mesmo hash repetido em muitas páginas), placement por posição,
   prontidão (visualReviewRequired/hasPendingVisualConfirmation), e o
   fluxo HTTP completo de apply com confirmação de imagem obrigatória
   (upload R2 real via addQuestionImage, alt text validado, placement
   nunca "unknown", idempotência). */

function smallImage(seed = 0): FixtureImageSpec {
  const rgbBytes: number[] = [];
  for (let i = 0; i < 4 * 4 * 3; i++) rgbBytes.push((i * 7 + seed) % 100);
  return { afterLineIndex: 1, width: 4, height: 4, rgbBytes };
}

/** Bytes VERDADEIRAMENTE incompressíveis (crypto.getRandomValues, nunca um
 *  LCG — um LCG de baixa qualidade tem bits baixos previsíveis, e DEFLATE
 *  aproveita essa estrutura escondida para comprimir bem mais do que
 *  dados realmente aleatórios; confirmado empiricamente nesta sprint: um
 *  LCG "ANSI C" clássico com `% 128` produziu um PNG de ~426KB a partir de
 *  ~14.5MB crus). Mascarado para 0-127 (ASCII puro, exigido pelo builder
 *  de fixture). Gerado em pedaços de 64KB — `crypto.getRandomValues` tem
 *  um teto de tamanho por chamada. */
function randomAsciiSafeBytes(count: number): number[] {
  const bytes = new Array<number>(count);
  const CHUNK = 65536;
  const buf = new Uint8Array(CHUNK);
  for (let offset = 0; offset < count; offset += CHUNK) {
    const size = Math.min(CHUNK, count - offset);
    crypto.getRandomValues(size === CHUNK ? buf : buf.subarray(0, size));
    for (let i = 0; i < size; i++) bytes[offset + i] = buf[i] & 0x7f;
  }
  return bytes;
}

function questionPage(number: number, images: FixtureImageSpec[] = []): FixturePageSpec {
  return {
    lines: [`QUESTAO ${number}`, "Enunciado tecnico.", "A. Alt A", "B. Alt B", "C. Alt C", "D. Alt D", "E. Alt E"],
    images,
  };
}

describe("Sprint 23 — extração raster (pdfEnemVisualExtractor + pdfEnemExtractor integrados)", () => {
  it("extrai e codifica PNG de uma imagem raster embutida (XObject sem filtro)", async () => {
    const pdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raster = result.visualElements.filter((e) => e.kind === "raster");
    expect(raster).toHaveLength(1);
    expect(raster[0].extractionStatus).toBe("extracted");
    expect(raster[0].mime).toBe("image/png");
    expect(raster[0].byteLength).toBeGreaterThan(0);
  });

  it("2 imagens na mesma questão são extraídas independentemente (hashes diferentes)", async () => {
    const pdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage(0), { ...smallImage(50), afterLineIndex: 3, xOffset: 200 }])]);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raster = result.visualElements.filter((e) => e.kind === "raster" && e.extractionStatus === "extracted");
    expect(raster).toHaveLength(2);
    expect(raster[0].hash).not.toBe(raster[1].hash);
  });

  it("página sem nenhum visual não produz elementos raster/vector reais", async () => {
    const pdf = buildFixturePdfWithVisuals([questionPage(1)]);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualElements.filter((e) => e.extractionStatus !== "ignored_decorative")).toHaveLength(0);
  });
});

describe("Sprint 23 — decorativo/estrutural (seção 5/6 da ordem)", () => {
  it("mesma imagem repetida em muitas páginas é classificada como decorativa e excluída", async () => {
    const totalPages = 10;
    const repeatedImage = smallImage(1);
    const pages: FixturePageSpec[] = [];
    for (let n = 1; n <= totalPages; n++) pages.push(questionPage(n, [repeatedImage]));
    const pdf = buildFixturePdfWithVisuals(pages);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raster = result.visualElements.filter((e) => e.kind === "raster");
    expect(raster.length).toBe(totalPages);
    expect(raster.every((e) => e.extractionStatus === "ignored_decorative")).toBe(true);
  });

  it("imagem única (não repetida) nunca é marcada decorativa mesmo em documento grande", async () => {
    const totalPages = 10;
    const pages: FixturePageSpec[] = [];
    for (let n = 1; n <= totalPages; n++) pages.push(questionPage(n, n === 5 ? [smallImage(99)] : []));
    const pdf = buildFixturePdfWithVisuals(pages);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raster = result.visualElements.filter((e) => e.kind === "raster");
    expect(raster).toHaveLength(1);
    expect(raster[0].extractionStatus).toBe("extracted");
  });

  it("isStructurallyRepeated: nunca aciona com menos de 3 páginas totais (sem repetição possível)", () => {
    expect(isStructurallyRepeated(2, 2)).toBe(false);
    expect(isStructurallyRepeated(1, 1)).toBe(false);
  });

  it("isStructurallyRepeated: exige AMBOS os limiares (contagem mínima E fração mínima)", () => {
    // 3 de 100 páginas: bate a contagem mínima (3) mas não os 15% (exigiria 15).
    expect(isStructurallyRepeated(3, 100)).toBe(false);
    // 20 de 100: bate os dois.
    expect(isStructurallyRepeated(20, 100)).toBe(true);
  });

  it("classifyDecorativeRasterElements nunca marca decorativo um hash que aparece numa ÚNICA página", () => {
    const elements: RawVisualElement[] = [
      { id: "a", pageNumber: 1, kind: "raster", x: 0, y: 0, width: 1, height: 1, hash: "h1", extractionStatus: "extracted", placementCandidate: "unknown", warnings: [] },
    ];
    classifyDecorativeRasterElements(elements, 50);
    expect(elements[0].extractionStatus).toBe("extracted");
  });
});

describe("Sprint 23 — associação visual → questão (pdfEnemVisualPlacement)", () => {
  it("posiciona imagem dentro do enunciado quando cai antes das alternativas", async () => {
    const pdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]); // afterLineIndex 1 = logo após o enunciado
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { questions } = segmentExamQuestions(result.pages);
    const image = result.visualElements.find((e) => e.kind === "raster")!;
    const centerY = image.y + image.height / 2;
    const placement = placeVisualElement(image.pageNumber, centerY, questions);
    expect(placement.ownerQuestionNumber).toBe(1);
    expect(placement.placement).toBe("statement");
  });

  it("posiciona imagem dentro de uma alternativa quando cai na faixa Y dela", async () => {
    const img: FixtureImageSpec = { afterLineIndex: 4, width: 4, height: 4, rgbBytes: smallImage().rgbBytes }; // após a linha "C. Alt C"
    const pdf = buildFixturePdfWithVisuals([questionPage(1, [img])]);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { questions } = segmentExamQuestions(result.pages);
    const image = result.visualElements.find((e) => e.kind === "raster")!;
    const centerY = image.y + image.height / 2;
    const placement = placeVisualElement(image.pageNumber, centerY, questions);
    expect(placement.ownerQuestionNumber).toBe(1);
    expect(placement.placement).toBe("option_C");
  });

  it("elemento fora de qualquer faixa Y reconhecida vira unknown, nunca chuta", () => {
    const placement = placeVisualElement(999, 12345, []);
    expect(placement.ownerQuestionNumber).toBeNull();
    expect(placement.placement).toBe("unknown");
  });
});

describe("Sprint 23 — prontidão (buildPreviewQuestions com elementos visuais)", () => {
  const identity = validateExamIdentityInput({ year: 2019, application: "Aplicacao regular", booklet: "Caderno Azul" }).identity!;

  it("questão com imagem extraída e posicionada nunca fica 'ready' automaticamente (hasPendingVisualConfirmation)", async () => {
    const pdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    const answerKey = new Map([[1, "C" as const]]);
    const { items } = await buildPreviewQuestions(questions, answerKey, identity, new Set(), new Set(), extract.visualElements);
    const q1 = items.find((i) => i.originalNumber === 1)!;
    expect(q1.hasPendingVisualConfirmation).toBe(true);
    expect(q1.visualReviewRequired).toBe(false);
    expect(q1.status).toBe("needs_review");
    expect(q1.visualElements).toHaveLength(1);
  });

  it("questão com diagrama vetorial não-decorativo fica visualReviewRequired=true (mesmo sem nenhum bitmap)", async () => {
    const pdf = buildFixturePdfWithVisuals([{ lines: questionPage(1).lines, vectors: [{ afterLineIndex: 1, width: 6, height: 6 }] }]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    const answerKey = new Map([[1, "C" as const]]);
    const { items } = await buildPreviewQuestions(questions, answerKey, identity, new Set(), new Set(), extract.visualElements);
    const q1 = items.find((i) => i.originalNumber === 1)!;
    expect(q1.visualReviewRequired).toBe(true);
    expect(q1.canApply).toBe(false);
  });

  it("questão sem nenhum visual continua funcionando exatamente como antes (regressão Sprint 22)", async () => {
    const pdf = buildFixturePdfWithVisuals([questionPage(1)]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    const answerKey = new Map([[1, "C" as const]]);
    const { items } = await buildPreviewQuestions(questions, answerKey, identity, new Set(), new Set(), extract.visualElements);
    const q1 = items.find((i) => i.originalNumber === 1)!;
    expect(q1.visualReviewRequired).toBe(false);
    expect(q1.hasPendingVisualConfirmation).toBe(false);
    expect(q1.status).toBe("ready");
    expect(q1.canApply).toBe(true);
  });
});

/* --------------------- Fluxo HTTP completo (FakeD1 + FakeR2) --------------------- */

let db: FakeD1Database;
let bucket: FakeR2Bucket;
const PUBLISHED_PATTERN_ID = "pat-published-v23";

beforeEach(() => {
  db = new FakeD1Database();
  bucket = new FakeR2Bucket();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${PUBLISHED_PATTERN_ID}', 'PAD-V23', 'padrao-v23', 'Padrao V23', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
});

async function seedUserWithSession(id: string): Promise<string> {
  await createUser(db as never, { id, name: "Usuária Teste", email: `${id}@teste.dev`, emailNormalized: `${id}@teste.dev`, passwordHash: await hashPassword("senha-teste-123") });
  const rawToken = `session-token-${id}`;
  await createSession(db as never, {
    id: `${id}-session`,
    userId: id,
    tokenHash: await sha256Hex(rawToken),
    sessionVersion: 1,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userAgent: null,
  });
  return rawToken;
}

function grantRole(userId: string, role: "editor" | "admin"): void {
  db.sqlite.exec(`INSERT OR IGNORE INTO roles (id, name) VALUES ('role-${role}', '${role}')`);
  db.sqlite.exec(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id) VALUES ('ur-${userId}-${role}', '${userId}', 'role-${role}')`);
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", QUESTION_MEDIA: bucket as never };
}

async function callRoute(request: Request): Promise<Response> {
  return (await handleEditorialImportsRequest(request, localEnv(), new URL(request.url)))!;
}

async function formDataToRequest(url: string, form: FormData, token: string | null): Promise<Request> {
  const serialized = new Response(form);
  const contentType = serialized.headers.get("content-type")!;
  const body = new Uint8Array(await serialized.arrayBuffer());
  const headers = new Headers({ "content-type": contentType, "content-length": String(body.byteLength) });
  if (token) headers.set("Cookie", `md_session=${token}`);
  return new Request(url, { method: "POST", body, headers });
}

const DEFAULT_IDENTITY = { year: "2019", application: "Aplicacao regular", booklet: "Caderno Azul" };

function buildImagePreviewForm(examPdf: Uint8Array): FormData {
  const form = new FormData();
  form.set("examPdf", new File([examPdf], "prova.pdf", { type: "application/pdf" }));
  form.set("answerKeyPdf", new File([buildAnswerKeyPdf([[1, "C"], [2, "A"], [3, "B"], [4, "D"], [5, "E"], [6, "C"], [7, "A"], [8, "B"]])], "gabarito.pdf", { type: "application/pdf" }));
  form.set("year", DEFAULT_IDENTITY.year);
  form.set("application", DEFAULT_IDENTITY.application);
  form.set("booklet", DEFAULT_IDENTITY.booklet);
  form.set("confirmation", "true");
  return form;
}

interface HttpVisualElementBody {
  hash: string;
  kind: string;
  extractionStatus: string;
  placementCandidate: string;
  thumbnailDataUri?: string;
}
interface PreviewQuestionBody {
  originalNumber: number;
  hasPendingVisualConfirmation: boolean;
  visualReviewRequired: boolean;
  visualElements: HttpVisualElementBody[];
}
interface PreviewBody {
  ok: boolean;
  batchId?: string;
  questions?: PreviewQuestionBody[];
  error?: { code: string; message: string };
}

async function applyImagePdfRoute(
  token: string,
  batchId: string,
  examPdf: Uint8Array,
  selection: Array<{ originalNumber: number; patternPrincipalId: string; visualConfirmations?: Array<{ elementHash: string; placement: string; altText: string }> }>
): Promise<Response> {
  const form = new FormData();
  form.set("batchId", batchId);
  form.set("examPdf", new File([examPdf], "prova.pdf", { type: "application/pdf" }));
  form.set("answerKeyPdf", new File([buildAnswerKeyPdf([[1, "C"], [2, "A"], [3, "B"], [4, "D"], [5, "E"], [6, "C"], [7, "A"], [8, "B"]])], "gabarito.pdf", { type: "application/pdf" }));
  form.set("year", DEFAULT_IDENTITY.year);
  form.set("application", DEFAULT_IDENTITY.application);
  form.set("booklet", DEFAULT_IDENTITY.booklet);
  form.set("selection", JSON.stringify(selection));
  return callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/apply`, form, token));
}

interface ApplyBody {
  ok: boolean;
  appliedCount?: number;
  questionIds?: string[];
  alreadyApplied?: boolean;
  imageUploadFailures?: string[];
  error?: { code: string; message: string };
}

describe("Sprint 23 — preview HTTP nunca escreve no R2, sempre traz thumbnail", () => {
  it("preview com imagem: resposta traz thumbnailDataUri, bucket R2 continua vazio", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const pdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const response = await callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/preview`, buildImagePreviewForm(pdf), token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PreviewBody;
    const q1 = body.questions!.find((q) => q.originalNumber === 1)!;
    expect(q1.hasPendingVisualConfirmation).toBe(true);
    expect(q1.visualElements).toHaveLength(1);
    expect(q1.visualElements[0].thumbnailDataUri).toMatch(/^data:image\/png;base64,/);
    // Nenhum GET no bucket deveria achar nada — preview nunca grava R2.
    expect(await bucket.get(`questions/anything/${q1.visualElements[0].hash}.png`)).toBeNull();
  });
});

async function previewAndGetBatch(examPdf: Uint8Array, token: string) {
  const response = await callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/preview`, buildImagePreviewForm(examPdf), token));
  const body = (await response.json()) as PreviewBody;
  return body;
}

describe("Sprint 23 — apply exige confirmação de imagem (seção 8/10/11 da ordem)", () => {

  it("apply sem visualConfirmations para questão com imagem pendente é bloqueado (409)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);

    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }]);
    expect(response.status).toBe(409);
    const body = (await response.json()) as ApplyBody;
    expect(body.error?.code).toBe("pdf_conflict");
  });

  it("apply com placement 'unknown' na confirmação é rejeitado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;

    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, [
      { originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "unknown", altText: "Descricao valida" }] },
    ]);
    expect(response.status).toBe(409);
  });

  it("apply com alt text vazio é rejeitado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;

    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, [
      { originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "" }] },
    ]);
    expect(response.status).toBe(409);
  });

  it("apply com confirmação completa e válida cria question_images e sobe o PNG real no R2", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;

    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, [
      { originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "Diagrama tecnico de teste." }] },
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApplyBody;
    expect(body.ok).toBe(true);
    expect(body.imageUploadFailures ?? []).toHaveLength(0);
    const questionId = body.questionIds![0];

    const imageRow = db.sqlite.prepare("SELECT * FROM question_images WHERE question_id = ?").get(questionId) as { asset_ref: string; alt_text: string; placement: string } | undefined;
    expect(imageRow).toBeDefined();
    expect(imageRow!.placement).toBe("enunciado");
    expect(imageRow!.alt_text).toBe("Diagrama tecnico de teste.");

    const stored = await bucket.get(imageRow!.asset_ref);
    expect(stored).not.toBeNull();
  });

  it("questão com diagrama vetorial não-decorativo nunca é aplicável, mesmo tentando confirmar", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([{ lines: questionPage(1).lines, vectors: [{ afterLineIndex: 1, width: 6, height: 6 }] }]);
    const preview = await previewAndGetBatch(examPdf, token);
    expect(preview.questions!.find((q) => q.originalNumber === 1)!.visualReviewRequired).toBe(true);

    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }]);
    expect(response.status).toBe(409);
  });

  it("retry do mesmo apply já aplicado é idempotente — nunca duplica question_images", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;
    const selection = [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "Diagrama tecnico de teste." }] }];

    const first = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
    expect(first.status).toBe(200);
    const second = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ApplyBody;
    expect(secondBody.alreadyApplied).toBe(true);

    const count = db.sqlite.prepare("SELECT COUNT(*) as c FROM question_images").get() as { c: number };
    expect(count.c).toBe(1);
  });
});

/* ------------------- Sprint 23.1 — atomicidade R2/D1 (blocos A-I) ------------------- */

function questionsCount(): number {
  return (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
}
function questionImagesCount(): number {
  return (db.sqlite.prepare("SELECT COUNT(*) as c FROM question_images").get() as { c: number }).c;
}
async function batchStatus(batchId: string): Promise<string> {
  const row = db.sqlite.prepare("SELECT status FROM question_import_batches WHERE id = ?").get(batchId) as { status: string } | undefined;
  return row?.status ?? "(not found)";
}

describe("Sprint 23.1 — atomicidade R2 -> D1 (bloco A-I da ordem)", () => {
  async function previewTwoImageQuestion(token: string) {
    const twoImages: FixtureImageSpec[] = [smallImage(0), { ...smallImage(50), afterLineIndex: 3, xOffset: 200 }];
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, twoImages)]);
    const preview = await previewAndGetBatch(examPdf, token);
    const q1 = preview.questions!.find((q) => q.originalNumber === 1)!;
    const hashes = q1.visualElements.map((e) => e.hash);
    const selection = [
      {
        originalNumber: 1,
        patternPrincipalId: PUBLISHED_PATTERN_ID,
        visualConfirmations: hashes.map((h, i) => ({ elementHash: h, placement: i === 0 ? "statement" : "option_A", altText: `Descricao ${i}` })),
      },
    ];
    return { examPdf, batchId: preview.batchId!, selection };
  }

  it("A. R2 put falha na primeira imagem -> zero questions criadas, batch continua previewed", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;
    const selection = [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "Descricao" }] }];

    bucket.failNthPut(0); // a PRIMEIRA chamada a put() falha.
    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);

    expect(response.status).toBe(409);
    expect(questionsCount()).toBe(0);
    expect(await batchStatus(preview.batchId!)).toBe("previewed");
  });

  it("B. R2 put falha na segunda de duas imagens -> zero questions, zero question_images, órfão da primeira pode permanecer", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { examPdf, batchId, selection } = await previewTwoImageQuestion(token);

    bucket.failNthPut(1); // a SEGUNDA chamada a put() falha (a primeira já foi bem-sucedida).
    const response = await applyImagePdfRoute(token, batchId, examPdf, selection);

    expect(response.status).toBe(409);
    expect(questionsCount()).toBe(0);
    expect(questionImagesCount()).toBe(0);
    expect(await batchStatus(batchId)).toBe("previewed");
    // órfão aceitável: não afirmamos nem exigimos que o primeiro objeto
    // tenha sido limpo — seção 3 da ordem proíbe explicitamente apagar
    // objetos determinísticos em falha ambígua.
  });

  it("C. R2 uploads todos passam + D1 falha -> nenhuma question persistida, batch continua previewed, objetos R2 podem permanecer", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;
    const selection = [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "Descricao" }] }];

    db.failNextMatching(/INSERT INTO questions/);
    // A exceção do D1 propaga (não é um "conflict" de negócio controlado —
    // mesmo padrão já usado no resto do serviço para falha real do banco,
    // capturada pelo try/catch do handler HTTP GLOBAL em produção —
    // `handleEditorialImportsRequest` chamado diretamente aqui, sem esse
    // wrapper, então o teste captura a exceção explicitamente para
    // verificar as invariantes reais: nada foi persistido, o lote continua
    // `previewed`).
    await expect(applyImagePdfRoute(token, preview.batchId!, examPdf, selection)).rejects.toThrow("forced_failure_for_test");

    expect(questionsCount()).toBe(0);
    expect(questionImagesCount()).toBe(0);
    expect(await batchStatus(preview.batchId!)).toBe("previewed");
    // O put() do R2 JÁ aconteceu antes do db.batch() — o objeto físico pode
    // ter permanecido no bucket; nunca tentamos limpá-lo (seção 3).
  });

  it("D. retry apos cenario A -> uploads tentados de novo, sucesso cria questao + image", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;
    const selection = [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "Descricao" }] }];

    bucket.failNthPut(0);
    const first = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
    expect(first.status).toBe(409);
    expect(questionsCount()).toBe(0);

    // Retry — a falha injetada já foi consumida (failNthPut é de uso único),
    // então este put() vai passar normalmente.
    const second = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
    expect(second.status).toBe(200);
    expect(questionsCount()).toBe(1);
    expect(questionImagesCount()).toBe(1);
    expect(await batchStatus(preview.batchId!)).toBe("applied");
  });

  it("E. apply bem-sucedido com 2 imagens -> 2 objetos R2, 2 question_images", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { examPdf, batchId, selection } = await previewTwoImageQuestion(token);

    const response = await applyImagePdfRoute(token, batchId, examPdf, selection);
    expect(response.status).toBe(200);
    expect(questionImagesCount()).toBe(2);

    const rows = db.sqlite.prepare("SELECT asset_ref FROM question_images").all() as Array<{ asset_ref: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(await bucket.get(row.asset_ref)).not.toBeNull();
    }
  });

  it("F. retry apos sucesso -> alreadyApplied=true, nenhum put R2 duplicado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1, [smallImage()])]);
    const preview = await previewAndGetBatch(examPdf, token);
    const hash = preview.questions!.find((q) => q.originalNumber === 1)!.visualElements[0].hash;
    const selection = [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID, visualConfirmations: [{ elementHash: hash, placement: "statement", altText: "Descricao" }] }];

    const first = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
    expect(first.status).toBe(200);
    const assetRef = (db.sqlite.prepare("SELECT asset_ref FROM question_images").get() as { asset_ref: string }).asset_ref;

    // Se o retry tentasse subir de novo com uma key ALEATÓRIA, o put()
    // apareceria como um objeto novo; como a rota de retry nem chega a
    // reconstruir o plano de upload (curto-circuita em `alreadyApplied`
    // antes disso), a MESMA key/objeto de antes é a única evidência —
    // continua presente e sem irmãos.
    bucket.failNthPut(0); // se ALGUM put() acontecesse no retry, este forçaria uma falha visível.
    const second = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ApplyBody;
    expect(secondBody.alreadyApplied).toBe(true);
    expect(questionImagesCount()).toBe(1);
    expect(await bucket.get(assetRef)).not.toBeNull();
  });

  /** Imagem com dados verdadeiramente incompressíveis, dimensionada para
   *  produzir um PNG final de aproximadamente `targetBytes` — usada para
   *  testar o limite de 15MB no limiar real. Cada imagem individual FICA
   *  sempre abaixo de MAX_IMAGE_UPLOAD_BYTES (8MB, seção 11 da ordem
   *  original) — o teste dos 15MB só pode ser exercitado com MAIS DE UMA
   *  imagem, já que uma única imagem nunca passa isolada do teto
   *  individual. */
  function bigImageAt(afterLineIndex: number, xOffset: number, targetFinalPngBytes: number): FixtureImageSpec {
    // Bytes mascarados para 0-127 (7 bits) têm exatamente 128 símbolos
    // possíveis — mesmo sendo "aleatórios" bit a bit, DEFLATE/Huffman
    // ainda consegue codificar cada um em ~7 bits, uma razão medida
    // empiricamente nesta sprint (~0.877 do tamanho cru, reproduzível:
    // testado com múltiplos tamanhos de imagem, sempre dentro de ±1%).
    const MEASURED_COMPRESSION_RATIO = 0.877;
    const rawBytesNeeded = Math.ceil(targetFinalPngBytes / MEASURED_COMPRESSION_RATIO);
    const side = Math.ceil(Math.sqrt(rawBytesNeeded / 3));
    const rgbBytes = randomAsciiSafeBytes(side * side * 3);
    return { afterLineIndex, xOffset, width: side, height: side, rgbBytes, displayWidth: 4, displayHeight: 4 };
  }

  it(
    "G. total visual PERTO do limite de 15MB (mas abaixo, cada imagem abaixo de 8MB) -> permitido",
    async () => {
      const token = await seedUserWithSession("editor1");
      grantRole("editor1", "editor");
      // 2 imagens de ~7.3MB cada (~14.6MB somados) — cada uma
      // confortavelmente abaixo do teto individual de 8MB, a SOMA
      // confortavelmente abaixo do teto total de 15MB.
      const images = [bigImageAt(1, 0, 7_000_000), bigImageAt(3, 200, 7_000_000)];
      const examPdf = buildFixturePdfWithVisuals([questionPage(1, images)]);
      const preview = await previewAndGetBatch(examPdf, token);
      const item = preview.questions!.find((q) => q.originalNumber === 1)!;
      const elements = item.visualElements;
      expect(elements).toHaveLength(2);
      for (const el of elements) expect(el.extractionStatus).toBe("extracted");
      const total = elements.reduce((sum, el) => sum + (el.byteLength ?? 0), 0);
      expect(total).toBeLessThan(15 * 1024 * 1024);
      expect(elements.every((el) => (el.byteLength ?? 0) < 8 * 1024 * 1024)).toBe(true);

      const selection = [
        {
          originalNumber: 1,
          patternPrincipalId: PUBLISHED_PATTERN_ID,
          visualConfirmations: elements.map((el, i) => ({ elementHash: el.hash, placement: i === 0 ? "statement" : "option_A", altText: `Descricao ${i}` })),
        },
      ];
      const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
      expect(response.status).toBe(200);
      expect(questionImagesCount()).toBe(2);
    },
    30000
  );

  it(
    "H. total visual acima de 15MB (cada imagem individualmente abaixo de 8MB) -> bloqueado, zero R2 puts, zero D1 writes",
    async () => {
      const token = await seedUserWithSession("editor1");
      grantRole("editor1", "editor");
      // 2 imagens de ~7.9MB cada (~15.4-15.8MB somados) — cada uma AINDA
      // abaixo do teto individual de 8MB (nunca bloqueadas por esse
      // motivo), mas a SOMA excede o teto total de 15MB — prova que é o
      // limite TOTAL do lote (nunca o individual) sendo exercitado aqui.
      const images = [bigImageAt(1, 0, 8_100_000), bigImageAt(3, 200, 8_100_000)];
      const examPdf = buildFixturePdfWithVisuals([questionPage(1, images)]);

      const preview = await previewAndGetBatch(examPdf, token);
      const item = preview.questions!.find((q) => q.originalNumber === 1)!;
      const elements = item.visualElements;
      expect(elements).toHaveLength(2);
      for (const el of elements) {
        expect(el.extractionStatus).toBe("extracted");
        expect(el.byteLength ?? 0).toBeLessThan(8 * 1024 * 1024); // nenhuma das duas, isolada, excede o teto individual.
      }
      const total = elements.reduce((sum, el) => sum + (el.byteLength ?? 0), 0);
      expect(total).toBeGreaterThan(15 * 1024 * 1024); // a SOMA das duas excede o teto total — é isso que o teste prova.

      let putCalls = 0;
      const originalPut = bucket.put.bind(bucket);
      bucket.put = (async (...args: Parameters<typeof bucket.put>) => {
        putCalls++;
        return originalPut(...args);
      }) as typeof bucket.put;

      const selection = [
        {
          originalNumber: 1,
          patternPrincipalId: PUBLISHED_PATTERN_ID,
          visualConfirmations: elements.map((el, i) => ({ elementHash: el.hash, placement: i === 0 ? "statement" : "option_A", altText: `Descricao ${i}` })),
        },
      ];
      const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, selection);
      const body = (await response.json()) as ApplyBody & { error?: { code: string } };

      expect(response.status).toBe(413);
      expect(body.error?.code).toBe("pdf_visual_bytes_exceeded");
      expect(putCalls).toBe(0); // zero R2 puts — bloqueado ANTES de qualquer upload.
      expect(questionsCount()).toBe(0); // zero D1 writes.
      expect(questionImagesCount()).toBe(0);
      expect(await batchStatus(preview.batchId!)).toBe("previewed");

      bucket.put = originalPut;
    },
    30000
  );

  it("I. questão sem imagem -> fluxo antigo continua funcionando", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildFixturePdfWithVisuals([questionPage(1)]);
    const answerKeyPdf = buildAnswerKeyPdf([[1, "C"], [2, "A"], [3, "B"], [4, "D"], [5, "E"], [6, "C"], [7, "A"], [8, "B"]]);
    const form = new FormData();
    form.set("examPdf", new File([examPdf], "prova.pdf", { type: "application/pdf" }));
    form.set("answerKeyPdf", new File([answerKeyPdf], "gabarito.pdf", { type: "application/pdf" }));
    form.set("year", DEFAULT_IDENTITY.year);
    form.set("application", DEFAULT_IDENTITY.application);
    form.set("booklet", DEFAULT_IDENTITY.booklet);
    form.set("confirmation", "true");
    const previewResponse = await callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/preview`, form, token));
    const preview = (await previewResponse.json()) as PreviewBody;

    const response = await applyImagePdfRoute(token, preview.batchId!, examPdf, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }]);
    expect(response.status).toBe(200);
    expect(questionsCount()).toBe(1);
    expect(questionImagesCount()).toBe(0);
  });
});
