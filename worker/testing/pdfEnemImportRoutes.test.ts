// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleEditorialImportsRequest } from "../src/routes/editorialImports";
import { buildAnswerKeyPdf, buildAnswerKeyPdfWithIdentity, buildExamPdf, buildExamPdfWithHeader, buildFixturePdf } from "./pdfFixtureBuilder";
import { computeQuestionFingerprint } from "../src/lib/fingerprint";

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
  identity?: Partial<typeof DEFAULT_IDENTITY> & { sourceUrl?: string };
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
  if (overrides.identity?.sourceUrl) form.set("sourceUrl", overrides.identity.sourceUrl);
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

async function applyPdfRoute(
  token: string,
  batchId: string,
  selection: Array<{ originalNumber: number; patternPrincipalId: string; reviewedStatement?: string; reviewedAlternatives?: Array<{ letter: string; text: string }> }>,
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

describe("Sprint 22 — apply cria SEMPRE draft, nunca published, e exige padrão principal published", () => {
  async function previewAndGetBatch(token: string): Promise<{ batchId: string; questions: PreviewBody["questions"] }> {
    const response = await previewPdfRoute(token, buildPreviewFormData());
    const body = (await response.json()) as PreviewBody;
    return { batchId: body.batchId!, questions: body.questions };
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

describe("Sprint 22.1 — TESTE ADVERSARIAL OBRIGATORIO de identidade documental (secao 4 da ordem)", () => {
  it("prova com cabecalho 'Caderno 7 Azul' x gabarito com cabecalho 'Caderno 8 Rosa': preview vem com canApply=false mesmo com o editor confirmando 'Caderno 7 Azul', e apply e rejeitado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");

    const examPdf = buildExamPdfWithHeader([136, 137], { day: 2, bookletNumber: 7, color: "AZUL" });
    const answerKeyPdf = buildAnswerKeyPdfWithIdentity(
      [[136, "C"], [137, "A"], [101, "B"], [102, "D"], [103, "E"], [104, "C"]],
      { day: 2, bookletNumber: 8, color: "ROSA", year: 2019 } // caderno/cor DIVERGENTE de propósito
    );

    const form = buildPreviewFormData({ examPdf, answerKeyPdf, identity: { booklet: "Caderno 7 Azul" } });
    const previewResponse = await previewPdfRoute(token, form);
    expect(previewResponse.status).toBe(200);
    const body = (await previewResponse.json()) as PreviewBody & { documentIdentityCheck?: { ok: boolean; messages: string[] }; globalWarnings?: string[] };
    expect(body.canApply).toBe(false); // NUNCA aplicavel mesmo com questoes estruturalmente prontas
    expect(body.documentIdentityCheck?.ok).toBe(false);
    expect(body.documentIdentityCheck?.messages.some((m) => m.includes("Caderno divergente"))).toBe(true);
    expect((body.globalWarnings ?? []).some((w) => w.includes("Caderno divergente"))).toBe(true);

    // Mesmo que o editor insista e tente aplicar mesmo assim.
    const applyForm = new FormData();
    applyForm.set("batchId", body.batchId!);
    applyForm.set("examPdf", new File([examPdf], "prova.pdf", { type: "application/pdf" }));
    applyForm.set("answerKeyPdf", new File([answerKeyPdf], "gabarito.pdf", { type: "application/pdf" }));
    applyForm.set("year", "2019");
    applyForm.set("application", "Aplicacao regular");
    applyForm.set("booklet", "Caderno 7 Azul");
    applyForm.set("selection", JSON.stringify([{ originalNumber: 136, patternPrincipalId: PUBLISHED_PATTERN_ID }]));
    const applyResponse = await callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/apply`, applyForm, token));
    expect(applyResponse.status).toBe(409);
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(0);
  });

  it("Sprint 22.2 — itens B/C: editor confirma ano 2019, mas o GABARITO detecta ano 2020 (dia/caderno/cor batendo): preview vem com canApply=false e apply e rejeitado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");

    const examPdf = buildExamPdfWithHeader([136, 137], { day: 2, bookletNumber: 7, color: "AZUL" });
    const answerKeyPdf = buildAnswerKeyPdfWithIdentity(
      [[136, "C"], [137, "A"], [101, "B"], [102, "D"], [103, "E"], [104, "C"]],
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2020 } // ANO divergente de proposito — dia/caderno/cor batendo
    );

    const form = buildPreviewFormData({ examPdf, answerKeyPdf, identity: { year: "2019", booklet: "Caderno 7 Azul" } });
    const previewResponse = await previewPdfRoute(token, form);
    expect(previewResponse.status).toBe(200);
    const body = (await previewResponse.json()) as PreviewBody & { documentIdentityCheck?: { ok: boolean; messages: string[] }; globalWarnings?: string[] };
    expect(body.canApply).toBe(false); // item B
    expect(body.documentIdentityCheck?.ok).toBe(false);
    expect(body.documentIdentityCheck?.messages.some((m) => m.includes("ano detectado no GABARITO (2020) diverge do ano confirmado (2019)"))).toBe(true);

    const applyForm = new FormData();
    applyForm.set("batchId", body.batchId!);
    applyForm.set("examPdf", new File([examPdf], "prova.pdf", { type: "application/pdf" }));
    applyForm.set("answerKeyPdf", new File([answerKeyPdf], "gabarito.pdf", { type: "application/pdf" }));
    applyForm.set("year", "2019");
    applyForm.set("application", "Aplicacao regular");
    applyForm.set("booklet", "Caderno 7 Azul");
    applyForm.set("selection", JSON.stringify([{ originalNumber: 136, patternPrincipalId: PUBLISHED_PATTERN_ID }]));
    const applyResponse = await callRoute(await formDataToRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/apply`, applyForm, token));
    expect(applyResponse.status).toBe(409); // item C
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions").get() as { c: number }).c;
    expect(total).toBe(0);
  });
});

describe("Sprint 22.1 — fluxo de revisao/edicao editorial (secoes 5/7/10 da ordem)", () => {
  function buildBrokenExamPdf(): Uint8Array {
    return buildFixturePdf([
      [
        "QUESTAO 1",
        "Enunciado tecnico da questao 1.",
        "A. Alternativa A da questao 1",
        "B. Alternativa B da questao 1",
        "C. Alternativa C da questao 1",
        "D. Alternativa D da questao 1",
        "E. Alternativa E da questao 1",
        "QUESTAO 3",
        "Enunciado com problema estrutural (so 4 alternativas).",
        "A. Alt A",
        "B. Alt B",
        "C. Alt C",
        "D. Alt D",
      ],
    ]);
  }

  const brokenKeyPdf = buildAnswerKeyPdf([
    [1, "C"],
    [3, "B"],
    [101, "A"],
    [102, "D"],
    [103, "E"],
    [104, "C"],
  ]);

  async function previewBrokenBatch(token: string): Promise<{ batchId: string }> {
    const form = buildPreviewFormData({ examPdf: buildBrokenExamPdf(), answerKeyPdf: brokenKeyPdf });
    const response = await previewPdfRoute(token, form);
    const body = (await response.json()) as PreviewBody;
    return { batchId: body.batchId! };
  }

  it("questao 3 aparece needs_review por estrutura (4 alternativas), nunca 'consertada' sozinha", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const form = buildPreviewFormData({ examPdf: buildBrokenExamPdf(), answerKeyPdf: brokenKeyPdf });
    const response = await previewPdfRoute(token, form);
    const body = (await response.json()) as PreviewBody;
    const q3 = body.questions!.find((q) => q.originalNumber === 3)!;
    expect(q3.status).toBe("needs_review");
    expect(q3.canApply).toBe(false);
  });

  it("needs_review corrigido -> ready quando permitido: aplica com reviewedAlternatives, gabarito preservado do PDF, fingerprint recalculado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const { batchId } = await previewBrokenBatch(token);

    const response = await applyPdfRoute(token, batchId, [
      { originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID },
      {
        originalNumber: 3,
        patternPrincipalId: PUBLISHED_PATTERN_ID,
        reviewedStatement: "Enunciado corrigido pela editora para a questao 3.",
        reviewedAlternatives: [
          { letter: "A", text: "A corrigida" },
          { letter: "B", text: "B corrigida" },
          { letter: "C", text: "C corrigida" },
          { letter: "D", text: "D corrigida" },
          { letter: "E", text: "E corrigida" },
        ],
      },
    ], { examPdf: buildBrokenExamPdf(), answerKeyPdf: brokenKeyPdf });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; appliedCount: number; questionIds: string[] };
    expect(body.appliedCount).toBe(2);

    const q3Id = body.questionIds[1];
    const q3Row = db.sqlite.prepare("SELECT enunciado FROM questions WHERE id = ?").get(q3Id) as { enunciado: string };
    expect(q3Row.enunciado).toBe("Enunciado corrigido pela editora para a questao 3.");

    const correctAlt = db.sqlite.prepare("SELECT letter, text FROM question_alternatives WHERE question_id = ? AND is_correct = 1").get(q3Id) as {
      letter: string;
      text: string;
    };
    // Gabarito real da questao 3 e "B" — a correcao editorial NUNCA escolhe
    // a letra correta, so o TEXTO; a letra marcada correta precisa bater
    // com o que o PDF de gabarito diz, usando o TEXTO editado.
    expect(correctAlt.letter).toBe("B");
    expect(correctAlt.text).toBe("B corrigida");
  });

  it("dedupe apos edicao: se o texto corrigido colide com uma questao JA existente no banco, o lote inteiro e rejeitado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");

    const editedStatement = "Enunciado corrigido pela editora para a questao 3.";
    const editedAlternatives = [
      { letter: "A" as const, text: "A corrigida" },
      { letter: "B" as const, text: "B corrigida" },
      { letter: "C" as const, text: "C corrigida" },
      { letter: "D" as const, text: "D corrigida" },
      { letter: "E" as const, text: "E corrigida" },
    ];
    const collidingFingerprint = await computeQuestionFingerprint(
      editedStatement,
      editedAlternatives.map((a) => ({ letter: a.letter, text: a.text, isCorrect: false }))
    );
    // Pré-existe uma questão no banco com o MESMO fingerprint que a edição vai produzir.
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint, editorial_status)
       VALUES ('existing-q', 'EXISTING-001', 'Outro enunciado qualquer', 'media', 'autoral', '${collidingFingerprint}', 'draft')`
    );

    const { batchId } = await previewBrokenBatch(token);
    const response = await applyPdfRoute(
      token,
      batchId,
      [{ originalNumber: 3, patternPrincipalId: PUBLISHED_PATTERN_ID, reviewedStatement: editedStatement, reviewedAlternatives: editedAlternatives }],
      { examPdf: buildBrokenExamPdf(), answerKeyPdf: brokenKeyPdf }
    );
    expect(response.status).toBe(409);
    const total = (db.sqlite.prepare("SELECT COUNT(*) as c FROM questions WHERE id != 'existing-q'").get() as { c: number }).c;
    expect(total).toBe(0);
  });
});

describe("Sprint 22.1 — rastreabilidade de sourceUrl/identidade apos o batch (secao 9 da ordem)", () => {
  it("GET /:batchId continua expondo sourceUrl/identidade do exame DEPOIS de aplicado e DEPOIS de desfeito", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    grantRole("editor1", "admin");

    const form = buildPreviewFormData({
      identity: { sourceUrl: "https://download.inep.gov.br/educacao_basica/enem/provas/2019/exemplo.pdf" },
    });
    const previewResponse = await previewPdfRoute(token, form);
    const previewBody = (await previewResponse.json()) as PreviewBody;
    const batchId = previewBody.batchId!;

    async function fetchBatchStatus(): Promise<{ batch: { pdfSourceInfo: { sourceUrl: string | null } | null } }> {
      const req = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/${batchId}`, { headers: { Cookie: `md_session=${token}` } });
      const res = await callRoute(req);
      return (await res.json()) as never;
    }

    const beforeApply = await fetchBatchStatus();
    expect(beforeApply.batch.pdfSourceInfo?.sourceUrl).toBe("https://download.inep.gov.br/educacao_basica/enem/provas/2019/exemplo.pdf");

    await applyPdfRoute(token, batchId, [{ originalNumber: 1, patternPrincipalId: PUBLISHED_PATTERN_ID }]);
    const afterApply = await fetchBatchStatus();
    expect(afterApply.batch.pdfSourceInfo?.sourceUrl).toBe("https://download.inep.gov.br/educacao_basica/enem/provas/2019/exemplo.pdf");

    const undoReq = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/${batchId}/undo`, { method: "POST", headers: { Cookie: `md_session=${token}` } });
    await callRoute(undoReq);
    const afterUndo = await fetchBatchStatus();
    expect(afterUndo.batch.pdfSourceInfo?.sourceUrl).toBe("https://download.inep.gov.br/educacao_basica/enem/provas/2019/exemplo.pdf");
  });
});
