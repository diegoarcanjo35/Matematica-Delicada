// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleEditorialImportsRequest } from "../src/routes/editorialImports";
import { buildAnswerKeyPdf, buildExamPdf, buildFixturePdf } from "./pdfFixtureBuilder";

/* Sprint 22 — importador de PDF oficial do ENEM: RBAC, contrato HTTP,
   atomicidade/idempotência do apply e a garantia mais crítica da ordem —
   `correctAlternative` NUNCA nasce de outro lugar que não o PDF de
   gabarito, e apply NUNCA cria questão fora de `draft`. Mesmo padrão de
   worker/testing/editorialImportsRoutes.test.ts (Sprint 19): FakeD1Database
   real por trás, prova sempre por consulta DIRETA ao banco além da
   resposta HTTP. */

let db: FakeD1Database;
let bucket: FakeR2Bucket;

const PUBLISHED_PATTERN_ID = "pat-published";
const DRAFT_PATTERN_ID = "pat-draft";

beforeEach(() => {
  db = new FakeD1Database();
  bucket = new FakeR2Bucket();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${PUBLISHED_PATTERN_ID}', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${DRAFT_PATTERN_ID}', 'PAD-02', 'padrao-2', 'Padrão 2', 'F2', 'D2', 'E2', 'X2', 'R2', 'draft')`
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

const DEFAULT_IDENTITY = { year: "2019", application: "Aplicacao regular", booklet: "Caderno Azul" };

function buildPreviewFormData(overrides: {
  examPdf?: Uint8Array;
  answerKeyPdf?: Uint8Array;
  identity?: Partial<typeof DEFAULT_IDENTITY>;
  confirmation?: string;
} = {}): FormData {
  const identity = { ...DEFAULT_IDENTITY, ...overrides.identity };
  const form = new FormData();
  form.set("examPdf", new File([overrides.examPdf ?? buildExamPdf([1, 2])], "prova.pdf", { type: "application/pdf" }));
  form.set(
    "answerKeyPdf",
    new File(
      [overrides.answerKeyPdf ?? buildAnswerKeyPdf([[1, "C"], [2, "A"], [3, "B"], [4, "D"], [5, "E"], [6, "C"], [7, "A"], [8, "B"]])],
      "gabarito.pdf",
      { type: "application/pdf" }
    )
  );
  form.set("year", identity.year);
  form.set("application", identity.application);
  form.set("booklet", identity.booklet);
  form.set("confirmation", overrides.confirmation ?? "true");
  return form;
}

async function formDataToRequest(url: string, form: FormData, token: string | null): Promise<Request> {
  const serialized = new Response(form);
  const contentType = serialized.headers.get("content-type")!;
  const body = new Uint8Array(await serialized.arrayBuffer());
  const headers = new Headers({ "content-type": contentType, "content-length": String(body.byteLength) });
  if (token) headers.set("Cookie", `md_session=${token}`);
  return new Request(url, { method: "POST", body, headers });
}

async function previewPdfRoute(token: string | null, form: FormData): Promise<Response> {
  return callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/preview`, form, token));
}

interface PreviewBody {
  ok: boolean;
  batchId?: string;
  questions?: Array<{ originalNumber: number; correctAlternative: string | null; canApply: boolean; status: string; code: string }>;
  canApply?: boolean;
  error?: { code: string; message: string };
}

describe("Sprint 22 — RBAC do importador de PDF ENEM", () => {
  it("sem sessão responde 401", async () => {
    const response = await previewPdfRoute(null, buildPreviewFormData());
    expect(response.status).toBe(401);
  });

  it("usuário autenticado sem papel editorial responde 403", async () => {
    const token = await seedUserWithSession("student1");
    const response = await previewPdfRoute(token, buildPreviewFormData());
    expect(response.status).toBe(403);
  });

  it("editor consegue gerar prévia normalmente", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const response = await previewPdfRoute(token, buildPreviewFormData());
    expect(response.status).toBe(200);
    const body = (await response.json()) as PreviewBody;
    expect(body.ok).toBe(true);
  });
});

describe("Sprint 22 — contrato do preview", () => {
  it("exige confirmação explícita", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const response = await previewPdfRoute(token, buildPreviewFormData({ confirmation: "false" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as PreviewBody;
    expect(body.error?.code).toBe("pdf_confirmation_required");
  });

  it("questões prontas trazem correctAlternative EXATAMENTE igual ao gabarito, nunca inferido de outro lugar", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const response = await previewPdfRoute(token, buildPreviewFormData());
    const body = (await response.json()) as PreviewBody;
    const q1 = body.questions!.find((q) => q.originalNumber === 1)!;
    const q2 = body.questions!.find((q) => q.originalNumber === 2)!;
    expect(q1.correctAlternative).toBe("C");
    expect(q2.correctAlternative).toBe("A");
    expect(q1.status).toBe("ready");
    expect(q1.canApply).toBe(true);
  });

  it("questão sem entrada no gabarito nunca fica 'ready' e correctAlternative fica null", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    // Prova com 3 questões, gabarito só cobre 1 e 2 (mais preenchimento
    // irrelevante para não esbarrar no piso de needs_ocr) — questão 3 fica órfã.
    const examPdf = buildExamPdf([1, 2, 3]);
    const answerKeyPdf = buildAnswerKeyPdf([
      [1, "C"],
      [2, "A"],
      [101, "B"],
      [102, "D"],
      [103, "E"],
      [104, "C"],
    ]);
    const response = await previewPdfRoute(token, buildPreviewFormData({ examPdf, answerKeyPdf }));
    const body = (await response.json()) as PreviewBody;
    const q3 = body.questions!.find((q) => q.originalNumber === 3)!;
    expect(q3.correctAlternative).toBeNull();
    expect(q3.status).toBe("needs_review");
    expect(q3.canApply).toBe(false);
  });

  it("PDF sem camada de texto suficiente responde needs_ocr, nunca é tratado como estrutura ambígua comum", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const blankPdf = buildFixturePdf([[]]); // página sem nenhum texto
    const response = await previewPdfRoute(token, buildPreviewFormData({ examPdf: blankPdf }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as PreviewBody;
    expect(body.error?.code).toBe("pdf_needs_ocr_exam");
  });
});

describe("Sprint 22 — apply cria SEMPRE draft, nunca published, e exige padrão principal published", () => {
  async function previewAndGetBatch(token: string): Promise<{ batchId: string; questions: PreviewBody["questions"] }> {
    const response = await previewPdfRoute(token, buildPreviewFormData());
    const body = (await response.json()) as PreviewBody;
    return { batchId: body.batchId!, questions: body.questions };
  }

  async function applyPdfRoute(
    token: string,
    batchId: string,
    selection: Array<{ originalNumber: number; patternPrincipalId: string }>,
    overrides: { examPdf?: Uint8Array; answerKeyPdf?: Uint8Array; identity?: Partial<typeof DEFAULT_IDENTITY> } = {}
  ): Promise<Response> {
    const identity = { ...DEFAULT_IDENTITY, ...overrides.identity };
    const form = new FormData();
    form.set("batchId", batchId);
    form.set("examPdf", new File([overrides.examPdf ?? buildExamPdf([1, 2])], "prova.pdf", { type: "application/pdf" }));
    form.set(
      "answerKeyPdf",
      new File(
        [overrides.answerKeyPdf ?? buildAnswerKeyPdf([[1, "C"], [2, "A"], [3, "B"], [4, "D"], [5, "E"], [6, "C"], [7, "A"], [8, "B"]])],
        "gabarito.pdf",
        { type: "application/pdf" }
      )
    );
    form.set("year", identity.year);
    form.set("application", identity.application);
    form.set("booklet", identity.booklet);
    form.set("selection", JSON.stringify(selection));
    return callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/apply`, form, token));
  }

  it("aplica as questões selecionadas como draft — nunca published, mesmo com dados completos", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { batchId } = await previewAndGetBatch(token);

    const response = await applyPdfRoute(token, batchId, [
      { originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID },
      { originalNumber: 2, patternPrincipalId: PUBLISHED_PATTERN_ID },
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; appliedCount: number; questionIds: string[] };
    expect(body.appliedCount).toBe(2);

    const rows = db.sqlite.prepare(`SELECT id, editorial_status, origem, ano FROM questions WHERE id IN (${body.questionIds.map(() => "?").join(",")})`).all(...body.questionIds) as Array<{
      editorial_status: string;
      origem: string;
      ano: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.editorial_status === "draft")).toBe(true);
    expect(rows.every((r) => r.origem === "oficial")).toBe(true);
    expect(rows.every((r) => r.ano === 2019)).toBe(true);
  });

  it("rejeita apply quando o padrão principal escolhido não é published", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { batchId } = await previewAndGetBatch(token);

    const response = await applyPdfRoute(token, batchId, [{ originalNumber: 1, patternPrincipalId: DRAFT_PATTERN_ID }]);
    expect(response.status).toBe(409);
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(0);
  });

  it("apply é tudo-ou-nada: incluir uma questão needs_review na seleção bloqueia o lote inteiro (nenhuma questão criada)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const examPdf = buildExamPdf([1, 2, 3]); // questão 3 fica sem gabarito abaixo -> needs_review
    const answerKeyPdf = buildAnswerKeyPdf([
      [1, "C"],
      [2, "A"],
      [101, "B"],
      [102, "D"],
      [103, "E"],
      [104, "C"],
    ]);
    const previewResponse = await previewPdfRoute(token, buildPreviewFormData({ examPdf, answerKeyPdf }));
    const { batchId } = (await previewResponse.json()) as PreviewBody;

    const response = await applyPdfRoute(
      token,
      batchId,
      [
        { originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID },
        { originalNumber: 3, patternPrincipalId: PUBLISHED_PATTERN_ID }, // needs_review
      ],
      { examPdf, answerKeyPdf }
    );
    expect(response.status).toBe(409);
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(0); // nem a questão 1, que sozinha estaria pronta, foi criada.
  });

  it("apply idempotente: reenviar o MESMO lote/seleção não duplica questão", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { batchId } = await previewAndGetBatch(token);
    const selection = [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }];

    const first = await applyPdfRoute(token, batchId, selection);
    expect(first.status).toBe(200);
    const second = await applyPdfRoute(token, batchId, selection);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ok: true; alreadyApplied: boolean };
    expect(secondBody.alreadyApplied).toBe(true);

    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(1);
  });

  it("apply rejeita quando os PDFs reenviados não são byte-a-byte os mesmos do preview (fingerprint mismatch)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { batchId } = await previewAndGetBatch(token);

    const differentExamPdf = buildExamPdf([1, 2, 99]); // conteúdo diferente do preview
    const response = await applyPdfRoute(token, batchId, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }], { examPdf: differentExamPdf });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pdf_fingerprint_mismatch");
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(0);
  });

  it("apply rejeita quando a identidade do exame reenviada diverge da prévia (ano diferente) — fail-closed", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { batchId } = await previewAndGetBatch(token);

    const response = await applyPdfRoute(token, batchId, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }], { identity: { year: "2020" } });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pdf_identity_mismatch");
  });

  it("undo genérico funciona sobre um lote PDF aplicado (todas as questões ainda draft)", async () => {
    const editorToken = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    grantRole("editor1", "admin");
    const { batchId } = await previewAndGetBatch(editorToken);
    await applyPdfRoute(editorToken, batchId, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }]);

    const undoRequest = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/${batchId}/undo`, {
      method: "POST",
      headers: { Cookie: `md_session=${editorToken}` },
    });
    const undoResponse = await callRoute(undoRequest);
    expect(undoResponse.status).toBe(200);
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(0);
  });
});
