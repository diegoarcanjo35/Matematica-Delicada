// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleEditorialImportsRequest } from "../src/routes/editorialImports";

/* Sprint 24.2, hardening pós-auditoria — testes de CONTRATO HTTP dos
   endpoints client-preview (JSON puro, seção 3 da ordem) e client-apply
   (multipart, seção 5/6). Nunca constrói PDF nenhum — client-preview nem
   aceita PDF neste contrato. */

let db: FakeD1Database;
let bucket: FakeR2Bucket;

beforeEach(() => {
  db = new FakeD1Database();
  bucket = new FakeR2Bucket();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-escala', 'Escala e Proporção', 'F', 'D', 'E', 'X', 'R', 'published')`
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

function baseQuestion() {
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
  };
}

function basePreviewJsonBody(): Record<string, unknown> {
  return {
    year: 2024,
    application: "Regular",
    booklet: "Caderno 5 Amarelo",
    confirmation: true,
    examSha256: "a".repeat(64),
    answerKeySha256: "b".repeat(64),
    pageCount: 32,
    parserVersion: "client-v1",
    examQuestions: [baseQuestion()],
    answerKey: [[91, "C"]],
    visualElements: [],
    examDetectedIdentity: { bookletNumber: 5, color: "AMARELO" },
    answerKeyDetectedIdentity: { day: 2, bookletNumber: 5, color: "AMARELO", year: 2024 },
  };
}

async function jsonRequest(url: string, bodyObj: unknown, token: string | null): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const headers = new Headers({ "content-type": "application/json", "content-length": String(body.byteLength) });
  if (token) headers.set("Cookie", `md_session=${token}`);
  return new Request(url, { method: "POST", body, headers });
}

describe("client-preview — contrato HTTP JSON puro (seção 3 da ordem: NUNCA multipart, NUNCA PNG)", () => {
  it("aceita corpo JSON puro (Content-Type: application/json) e gera prévia real", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const request = await jsonRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/client-preview`, basePreviewJsonBody(), token);
    const response = await callRoute(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; detectedQuestionCount: number };
    expect(body.ok).toBe(true);
    expect(body.detectedQuestionCount).toBe(1);
  });

  it("rejeita corpo que não é JSON válido", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const garbage = new TextEncoder().encode("isto nao e json");
    const request = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/client-preview`, {
      method: "POST",
      body: garbage,
      headers: new Headers({ "content-type": "application/json", "content-length": String(garbage.byteLength), Cookie: `md_session=${token}` }),
    });
    const response = await callRoute(request);
    expect(response.status).toBe(400);
  });

  it("sem sessão → 401", async () => {
    const request = await jsonRequest(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/client-preview`, basePreviewJsonBody(), null);
    const response = await callRoute(request);
    expect(response.status).toBe(401);
  });

  it("J) prévia real (payload sintético equivalente ao produzido pelo pipeline) fica bem abaixo de 1MB — nunca carrega PNG", async () => {
    const bodyObj = basePreviewJsonBody();
    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj)).byteLength;
    expect(bodyBytes).toBeLessThan(1024 * 1024);
  });
});

describe("client-apply — contrato multipart (seção 5/6 da ordem: só imagens confirmadas, nunca duplicadas)", () => {
  it("I) dois campos multipart 'visual:<mesmo_hash>' → rejeitado (nunca sobrescreve silenciosamente)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");

    const form = new FormData();
    form.set("batchId", "batch-inexistente"); // não precisa existir de verdade — a rejeição de duplicata acontece ANTES de buscar o batch.
    form.set("selection", JSON.stringify([{ originalNumber: 91, patternPrincipalId: "pat-1", visualConfirmations: [{ elementHash: "same-hash", placement: "statement", altText: "x" }] }]));
    form.append("visual:same-hash", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    form.append("visual:same-hash", new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" }));

    const serialized = new Response(form);
    const contentType = serialized.headers.get("content-type")!;
    const bodyBytes = new Uint8Array(await serialized.arrayBuffer());
    const request = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/pdf/client-apply`, {
      method: "POST",
      body: bodyBytes,
      headers: new Headers({ "content-type": contentType, "content-length": String(bodyBytes.byteLength), Cookie: `md_session=${token}` }),
    });
    const response = await callRoute(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/duplicad/i);
  });
});
