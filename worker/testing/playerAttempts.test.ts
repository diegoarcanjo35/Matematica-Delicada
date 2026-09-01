// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handlePlayerRequest } from "../src/routes/player";
import { confirmAnswer, saveAnswer, startOrResumeAttempt } from "../src/services/playerService";

/* Sprint 8 v1.1 — Player de Questão. Mesmo padrão de worker/testing/
   questions.test.ts/patterns.test.ts: SQLite real por trás do
   FakeD1Database, sessão real, rota exercitada de ponta a ponta. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'Frase de reconhecimento', 'D', 'E', 'X', 'R', 'published')`
  );
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-draft', 'PAD-02', 'padrao-2', 'Padrão rascunho', 'F', 'D', 'E', 'X', 'R', 'draft')`
  );
});

async function seedUser(id: string): Promise<void> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
}

async function seedUserWithSession(id: string): Promise<string> {
  await seedUser(id);
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

/** Questão pronta e PUBLICADA (seedQuestion nasce `draft` — precisa ser
 *  promovida manualmente aqui, já que o player só serve `published`,
 *  mesma regra do editorial desde a Sprint 7). */
function seedPublishedQuestion(overrides: Parameters<typeof seedQuestion>[1] = {}): string {
  const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, ...overrides });
  db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);
  return qId;
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: db as never,
    ASSETS: {} as never,
    ENVIRONMENT: "development",
    ENABLE_LOCAL_EDITORIAL_FIXTURES: "true",
    ...overrides,
  };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}, origin = LOCAL_ORIGIN): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${origin}${path}`, { ...init, headers });
}

async function callRoute(path: string, token: string | null, init: RequestInit = {}, env: Env = localEnv()) {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  const response = await handlePlayerRequest(request, env, url);
  return response!;
}

function attemptRow(id: string): { status: string; version: number; is_correct: number | null; selected_alternative: string | null } {
  return db.sqlite.prepare("SELECT status, version, is_correct, selected_alternative FROM question_attempts WHERE id = ?").get(id) as never;
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

/* ---------------------------------------------------------------------- */
/* Gate local                                                              */
/* ---------------------------------------------------------------------- */

describe("gate local (reaproveita isLocalEditorialFixturesAllowed — nenhum gate novo)", () => {
  it("fora do gate (flag ausente): resposta acolhedora, sem tocar em question_attempts", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const response = await callRoute(
      "/api/player/attempts",
      token,
      { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) },
      localEnv({ ENABLE_LOCAL_EDITORIAL_FIXTURES: undefined })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean };
    expect(body.available).toBe(false);
    expect(countRows("question_attempts")).toBe(0);
  });

  it("sem sessão: 401, mesmo dentro do gate", async () => {
    const response = await callRoute("/api/player/attempts", null, { method: "POST", body: JSON.stringify({ questionId: "x", mode: "learning" }) });
    expect(response.status).toBe(401);
  });
});

/* ---------------------------------------------------------------------- */
/* Início e retomada                                                       */
/* ---------------------------------------------------------------------- */

describe("início e retomada de tentativa", () => {
  it("cria a tentativa, congela question_version, não revela gabarito no payload", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const response = await callRoute("/api/player/attempts", token, {
      method: "POST",
      body: JSON.stringify({ questionId: qId, mode: "learning" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { attemptId: string };
    const row = db.sqlite.prepare("SELECT question_version, mode, status FROM question_attempts WHERE id = ?").get(body.attemptId) as {
      question_version: number;
      mode: string;
      status: string;
    };
    expect(row.question_version).toBe(1);
    expect(row.mode).toBe("learning");
    expect(row.status).toBe("in_progress");
    expect(JSON.stringify(body)).not.toMatch(/is_correct|gabarito/i);
  });

  it("questão não publicada (draft) → 404, nunca vaza conteúdo", async () => {
    const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 }); // nunca promovida
    const token = await seedUserWithSession("u1");
    const response = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    expect(response.status).toBe(404);
  });

  it("tentativa ativa existente do mesmo usuário+questão+modo é retornada, sem duplicar", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const first = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const firstBody = (await first.json()) as { attemptId: string };
    const second = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    expect(second.status).toBe(200); // não é 201 — não é criação nova
    const secondBody = (await second.json()) as { attemptId: string };
    expect(secondBody.attemptId).toBe(firstBody.attemptId);
    expect(countRows("question_attempts")).toBe(1);
  });

  it("CORRIDA: duas criações simultâneas do mesmo usuário+questão+modo resultam em exatamente UMA tentativa ativa (garantia de banco, não só JS)", async () => {
    const qId = seedPublishedQuestion();
    const userId = "u-race";
    await seedUser(userId);
    const question = db.sqlite.prepare("SELECT version FROM questions WHERE id = ?").get(qId) as { version: number };
    const [r1, r2] = await Promise.all([
      startOrResumeAttempt(db as never, userId, qId, "learning"),
      startOrResumeAttempt(db as never, userId, qId, "learning"),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.value!.attemptId).toBe(r2.value!.attemptId); // mesma tentativa devolvida às duas
    expect(countRows("question_attempts", "WHERE status = 'in_progress'")).toBe(1);
    void question;
  });

  it("GET não escreve nada e não cria tentativa", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    const before = countRows("question_attempts");
    const getResponse = await callRoute(`/api/player/attempts/${attemptId}`, token, { method: "GET" });
    expect(getResponse.status).toBe(200);
    expect(countRows("question_attempts")).toBe(before);
  });

  it("tentativa de OUTRO usuário → 404 (nunca 403 — não confirma existência)", async () => {
    const qId = seedPublishedQuestion();
    const tokenA = await seedUserWithSession("userA");
    const tokenB = await seedUserWithSession("userB");
    const create = await callRoute("/api/player/attempts", tokenA, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    const response = await callRoute(`/api/player/attempts/${attemptId}`, tokenB, { method: "GET" });
    expect(response.status).toBe(404);
  });

  it("PATCH/DELETE inválidos em /api/player/attempts → 405", async () => {
    const token = await seedUserWithSession("u1");
    const response = await callRoute("/api/player/attempts", token, { method: "DELETE" });
    expect(response.status).toBe(405);
  });
});

/* ---------------------------------------------------------------------- */
/* Reconhecimento                                                          */
/* ---------------------------------------------------------------------- */

describe("reconhecimento", () => {
  async function startRecognitionAttempt(): Promise<{ token: string; attemptId: string; qId: string }> {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "recognition" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    return { token, attemptId, qId };
  }

  it("salva reconhecimento com padrão publicado, gera evento, libera as alternativas", async () => {
    const { token, attemptId } = await startRecognitionAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/recognition`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, patternSlug: "padrao-1", clue: "Viu a palavra 'variação'", strategy: "Montar equação" }),
    });
    expect(response.status).toBe(200);
    const row = db.sqlite.prepare("SELECT recognition_pattern_id, version FROM question_attempts WHERE id = ?").get(attemptId) as {
      recognition_pattern_id: string;
      version: number;
    };
    // Resolvido por SLUG na requisição, mas armazenado pelo id interno real
    // (nunca o slug é gravado como identidade — mesma convenção do resto do
    // Banco de Questões/padrões).
    expect(row.recognition_pattern_id).toBe("pat-1");
    expect(row.version).toBe(2);
    expect(countRows("question_recognition_events", `WHERE attempt_id = '${attemptId}'`)).toBe(1);
  });

  it("padrão em rascunho (não publicado) → rejeitado", async () => {
    const { token, attemptId } = await startRecognitionAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/recognition`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, patternSlug: "padrao-2", clue: "x", strategy: "y" }),
    });
    expect(response.status).toBe(400);
    expect(countRows("question_recognition_events")).toBe(0);
  });

  it("repetição idêntica é idempotente — não duplica evento nem avança version", async () => {
    const { token, attemptId } = await startRecognitionAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/recognition`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, patternSlug: "padrao-1", clue: "pista", strategy: "estrategia" }),
    });
    const repeat = await callRoute(`/api/player/attempts/${attemptId}/recognition`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, patternSlug: "padrao-1", clue: "pista", strategy: "estrategia" }),
    });
    expect(repeat.status).toBe(200);
    const row = db.sqlite.prepare("SELECT version FROM question_attempts WHERE id = ?").get(attemptId) as { version: number };
    expect(row.version).toBe(2); // não avançou de novo
    expect(countRows("question_recognition_events", `WHERE attempt_id = '${attemptId}'`)).toBe(1);
  });

  it("tentativa de outro aluno → 404", async () => {
    const { attemptId } = await startRecognitionAttempt();
    const tokenB = await seedUserWithSession("outroAluno");
    const response = await callRoute(`/api/player/attempts/${attemptId}/recognition`, tokenB, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, patternSlug: "padrao-1", clue: "x", strategy: "y" }),
    });
    expect(response.status).toBe(404);
  });

  it("texto hostil (script/HTML) é tratado como DADO — nunca rejeitado por conteúdo, só por tamanho", async () => {
    const { token, attemptId } = await startRecognitionAttempt();
    const hostile = "<script>alert(1)</script>";
    const response = await callRoute(`/api/player/attempts/${attemptId}/recognition`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, patternSlug: "padrao-1", clue: hostile, strategy: "y" }),
    });
    expect(response.status).toBe(200);
    const row = db.sqlite.prepare("SELECT recognition_clue FROM question_attempts WHERE id = ?").get(attemptId) as { recognition_clue: string };
    expect(row.recognition_clue).toBe(hostile); // armazenado literal, nunca executado (React escapa no front)
  });
});

/* ---------------------------------------------------------------------- */
/* Resposta e confirmação                                                  */
/* ---------------------------------------------------------------------- */

describe("resposta e confirmação", () => {
  async function startLearningAttempt(): Promise<{ token: string; attemptId: string; qId: string }> {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    return { token, attemptId, qId };
  }

  it("seleção grava selected_alternative, evento 'selected', nunca vaza gabarito", async () => {
    const { token, attemptId } = await startLearningAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/answer`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, alternative: "A" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/is_correct|correta/i);
    expect(attemptRow(attemptId).selected_alternative).toBe("A");
    const events = db.sqlite.prepare("SELECT event_type FROM question_answer_events WHERE attempt_id = ?").all(attemptId) as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toEqual(["selected"]);
  });

  it("alterar a alternativa gera evento 'changed', repetição idêntica não duplica", async () => {
    const { token, attemptId } = await startLearningAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 2, alternative: "B" }) });
    const repeat = await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 3, alternative: "B" }) });
    expect(repeat.status).toBe(200);
    const events = db.sqlite.prepare("SELECT event_type FROM question_answer_events WHERE attempt_id = ? ORDER BY created_at").all(attemptId) as Array<{
      event_type: string;
    }>;
    expect(events.map((e) => e.event_type)).toEqual(["selected", "changed"]); // repetição não gerou 3º evento
  });

  it("confirmação: is_correct calculado no servidor a partir do gabarito, mesmo se o cliente mandar isCorrect diferente", async () => {
    const { token, attemptId } = await startLearningAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) }); // B é a correta na fixture
    const response = await callRoute(`/api/player/attempts/${attemptId}/confirm`, token, {
      method: "POST",
      body: JSON.stringify({ version: 2, isCorrect: false }), // cliente tentando mentir — deve ser ignorado
    });
    expect(response.status).toBe(200);
    const row = attemptRow(attemptId);
    expect(row.status).toBe("completed");
    expect(row.is_correct).toBe(1); // servidor recalculou certo, ignorou o corpo
  });

  it("confirmar sem alternativa selecionada é rejeitado", async () => {
    const { token, attemptId } = await startLearningAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    expect(response.status).toBe(400);
  });

  it("modo recognition exige reconhecimento salvo antes de confirmar", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "recognition" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    const response = await callRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    expect(response.status).toBe(400);
  });

  it("versão desatualizada → 409", async () => {
    const { token, attemptId } = await startLearningAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    const response = await callRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 1 }) }); // já é 2
    expect(response.status).toBe(409);
  });

  it("depois de confirmada, a resposta é IMUTÁVEL — nova tentativa de PATCH answer é rejeitada", async () => {
    const { token, attemptId } = await startLearningAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    await callRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    const response = await callRoute(`/api/player/attempts/${attemptId}/answer`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 3, alternative: "C" }),
    });
    expect(response.status).toBe(400);
    expect(attemptRow(attemptId).selected_alternative).toBe("A"); // inalterada
  });

  it("CONFIRMAÇÃO ATÔMICA: falha forçada no INSERT do evento reverte também o UPDATE de estado (nenhuma escrita parcial)", async () => {
    const { token, attemptId } = await startLearningAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    db.failNextMatching(/INSERT INTO question_answer_events.*confirmed|INSERT INTO question_answer_events/);
    await expect(confirmAnswer(db as never, "u1", attemptId, 2)).rejects.toThrow();
    const row = attemptRow(attemptId);
    expect(row.status).toBe("in_progress"); // nunca chegou a completed
    expect(row.is_correct).toBeNull();
  });

  it("CORRIDA na confirmação: duas confirmações simultâneas com a MESMA versão produzem exatamente UM evento 'confirmed'", async () => {
    const qId = seedPublishedQuestion();
    const userId = "u-race-confirm";
    await seedUser(userId);
    const start = await startOrResumeAttempt(db as never, userId, qId, "learning");
    const attemptId = start.value!.attemptId;
    await saveAnswer(db as never, userId, attemptId, 1, "B");

    const [r1, r2] = await Promise.all([confirmAnswer(db as never, userId, attemptId, 2), confirmAnswer(db as never, userId, attemptId, 2)]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); // a perdedora relê e trata como idempotente, nunca erro
    const confirmedEvents = db.sqlite
      .prepare("SELECT COUNT(*) as total FROM question_answer_events WHERE attempt_id = ? AND event_type = 'confirmed'")
      .get(attemptId) as { total: number };
    expect(confirmedEvents.total).toBe(1); // exatamente UMA confirmação real
  });
});

/* ---------------------------------------------------------------------- */
/* Ajuda em quatro camadas                                                 */
/* ---------------------------------------------------------------------- */

describe("ajuda em quatro camadas", () => {
  async function startLearningAttempt(): Promise<{ token: string; attemptId: string }> {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    return { token, attemptId };
  }

  it("abre a camada 1 e registra evento", async () => {
    const { token, attemptId } = await startLearningAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    expect(response.status).toBe(200);
    expect(attemptRow(attemptId).version).toBe(2);
    expect(countRows("question_help_events", `WHERE attempt_id = '${attemptId}' AND layer = 1`)).toBe(1);
  });

  it("pular direto para a camada 3 sem abrir 1 e 2 é bloqueado", async () => {
    const { token, attemptId } = await startLearningAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/help/3`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    expect(response.status).toBe(400);
    expect(countRows("question_help_events")).toBe(0);
  });

  it("camada 4 exige confirmViewResolution explícito", async () => {
    const { token, attemptId } = await startLearningAttempt();
    for (const layer of [1, 2, 3]) {
      const r = await callRoute(`/api/player/attempts/${attemptId}/help/${layer}`, token, {
        method: "POST",
        body: JSON.stringify({ version: (await getVersion(attemptId)) }),
      });
      expect(r.status).toBe(200);
    }
    const withoutConfirm = await callRoute(`/api/player/attempts/${attemptId}/help/4`, token, {
      method: "POST",
      body: JSON.stringify({ version: await getVersion(attemptId) }),
    });
    expect(withoutConfirm.status).toBe(400);
    const withConfirm = await callRoute(`/api/player/attempts/${attemptId}/help/4`, token, {
      method: "POST",
      body: JSON.stringify({ version: await getVersion(attemptId), confirmViewResolution: true }),
    });
    expect(withConfirm.status).toBe(200);
    expect(attemptRow(attemptId).version).toBe(5); // 1 (start) + 4 aberturas
  });

  async function getVersion(attemptId: string): Promise<number> {
    return (db.sqlite.prepare("SELECT version FROM question_attempts WHERE id = ?").get(attemptId) as { version: number }).version;
  }

  it("reabrir uma camada já aberta é idempotente — não duplica evento nem avança version", async () => {
    const { token, attemptId } = await startLearningAttempt();
    await callRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    const versionAfterFirst = await getVersion(attemptId);
    const reopen = await callRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: versionAfterFirst }) });
    expect(reopen.status).toBe(200);
    expect(await getVersion(attemptId)).toBe(versionAfterFirst); // não avançou
    expect(countRows("question_help_events", `WHERE attempt_id = '${attemptId}' AND layer = 1`)).toBe(1);
  });

  it("ajuda de OUTRA tentativa → 404", async () => {
    const { attemptId } = await startLearningAttempt();
    const tokenB = await seedUserWithSession("outroAluno");
    const response = await callRoute(`/api/player/attempts/${attemptId}/help/1`, tokenB, { method: "POST", body: JSON.stringify({ version: 1 }) });
    expect(response.status).toBe(404);
  });

  it("resposta da API só devolve camadas já abertas — layer 4 (resolução) nunca aparece antes de aberta", async () => {
    const { token, attemptId } = await startLearningAttempt();
    const response = await callRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    const body = (await response.json()) as { attempt: { helpContent: Record<string, string> } };
    expect(Object.keys(body.attempt.helpContent)).toEqual(["1"]);
  });
});

/* ---------------------------------------------------------------------- */
/* Revisão e denúncia                                                      */
/* ---------------------------------------------------------------------- */

describe("salvar para revisão e denunciar problema", () => {
  it("PUT/DELETE de bookmark são idempotentes nos dois sentidos", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const put1 = await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "PUT" });
    expect(put1.status).toBe(200);
    const put2 = await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "PUT" });
    expect(put2.status).toBe(200);
    expect(countRows("question_review_bookmarks", `WHERE question_id = '${qId}'`)).toBe(1);

    const del1 = await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "DELETE" });
    expect(del1.status).toBe(200);
    const del2 = await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "DELETE" });
    expect(del2.status).toBe(200);
    expect(countRows("question_review_bookmarks", `WHERE question_id = '${qId}'`)).toBe(0);
  });

  /* Sprint 8 v1.2 — correção B (PO): bookmark sobrevive a refresh/remontagem
     via `isBookmarked` no GET da tentativa (reaproveitado — nenhum 10º
     endpoint). */
  it("bookmark, recarregar (GET da tentativa) — continua marcado como salvo", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };

    const before = (await (await callRoute(`/api/player/attempts/${attemptId}`, token, { method: "GET" })).json()) as {
      attempt: { isBookmarked: boolean };
    };
    expect(before.attempt.isBookmarked).toBe(false);

    await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "PUT" });
    const after = (await (await callRoute(`/api/player/attempts/${attemptId}`, token, { method: "GET" })).json()) as {
      attempt: { isBookmarked: boolean };
    };
    expect(after.attempt.isBookmarked).toBe(true); // "recarregar" = um novo GET, exatamente o que o refresh do navegador faz
  });

  it("desmarcar bookmark, recarregar — continua desmarcado", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };

    await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "PUT" });
    await callRoute(`/api/player/questions/${qId}/review-bookmark`, token, { method: "DELETE" });
    const after = (await (await callRoute(`/api/player/attempts/${attemptId}`, token, { method: "GET" })).json()) as {
      attempt: { isBookmarked: boolean };
    };
    expect(after.attempt.isBookmarked).toBe(false);
  });

  it("bookmark do usuário A nunca aparece no GET de tentativa do usuário B (escopado por user_id no SQL)", async () => {
    const qId = seedPublishedQuestion();
    const tokenA = await seedUserWithSession("u-bookmark-a");
    const tokenB = await seedUserWithSession("u-bookmark-b");

    await callRoute(`/api/player/questions/${qId}/review-bookmark`, tokenA, { method: "PUT" }); // só A marca

    const createB = await callRoute("/api/player/attempts", tokenB, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId: attemptIdB } = (await createB.json()) as { attemptId: string };
    const bView = (await (await callRoute(`/api/player/attempts/${attemptIdB}`, tokenB, { method: "GET" })).json()) as {
      attempt: { isBookmarked: boolean };
    };
    expect(bView.attempt.isBookmarked).toBe(false); // o bookmark de A não vaza para B

    const createA = await callRoute("/api/player/attempts", tokenA, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "practice" }) });
    const { attemptId: attemptIdA } = (await createA.json()) as { attemptId: string };
    const aView = (await (await callRoute(`/api/player/attempts/${attemptIdA}`, tokenA, { method: "GET" })).json()) as {
      attempt: { isBookmarked: boolean };
    };
    expect(aView.attempt.isBookmarked).toBe(true); // A continua vendo o próprio bookmark
  });

  it("denúncia exige categoria válida do enum fechado", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const invalid = await callRoute(`/api/player/questions/${qId}/problem-reports`, token, {
      method: "POST",
      body: JSON.stringify({ category: "categoria_livre" }),
    });
    expect(invalid.status).toBe(400);
    const valid = await callRoute(`/api/player/questions/${qId}/problem-reports`, token, {
      method: "POST",
      body: JSON.stringify({ category: "statement_problem", comment: "Enunciado confuso" }),
    });
    expect(valid.status).toBe(201);
  });

  it("comentário livre da denúncia NUNCA vai para audit_log — só id/categoria/metadados técnicos", async () => {
    const qId = seedPublishedQuestion();
    const token = await seedUserWithSession("u1");
    const secretComment = "COMENTARIO_SECRETO_QUE_NAO_PODE_VAZAR";
    await callRoute(`/api/player/questions/${qId}/problem-reports`, token, {
      method: "POST",
      body: JSON.stringify({ category: "other", comment: secretComment }),
    });
    const auditRows = db.sqlite.prepare("SELECT metadata FROM audit_log WHERE event_type = 'question_problem_reported'").all() as Array<{
      metadata: string;
    }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].metadata).not.toContain(secretComment);
  });

  it("denúncia isolada por usuário — bookmark/denúncia de um aluno não aparece para outro (escopo sempre por user_id no SQL)", async () => {
    const qId = seedPublishedQuestion();
    const tokenA = await seedUserWithSession("userA");
    await callRoute(`/api/player/questions/${qId}/review-bookmark`, tokenA, { method: "PUT" });
    const bookmarks = db.sqlite.prepare("SELECT user_id FROM question_review_bookmarks WHERE question_id = ?").all(qId) as Array<{ user_id: string }>;
    expect(bookmarks).toEqual([{ user_id: "userA" }]);
  });
});
