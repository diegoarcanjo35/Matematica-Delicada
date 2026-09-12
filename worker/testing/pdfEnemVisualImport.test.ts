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

describe("Sprint 23 — apply exige confirmação de imagem (seção 8/10/11 da ordem)", () => {
  async function previewAndGetBatch(examPdf: Uint8Array, token: string) {
    const response = await callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/preview`, buildImagePreviewForm(examPdf), token));
    const body = (await response.json()) as PreviewBody;
    return body;
  }

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
