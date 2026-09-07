// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleEditorialImportsRequest } from "../src/routes/editorialImports";
import { IMPORT_CSV_V2_HEADERS } from "../src/lib/questionImportV2";

/* Sprint 19, seção 17/19 da ordem (itens 66-68 + smoke de wiring das rotas
   novas) — RBAC e contrato HTTP dos endpoints de importação, direto na
   rota (mesmo padrão de worker/testing/questionImages.test.ts). */

let db: FakeD1Database;
let bucket: FakeR2Bucket;

beforeEach(async () => {
  db = new FakeD1Database();
  bucket = new FakeR2Bucket();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
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

function csvRow(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    codigo: "ROUTE-001",
    enunciado: "Enunciado de teste de rota suficientemente longo.",
    resolucao_comentada: "Resolução comentada.",
    dificuldade: "media",
    origem: "autoral",
    prova: "ENEM",
    ano: "2024",
    alt_a: "A",
    alt_b: "B",
    alt_c: "C",
    alt_d: "D",
    alt_e: "E",
    correta: "A",
    macete: "Macete.",
    padrao_principal: "PAD-01",
    padroes_secundarios: "",
    tags: "",
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

function buildSimpleZip(): Uint8Array {
  return zipSync({
    "questoes.csv": new TextEncoder().encode(buildCsvV2([csvRow()])),
    "manifest.json": new TextEncoder().encode(JSON.stringify({ version: 1, questions: [] })),
  });
}

async function callRoute(request: Request): Promise<Response> {
  return (await handleEditorialImportsRequest(request, localEnv(), new URL(request.url)))!;
}

function zipRequest(token: string | null, body: Uint8Array): Request {
  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  headers.set("content-length", String(body.byteLength));
  headers.set("content-type", "application/zip");
  return new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/package/preview`, { method: "POST", body, headers });
}

describe("Sprint 19 — RBAC dos endpoints de importação (itens 66-68)", () => {
  it("item 66 — student sem papel editorial NÃO acessa preview/apply de pacote", async () => {
    const token = await seedUserWithSession("student1");
    const response = await callRoute(zipRequest(token, buildSimpleZip()));
    expect(response.status).toBe(403);
  });

  it("item 67 — editor acessa preview de pacote normalmente", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const response = await callRoute(zipRequest(token, buildSimpleZip()));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; canApply: boolean };
    expect(body.ok).toBe(true);
    expect(body.canApply).toBe(true);
  });

  it("item 68 — admin acessa preview/apply/undo de pacote", async () => {
    const token = await seedUserWithSession("admin1");
    grantRole("admin1", "admin");
    const previewResponse = await callRoute(zipRequest(token, buildSimpleZip()));
    expect(previewResponse.status).toBe(200);
  });

  it("sem sessão nenhuma: 401", async () => {
    const response = await callRoute(zipRequest(null, buildSimpleZip()));
    expect(response.status).toBe(401);
  });
});

describe("Sprint 19 — contrato HTTP dos endpoints novos", () => {
  it("GET template-v2 retorna CSV V2 com Content-Disposition correto", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const headers = new Headers({ Cookie: `md_session=${token}` });
    const request = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/template-v2`, { headers });
    const response = await callRoute(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("questoes-importacao-v2.csv");
    const text = await response.text();
    expect(text.trim().split("\r\n")).toHaveLength(1);
  });

  it("package/preview sem Content-Length é rejeitado (fail-closed, mesma disciplina da Sprint 18.1)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const body = buildSimpleZip();
    const headers = new Headers({ Cookie: `md_session=${token}` });
    const request = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/package/preview`, { method: "POST", body, headers });
    const response = await callRoute(request);
    expect(response.status).toBe(400);
  });

  it("package/apply exige batchId e arquivo via multipart", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const preview = await callRoute(zipRequest(token, buildSimpleZip()));
    const { batchId } = (await preview.json()) as { batchId: string };

    const zipBytes = buildSimpleZip();
    const form = new FormData();
    form.set("batchId", batchId);
    form.set("arquivo", new File([zipBytes], "pacote.zip", { type: "application/zip" }));
    const serialized = new Response(form);
    const contentType = serialized.headers.get("content-type")!;
    const multipartBody = new Uint8Array(await serialized.arrayBuffer());

    const headers = new Headers({ Cookie: `md_session=${token}`, "content-type": contentType, "content-length": String(multipartBody.byteLength) });
    const request = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/package/apply`, { method: "POST", body: multipartBody, headers });
    const response = await callRoute(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; appliedCount: number };
    expect(body.ok).toBe(true);
    expect(body.appliedCount).toBe(1);
  });

  it("undo de pacote ZIP exige papel admin (mesma regra do undo de CSV)", async () => {
    const editorToken = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const preview = await callRoute(zipRequest(editorToken, buildSimpleZip()));
    const { batchId } = (await preview.json()) as { batchId: string };

    const headers = new Headers({ Cookie: `md_session=${editorToken}` });
    const request = new Request(`${LOCAL_ORIGIN}/api/editorial/question-imports/${batchId}/undo`, { method: "POST", headers });
    const response = await callRoute(request);
    expect(response.status).toBe(403);
  });
});
