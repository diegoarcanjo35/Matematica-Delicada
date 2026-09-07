// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { FakeR2Bucket } from "./fakeR2";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleEditorialQuestionsRequest } from "../src/routes/editorialQuestions";
import { handleQuestionMediaRequest } from "../src/routes/questionMedia";
import { isValidR2AssetKey, MAX_IMAGE_MULTIPART_BYTES } from "../src/lib/questionsValidation";
import { addQuestionImage } from "../src/services/questionMediaService";

/* Sprint 18, seções 11-13/19 da ordem — upload/delete/serve de imagem.
   Mesmo padrão de worker/testing/questions.test.ts (usuários reais via
   createUser, sessão real via createSession, rota real chamada
   diretamente). FakeR2Bucket (worker/testing/fakeR2.ts) substitui o
   binding QUESTION_MEDIA — em memória, nunca toca disco/rede. */

let db: FakeD1Database;
let bucket: FakeR2Bucket;

beforeEach(async () => {
  db = new FakeD1Database();
  bucket = new FakeR2Bucket();
  for (const id of ["editor1", "admin1"]) {
    await createUser(db as never, {
      id,
      name: "Usuária Teste",
      email: `${id}@teste.dev`,
      emailNormalized: `${id}@teste.dev`,
      passwordHash: await hashPassword("senha-original-123"),
    });
  }
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
});

async function seedUserWithSession(id: string): Promise<string> {
  const existing = db.sqlite.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) {
    await createUser(db as never, { id, name: "Usuária Teste", email: `${id}@teste.dev`, emailNormalized: `${id}@teste.dev`, passwordHash: await hashPassword("senha-original-123") });
  }
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

function localEnv(overrides: Partial<Env> = {}): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", QUESTION_MEDIA: bucket as never, ...overrides };
}

// Assinaturas reais mínimas — só os bytes que sniffImageMimeType inspeciona,
// nunca uma imagem decodificável de verdade (não precisa ser).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  const riff = "RIFF".split("").map((c) => c.charCodeAt(0));
  const webp = "WEBP".split("").map((c) => c.charCodeAt(0));
  bytes.set(riff, 0);
  bytes.set(webp, 8);
  return bytes;
}
const NOT_AN_IMAGE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" — formato não aceito.

/* Sprint 18.1, seção E da correção — o precheck de tamanho da rota agora
   EXIGE um Content-Length real (fail-closed); confirmado ANTES de escrever
   este helper que undici (fetch nativo usado por estes testes) NUNCA
   calcula esse cabeçalho sozinho para um corpo FormData (nem em Node, nem —
   por extensão do mesmo motivo — em runtimes de teste equivalentes). Por
   isso o multipart é serializado manualmente aqui (via um Response
   temporário, que faz o MESMO trabalho de boundary que um navegador real
   faz ao enviar um <form>), e o Content-Length é sempre computado a partir
   dos bytes REAIS, exatamente como um navegador legítimo faria — os testes
   de upload válido continuam válidos sob o novo precheck sem precisar saber
   dele. `headerOverrides` existe só para os testes NEGATIVOS da seção E
   (ausente/malformado/acima do teto). */
async function uploadRequest(
  questionId: string,
  token: string | null,
  fields: { file?: Uint8Array; filename?: string; mimeType?: string; mutationId?: string; placement?: string; alternativeLetter?: string; altText?: string; caption?: string },
  headerOverrides: { omitContentLength?: boolean; contentLength?: string } = {}
): Promise<Request> {
  const form = new FormData();
  if (fields.file !== undefined) {
    form.set("arquivo", new File([fields.file], fields.filename ?? "imagem.png", { type: fields.mimeType ?? "image/png" }));
  }
  if (fields.mutationId !== undefined) form.set("mutationId", fields.mutationId);
  if (fields.placement !== undefined) form.set("placement", fields.placement);
  if (fields.alternativeLetter !== undefined) form.set("alternativeLetter", fields.alternativeLetter);
  if (fields.altText !== undefined) form.set("altText", fields.altText);
  if (fields.caption !== undefined) form.set("caption", fields.caption);

  const serialized = new Response(form);
  const contentType = serialized.headers.get("content-type")!;
  const body = new Uint8Array(await serialized.arrayBuffer());

  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  headers.set("content-type", contentType);
  if (!headerOverrides.omitContentLength) {
    headers.set("content-length", headerOverrides.contentLength ?? String(body.byteLength));
  }
  return new Request(`${LOCAL_ORIGIN}/api/editorial/questions/${questionId}/images`, { method: "POST", body, headers });
}

async function callImagesRoute(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return (await handleEditorialQuestionsRequest(request, localEnv(), url))!;
}

async function callDelete(questionId: string, imageId: string, token: string | null): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  const request = new Request(`${LOCAL_ORIGIN}/api/editorial/questions/${questionId}/images/${imageId}`, { method: "DELETE", headers });
  return (await handleEditorialQuestionsRequest(request, localEnv(), new URL(request.url)))!;
}

async function callUpdateAlt(questionId: string, imageId: string, token: string | null, body: { mutationId?: string; altText?: unknown; caption?: unknown }): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("Cookie", `md_session=${token}`);
  const request = new Request(`${LOCAL_ORIGIN}/api/editorial/questions/${questionId}/images/${imageId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  return (await handleEditorialQuestionsRequest(request, localEnv(), new URL(request.url)))!;
}

async function callServe(imageId: string, token: string | null, envOverrides: Partial<Env> = {}): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  const request = new Request(`${LOCAL_ORIGIN}/api/question-media/${imageId}`, { method: "GET", headers });
  return (await handleQuestionMediaRequest(request, localEnv(envOverrides), new URL(request.url)))!;
}

function mutId(seed: string): string {
  // UUID v4-shaped, determinístico por seed de teste (nunca usado em produção).
  return `00000000-0000-4000-8000-${seed.padStart(12, "0")}`;
}

describe("Sprint 18 — upload/delete/serve de imagem (item 13-26 da política de testes)", () => {
  it("item 13 — upload válido no enunciado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const response = await callImagesRoute(
      await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("1"), placement: "enunciado", altText: "Gráfico de barras" })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; image: { id: string; placement: string; alternativeLetter: string | null } };
    expect(body.image.placement).toBe("enunciado");
    expect(body.image.alternativeLetter).toBeNull();
    expect(bucket.size()).toBe(1);
  });

  it("item 14 — upload válido na alternativa A-E", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const response = await callImagesRoute(
      await uploadRequest(qId, token, { file: JPEG_BYTES, mimeType: "image/jpeg", mutationId: mutId("2"), placement: "alternativa", alternativeLetter: "C", altText: "Figura da alternativa C" })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { image: { placement: string; alternativeLetter: string | null } };
    expect(body.image.placement).toBe("alternativa");
    expect(body.image.alternativeLetter).toBe("C");
  });

  it("aceita WebP", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const response = await callImagesRoute(
      await uploadRequest(qId, token, { file: webpBytes(), mimeType: "image/webp", filename: "a.webp", mutationId: mutId("3"), placement: "enunciado", altText: "Foto" })
    );
    expect(response.status).toBe(201);
  });

  it("item 15 — múltiplas imagens mantêm ordem (position crescente por ordem de upload)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const r1 = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("10"), placement: "enunciado", altText: "Primeira" }));
    const r2 = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("11"), placement: "enunciado", altText: "Segunda" }));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const rows = db.sqlite.prepare("SELECT alt_text, position FROM question_images WHERE question_id = ? ORDER BY position ASC").all(qId) as Array<{ alt_text: string; position: number }>;
    expect(rows.map((r) => r.alt_text)).toEqual(["Primeira", "Segunda"]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it("item 16 — MIME inválido (PDF disfarçado de .png) é rejeitado, nada gravado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const response = await callImagesRoute(await uploadRequest(qId, token, { file: NOT_AN_IMAGE_BYTES, mutationId: mutId("20"), placement: "enunciado", altText: "X" }));
    expect(response.status).toBe(400);
    expect(bucket.size()).toBe(0);
    expect((db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(qId) as { total: number }).total).toBe(0);
  });

  it("item 17 — arquivo acima do limite (8 MB) é rejeitado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(PNG_BYTES, 0);
    const response = await callImagesRoute(await uploadRequest(qId, token, { file: big, mutationId: mutId("30"), placement: "enunciado", altText: "Grande" }));
    expect(response.status).toBe(413);
    expect(bucket.size()).toBe(0);
  });

  it("item 18 — chave R2 nunca aceita path traversal/URL arbitrária (validador isValidR2AssetKey)", () => {
    expect(isValidR2AssetKey("questions/q1/img1.png")).toBe(true);
    expect(isValidR2AssetKey("../../etc/passwd")).toBe(false);
    expect(isValidR2AssetKey("questions/../q1/img1.png")).toBe(false);
    expect(isValidR2AssetKey("https://evil.example/img.png")).toBe(false);
    expect(isValidR2AssetKey("questions/q1/img1.svg")).toBe(false); // SVG nunca é chave válida de upload novo.
  });

  it("item 19 — editor E admin são ambos autorizados a fazer upload", async () => {
    const editorToken = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const adminToken = await seedUserWithSession("admin1");
    grantRole("admin1", "admin");
    const q1 = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const q2 = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const r1 = await callImagesRoute(await uploadRequest(q1, editorToken, { file: PNG_BYTES, mutationId: mutId("40"), placement: "enunciado", altText: "E" }));
    const r2 = await callImagesRoute(await uploadRequest(q2, adminToken, { file: PNG_BYTES, mutationId: mutId("41"), placement: "enunciado", altText: "A" }));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
  });

  it("item 20 — usuário sem papel editorial NÃO faz upload nem delete", async () => {
    const token = await seedUserWithSession("no-role-user");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("50"), placement: "enunciado", altText: "X" }));
    expect(upload.status).toBe(403);
    expect(bucket.size()).toBe(0);

    const del = await callDelete(qId, "img-inexistente", token);
    expect(del.status).toBe(403);
  });

  it("item 21 — mídia de questão em DRAFT não vaza para aluno (sem papel editorial, sessão válida)", async () => {
    const editorToken = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, editorToken, { file: PNG_BYTES, mutationId: mutId("60"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };

    const studentToken = await seedUserWithSession("student-sem-papel");
    const response = await callServe(image.id, studentToken);
    expect(response.status).toBe(403);
  });

  it("item 22 — mídia de questão PUBLICADA segue autorização normal (qualquer sessão válida)", async () => {
    const editorToken = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, editorToken, { file: PNG_BYTES, mutationId: mutId("70"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };

    db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);

    const studentToken = await seedUserWithSession("student-sem-papel-2");
    const response = await callServe(image.id, studentToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("sem sessão nenhuma: 401 ao servir mídia", async () => {
    const response = await callServe("qualquer-id", null);
    expect(response.status).toBe(401);
  });

  it("item 23 — retry de upload com o MESMO mutationId não duplica imagem nem grava no R2 de novo", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const mutationId = mutId("80");

    const first = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "X" }));
    expect(first.status).toBe(201);
    expect(bucket.size()).toBe(1);

    const retry = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "X" }));
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { changed: boolean };
    expect(retryBody.changed).toBe(false);
    expect(bucket.size()).toBe(1); // nunca gravou um segundo objeto R2.
    expect((db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(qId) as { total: number }).total).toBe(1);
  });

  it("item 24 — falha do D1 DEPOIS de um upload novo no R2 limpa o objeto recém-criado", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });

    // Injeta falha forçada exatamente no INSERT de question_images — o R2
    // já teria recebido o objeto ANTES desta linha rodar (mesma ordem do
    // serviço: put() sempre roda antes do db.batch()). Chama o SERVIÇO
    // diretamente (não a rota) — mesmo padrão de authAtomicity.test.ts para
    // provar falha de D1 forçada: em produção, o try/catch de nível
    // superior em worker/src/index.ts converte isto num 500 ao chamador
    // HTTP; aqui o que importa é provar que ANTES de propagar o erro, o
    // objeto R2 recém-criado nesta chamada foi limpo.
    db.failNextMatching(/INSERT INTO question_images/);

    await expect(
      addQuestionImage(db as never, bucket as never, qId, "editor1", {
        mutationId: mutId("90"),
        placement: "enunciado",
        alternativeLetter: null,
        altText: "X",
        caption: null,
        fileBytes: PNG_BYTES,
        declaredMimeType: null,
      })
    ).rejects.toThrow("forced_failure_for_test");

    // O objeto foi gravado e depois LIMPO — nunca fica órfão no R2 nem
    // referenciado (inexistente) no D1.
    expect(bucket.size()).toBe(0);
    expect(bucket.deletedKeys.length).toBe(1);
    expect((db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(qId) as { total: number }).total).toBe(0);
  });

  it("item 25 — delete remove a referência D1 e nunca deixa a questão apontando para objeto inexistente", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("100"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };
    expect(bucket.size()).toBe(1);

    const del = await callDelete(qId, image.id, token);
    expect(del.status).toBe(200);
    expect((db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE id = ?").get(image.id) as { total: number }).total).toBe(0);
    expect(bucket.size()).toBe(0); // R2 também limpo (melhor esforço, mas confirmado aqui).

    // repetir o delete é idempotente — nunca um erro assustador.
    const again = await callDelete(qId, image.id, token);
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { changed: boolean };
    expect(againBody.changed).toBe(false);
  });

  it("delete de mídia numa questão publicada é bloqueado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("110"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);

    const del = await callDelete(qId, image.id, token);
    expect(del.status).toBe(400);
    expect(bucket.size()).toBe(1); // nada foi removido.
  });

  it("item 26 — imagens antigas (pré-Sprint 18) continuam classificadas como 'enunciado'", () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", withPrincipalPattern: true });
    db.sqlite.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position) VALUES ('legacy-img', '${qId}', 'assets/questoes/antiga.png', 'Antiga', 0)`);
    const row = db.sqlite.prepare("SELECT placement, alternative_letter, storage_kind FROM question_images WHERE id = 'legacy-img'").get() as {
      placement: string;
      alternative_letter: string | null;
      storage_kind: string;
    };
    expect(row.placement).toBe("enunciado");
    expect(row.alternative_letter).toBeNull();
    expect(row.storage_kind).toBe("local");
  });

  it("upload sem arquivo: 400", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const response = await callImagesRoute(await uploadRequest(qId, token, { mutationId: mutId("120"), placement: "enunciado", altText: "X" }));
    expect(response.status).toBe(400);
  });

  it("item 27 — alternativa COM imagem funciona normalmente (texto + imagem, nunca substituindo um pelo outro)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", withAlternatives: true });

    const response = await callImagesRoute(
      await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("140"), placement: "alternativa", alternativeLetter: "D", altText: "Figura de apoio da alternativa D" })
    );
    expect(response.status).toBe(201);
    const altRow = db.sqlite.prepare("SELECT text FROM question_alternatives WHERE question_id = ? AND letter = 'D'").get(qId) as { text: string };
    expect(altRow.text.trim().length).toBeGreaterThan(0); // texto continua exigido — imagem é complemento, nunca substituto.
  });

  it("item 28/29 (decisão documentada — ver migrations/0022, seção final) — alternativa image-only NÃO é suportada nesta sprint: o CHECK de texto não vazio continua bloqueando mesmo quando a letra já tem imagem anexada", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", withAlternatives: false });
    db.sqlite.exec(
      `INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, alternative_letter, storage_kind) VALUES ('img-alt-e', '${qId}', 'questions/${qId}/img-alt-e.png', 'Figura E', 0, 'alternativa', 'E', 'r2')`
    );
    expect(() =>
      db.sqlite.exec(`INSERT INTO question_alternatives (id, question_id, letter, text, position) VALUES ('alt-e', '${qId}', 'E', '   ', 0)`)
    ).toThrow(/CHECK constraint failed/);
  });

  it("upload em questão publicada é bloqueado (mídia de published não muda diretamente)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);
    const response = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("130"), placement: "enunciado", altText: "X" }));
    expect(response.status).toBe(400);
    expect(bucket.size()).toBe(0);
  });
});

describe("Correção 18.1, seção B — edição dedicada de alt text/legenda (PATCH), sem tocar bytes/R2", () => {
  it("editor corrige alt text sem remover a imagem — bytes/R2 nunca tocados", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("200"), placement: "enunciado", altText: "Antes" }));
    const { image } = (await upload.json()) as { image: { id: string; assetRef: string } };
    expect(bucket.size()).toBe(1);

    const response = await callUpdateAlt(qId, image.id, token, { mutationId: mutId("201"), altText: "Depois", caption: "Legenda nova" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; changed: boolean; image: { altText: string; caption: string | null; assetRef: string } };
    expect(body.changed).toBe(true);
    expect(body.image.altText).toBe("Depois");
    expect(body.image.caption).toBe("Legenda nova");
    expect(body.image.assetRef).toBe(image.assetRef); // assetRef/bytes nunca mudam.
    expect(bucket.size()).toBe(1); // R2 nunca tocado por uma edição de metadado.
  });

  it("reenviar exatamente o mesmo alt text é idempotente (changed:false, sem duplicar auditoria)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("210"), placement: "enunciado", altText: "Igual" }));
    const { image } = (await upload.json()) as { image: { id: string } };

    const response = await callUpdateAlt(qId, image.id, token, { mutationId: mutId("211"), altText: "Igual", caption: null });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
    const auditCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM audit_log WHERE event_type = 'editorial_question_image_updated'").get() as { total: number }).total;
    expect(auditCount).toBe(0);
  });

  it("alt text vazio é rejeitado (400), imagem existente não muda", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("220"), placement: "enunciado", altText: "Original" }));
    const { image } = (await upload.json()) as { image: { id: string } };

    const response = await callUpdateAlt(qId, image.id, token, { mutationId: mutId("221"), altText: "", caption: null });
    expect(response.status).toBe(400);
    const row = db.sqlite.prepare("SELECT alt_text FROM question_images WHERE id = ?").get(image.id) as { alt_text: string };
    expect(row.alt_text).toBe("Original");
  });

  it("edição de alt text em questão publicada é bloqueada", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("230"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);

    const response = await callUpdateAlt(qId, image.id, token, { mutationId: mutId("231"), altText: "Nova", caption: null });
    expect(response.status).toBe(400);
  });

  it("usuário sem papel editorial não edita alt text", async () => {
    const editorToken = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const upload = await callImagesRoute(await uploadRequest(qId, editorToken, { file: PNG_BYTES, mutationId: mutId("240"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };

    const noRoleToken = await seedUserWithSession("no-role-alt-editor");
    const response = await callUpdateAlt(qId, image.id, noRoleToken, { mutationId: mutId("241"), altText: "Hackeado", caption: null });
    expect(response.status).toBe(403);
  });
});

describe("Correção 18.1, seção D — gate fail-closed de fixture na rota de mídia", () => {
  it("fixture PUBLICADA em ambiente 'remoto' (fora de dev local) nunca é servida, mesmo marcada published", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", isLocalFixture: true });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("300"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);

    const studentToken = await seedUserWithSession("student-fixture-remote");
    const response = await callServe(image.id, studentToken, { ENVIRONMENT: "production" });
    expect(response.status).toBe(404);
  });

  it("fixture PUBLICADA em dev local COM a flag explícita segue o comportamento normal (qualquer sessão válida)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", isLocalFixture: true });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("310"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);

    const studentToken = await seedUserWithSession("student-fixture-local");
    const response = await callServe(image.id, studentToken, { ENABLE_LOCAL_EDITORIAL_FIXTURES: "true" });
    expect(response.status).toBe(200);
  });

  it("fixture em DRAFT, mesmo em dev local com a flag, continua restrita a editor/admin", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", isLocalFixture: true });
    const upload = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("320"), placement: "enunciado", altText: "X" }));
    const { image } = (await upload.json()) as { image: { id: string } };

    const studentToken = await seedUserWithSession("student-fixture-draft");
    const response = await callServe(image.id, studentToken, { ENABLE_LOCAL_EDITORIAL_FIXTURES: "true" });
    expect(response.status).toBe(403);
  });
});

describe("Correção 18.1, seção E — limite real do multipart (fail-closed)", () => {
  it("sem Content-Length: rejeitado ANTES do parse (400), nada gravado", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const response = await callImagesRoute(
      await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("400"), placement: "enunciado", altText: "X" }, { omitContentLength: true })
    );
    expect(response.status).toBe(400);
    expect(bucket.size()).toBe(0);
  });

  it("Content-Length malformado (não numérico): rejeitado (400)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const response = await callImagesRoute(
      await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("410"), placement: "enunciado", altText: "X" }, { contentLength: "abc" })
    );
    expect(response.status).toBe(400);
  });

  it("corpo declarado (Content-Length) acima do teto de multipart: 413 antes do parse", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const response = await callImagesRoute(
      await uploadRequest(
        qId,
        token,
        { file: PNG_BYTES, mutationId: mutId("420"), placement: "enunciado", altText: "X" },
        { contentLength: String(MAX_IMAGE_MULTIPART_BYTES + 1) }
      )
    );
    expect(response.status).toBe(413);
    expect(bucket.size()).toBe(0);
  });

  it("upload normal com Content-Length real continua funcionando (mesmo caminho da UI)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const response = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId: mutId("430"), placement: "enunciado", altText: "X" }));
    expect(response.status).toBe(201);
  });
});

describe("Correção 18.1, seção G — idempotência FORTE do upload (hash de conteúdo)", () => {
  const PNG_VARIANT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);

  it("retry idêntico (mesmo mutationId, mesmo arquivo/campos) não duplica D1 nem R2", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const mutationId = mutId("500");

    const first = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "Idêntico" }));
    expect(first.status).toBe(201);
    const retry = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "Idêntico" }));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { changed: boolean }).changed).toBe(false);
    expect(bucket.size()).toBe(1);
    expect((db.sqlite.prepare("SELECT COUNT(*) as total FROM question_images WHERE question_id = ?").get(qId) as { total: number }).total).toBe(1);
  });

  it("mesmo mutationId + arquivo DIFERENTE → 409 (nunca aceito como retry)", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const mutationId = mutId("510");

    const first = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "X" }));
    expect(first.status).toBe(201);
    const retry = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_VARIANT_BYTES, mutationId, placement: "enunciado", altText: "X" }));
    expect(retry.status).toBe(409);
    expect(bucket.size()).toBe(1); // nenhum objeto novo gravado por causa do conflito.
  });

  it("mesmo mutationId + altText DIFERENTE → 409", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const mutationId = mutId("520");

    const first = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "Texto A" }));
    expect(first.status).toBe(201);
    const retry = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "Texto B" }));
    expect(retry.status).toBe(409);
  });

  it("mesmo mutationId + placement DIFERENTE → 409", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", withAlternatives: true });
    const mutationId = mutId("530");

    const first = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "X" }));
    expect(first.status).toBe(201);
    const retry = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "alternativa", alternativeLetter: "A", altText: "X" }));
    expect(retry.status).toBe(409);
  });

  it("retry legítimo (identidade EXATA) é reconhecido mesmo depois de a questão sair de draft/changes_requested", async () => {
    const token = await seedUserWithSession("editor1");
    grantRole("editor1", "editor");
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft" });
    const mutationId = mutId("540");

    const first = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "Estável" }));
    expect(first.status).toBe(201);

    db.sqlite.exec(`UPDATE questions SET editorial_status = 'in_review' WHERE id = '${qId}'`);

    const retry = await callImagesRoute(await uploadRequest(qId, token, { file: PNG_BYTES, mutationId, placement: "enunciado", altText: "Estável" }));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { changed: boolean }).changed).toBe(false);
  });
});
