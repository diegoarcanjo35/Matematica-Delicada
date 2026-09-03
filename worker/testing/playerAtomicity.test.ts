// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handlePlayerRequest } from "../src/routes/player";
import { confirmAnswer, openHelpLayer, saveAnswer, saveRecognition, startOrResumeAttempt } from "../src/services/playerService";

/* Sprint 8 v1.2 — correção de atomicidade (auditoria do PO): esta suíte
   prova, DIRETAMENTE no banco (nunca só pela resposta HTTP), o invariante
   exigido para as quatro mutações do Player (reconhecimento/resposta/
   confirmação/ajuda): "um evento obrigatório existe se e somente se o
   núcleo mudou POR CAUSA DESTA MUTAÇÃO especificamente" — nunca detectado
   só depois de `db.batch()` (`meta.changes`), sempre PREVENIDO por um
   trigger `AFTER INSERT` que aborta a transação inteira antes do commit
   (ver comentário extenso em migrations/0013 e playerRepository.ts).

   Convenção desta suíte, igual a worker/testing/questions.test.ts (Sprint
   7): sempre consultar o banco diretamente (nunca só o `ok`/status da
   resposta) para confirmar que NADA foi escrito quando deveria ter sido
   revertido. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'Frase de reconhecimento', 'D', 'E', 'X', 'R', 'published')`
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

function seedPublishedQuestion(): string {
  const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1 });
  db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);
  return qId;
}

function attemptRow(id: string): {
  status: string;
  version: number;
  is_correct: number | null;
  selected_alternative: string | null;
  highest_help_layer: number;
  last_mutation_id: string | null;
  recognition_pattern_id: string | null;
} {
  return db.sqlite
    .prepare("SELECT status, version, is_correct, selected_alternative, highest_help_layer, last_mutation_id, recognition_pattern_id FROM question_attempts WHERE id = ?")
    .get(id) as never;
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

const LOCAL_ORIGIN = "http://localhost:8793";

function localEnv(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ENABLE_LOCAL_EDITORIAL_FIXTURES: "true" };
}

function requestWithCookie(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`${LOCAL_ORIGIN}${path}`, { ...init, headers });
}

async function callRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  const response = await handlePlayerRequest(request, localEnv(), url);
  return response!;
}

async function startAttempt(userId: string, mode: "learning" | "practice" | "recognition" = "learning"): Promise<{ attemptId: string; qId: string }> {
  await seedUser(userId);
  const qId = seedPublishedQuestion();
  const result = await startOrResumeAttempt(db as never, userId, qId, mode);
  return { attemptId: result.value!.attemptId, qId };
}

/** Mesma coisa, mas via a ROTA HTTP (não o serviço direto) — necessário
 *  para os testes de auditoria abaixo, já que `recordAuditEvent` roda em
 *  worker/src/routes/player.ts, não em playerService.ts. */
async function startAttemptViaRoute(
  userId: string,
  mode: "learning" | "practice" | "recognition" = "learning"
): Promise<{ token: string; attemptId: string }> {
  const token = await seedUserWithSession(userId);
  const qId = seedPublishedQuestion();
  const create = await callRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode }) });
  const { attemptId } = (await create.json()) as { attemptId: string };
  return { token, attemptId };
}

/* ---------------------------------------------------------------------- */
/* 1) Mecanismo do trigger em si: identidade divergente sempre aborta      */
/* ---------------------------------------------------------------------- */

describe("mecanismo do trigger de identidade (SQL direto, não pelo serviço)", () => {
  it("question_answer_events: INSERT cujo id NÃO bate com question_attempts.last_mutation_id reverte a transação inteira", async () => {
    const { attemptId } = await startAttempt("u-trig-answer");
    const before = attemptRow(attemptId);
    // Simula exatamente o cenário "núcleo mudou (ou nem mudou), mas o
    // evento tenta gravar uma identidade que question_attempts não mostra"
    // — a forma mais direta de provar o trigger sem depender do serviço.
    expect(() =>
      db.sqlite.exec(
        `BEGIN; INSERT INTO question_answer_events (id, attempt_id, new_alternative, event_type) VALUES ('identidade-errada', '${attemptId}', 'A', 'selected'); COMMIT;`
      )
    ).toThrow(/invariante violada/i);
    expect(countRows("question_answer_events", `WHERE attempt_id = '${attemptId}'`)).toBe(0); // nada ficou órfão
    expect(attemptRow(attemptId)).toEqual(before); // núcleo inteiramente inalterado
  });

  it("question_recognition_events: mesma prova, para a tabela de reconhecimento", async () => {
    const { attemptId } = await startAttempt("u-trig-recognition", "recognition");
    const before = attemptRow(attemptId);
    expect(() =>
      db.sqlite.exec(
        `BEGIN; INSERT INTO question_recognition_events (id, attempt_id, pattern_id, clue, strategy, attempt_version) VALUES ('identidade-errada', '${attemptId}', 'pat-1', 'x', 'y', 2); COMMIT;`
      )
    ).toThrow(/invariante violada/i);
    expect(countRows("question_recognition_events", `WHERE attempt_id = '${attemptId}'`)).toBe(0);
    expect(attemptRow(attemptId)).toEqual(before);
  });

  it("question_help_events: mesma prova, para a tabela de ajuda", async () => {
    const { attemptId } = await startAttempt("u-trig-help");
    const before = attemptRow(attemptId);
    expect(() =>
      db.sqlite.exec(`BEGIN; INSERT INTO question_help_events (id, attempt_id, layer) VALUES ('identidade-errada', '${attemptId}', 1); COMMIT;`)
    ).toThrow(/invariante violada/i);
    expect(countRows("question_help_events", `WHERE attempt_id = '${attemptId}'`)).toBe(0);
    expect(attemptRow(attemptId)).toEqual(before);
  });
});

/* ---------------------------------------------------------------------- */
/* 2) Conflito de versão real: núcleo não muda, evento nunca fica órfão   */
/* ---------------------------------------------------------------------- */

describe("conflito de versão real produz zero evento órfão (por tipo de mutação)", () => {
  it("reconhecimento: versão desatualizada → conflict, zero evento novo", async () => {
    const { attemptId } = await startAttempt("u-conflict-recognition", "recognition");
    const before = countRows("question_recognition_events");
    const result = await saveRecognition(db as never, "u-conflict-recognition", attemptId, 99, { patternSlug: "padrao-1", clue: "x", strategy: "y" });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("question_recognition_events")).toBe(before);
    expect(attemptRow(attemptId).recognition_pattern_id).toBeNull();
  });

  it("resposta: versão desatualizada → conflict, zero evento novo", async () => {
    const { attemptId } = await startAttempt("u-conflict-answer");
    const before = countRows("question_answer_events");
    const result = await saveAnswer(db as never, "u-conflict-answer", attemptId, 99, "A");
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("question_answer_events")).toBe(before);
    expect(attemptRow(attemptId).selected_alternative).toBeNull();
  });

  it("confirmação: versão desatualizada → conflict, zero evento novo", async () => {
    const { attemptId } = await startAttempt("u-conflict-confirm");
    await saveAnswer(db as never, "u-conflict-confirm", attemptId, 1, "B");
    const before = countRows("question_answer_events");
    const result = await confirmAnswer(db as never, "u-conflict-confirm", attemptId, 99);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("question_answer_events")).toBe(before); // nenhum 'confirmed' novo
    expect(attemptRow(attemptId).status).toBe("in_progress");
  });

  it("ajuda: versão desatualizada → conflict, zero evento novo", async () => {
    const { attemptId } = await startAttempt("u-conflict-help");
    const before = countRows("question_help_events");
    const result = await openHelpLayer(db as never, "u-conflict-help", attemptId, 99, 1, false);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(countRows("question_help_events")).toBe(before);
    expect(attemptRow(attemptId).highest_help_layer).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* 3) Falha genuína de SQL ao gravar o evento reverte TUDO (nenhuma       */
/*    escrita parcial) — confirmação já coberta em playerAttempts.test.ts */
/* ---------------------------------------------------------------------- */

describe("falha genuína de SQL no INSERT do evento reverte também o UPDATE central", () => {
  it("reconhecimento: INSERT do evento forçado a falhar não deixa núcleo mudado", async () => {
    const { attemptId } = await startAttempt("u-fail-recognition", "recognition");
    db.failNextMatching(/INSERT INTO question_recognition_events/);
    await expect(
      saveRecognition(db as never, "u-fail-recognition", attemptId, 1, { patternSlug: "padrao-1", clue: "x", strategy: "y" })
    ).rejects.toThrow();
    const row = attemptRow(attemptId);
    expect(row.version).toBe(1); // nunca avançou
    expect(row.recognition_pattern_id).toBeNull();
    expect(countRows("question_recognition_events")).toBe(0);
  });

  it("resposta: INSERT do evento forçado a falhar não deixa núcleo mudado", async () => {
    const { attemptId } = await startAttempt("u-fail-answer");
    db.failNextMatching(/INSERT INTO question_answer_events/);
    await expect(saveAnswer(db as never, "u-fail-answer", attemptId, 1, "A")).rejects.toThrow();
    const row = attemptRow(attemptId);
    expect(row.version).toBe(1);
    expect(row.selected_alternative).toBeNull();
    expect(countRows("question_answer_events")).toBe(0);
  });

  it("ajuda: INSERT do evento forçado a falhar não deixa núcleo mudado", async () => {
    const { attemptId } = await startAttempt("u-fail-help");
    db.failNextMatching(/INSERT INTO question_help_events/);
    await expect(openHelpLayer(db as never, "u-fail-help", attemptId, 1, 1, false)).rejects.toThrow();
    const row = attemptRow(attemptId);
    expect(row.version).toBe(1);
    expect(row.highest_help_layer).toBe(0);
    expect(countRows("question_help_events")).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* 4) Corridas reais: exatamente UMA mutação, UM evento — confirmação já   */
/*    coberta em playerAttempts.test.ts ("CORRIDA na confirmação")        */
/* ---------------------------------------------------------------------- */

describe("corrida real com a MESMA versão produz exatamente UMA mutação e UM evento", () => {
  it("reconhecimento: duas chamadas concorrentes, mesma versão → um único evento salvo", async () => {
    const { attemptId } = await startAttempt("u-race-recognition", "recognition");
    const [r1, r2] = await Promise.all([
      saveRecognition(db as never, "u-race-recognition", attemptId, 1, { patternSlug: "padrao-1", clue: "a", strategy: "b" }),
      saveRecognition(db as never, "u-race-recognition", attemptId, 1, { patternSlug: "padrao-1", clue: "a", strategy: "b" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); // a perdedora relê e vê o resultado idêntico → idempotente
    expect(countRows("question_recognition_events", `WHERE attempt_id = '${attemptId}'`)).toBe(1);
    expect(attemptRow(attemptId).version).toBe(2); // só avançou uma vez
  });

  it("resposta: duas chamadas concorrentes, mesma versão e mesma alternativa → um único evento 'selected'", async () => {
    const { attemptId } = await startAttempt("u-race-answer");
    const [r1, r2] = await Promise.all([
      saveAnswer(db as never, "u-race-answer", attemptId, 1, "A"),
      saveAnswer(db as never, "u-race-answer", attemptId, 1, "A"),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(countRows("question_answer_events", `WHERE attempt_id = '${attemptId}'`)).toBe(1);
    expect(attemptRow(attemptId).version).toBe(2);
  });

  it("ajuda: duas chamadas concorrentes abrindo a mesma camada → um único evento para aquela camada", async () => {
    const { attemptId } = await startAttempt("u-race-help");
    const [r1, r2] = await Promise.all([
      openHelpLayer(db as never, "u-race-help", attemptId, 1, 1, false),
      openHelpLayer(db as never, "u-race-help", attemptId, 1, 1, false),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(countRows("question_help_events", `WHERE attempt_id = '${attemptId}' AND layer = 1`)).toBe(1);
    expect(attemptRow(attemptId).version).toBe(2);
  });
});

/* ---------------------------------------------------------------------- */
/* 5) Auditoria só na mutação REAL, nunca em repetição idempotente        */
/* ---------------------------------------------------------------------- */

describe("audit_log só é gravado quando changed === true", () => {
  it("selecionar a mesma alternativa duas vezes (via rota HTTP) grava só UM evento de auditoria (question_answer_selected)", async () => {
    const { token, attemptId } = await startAttemptViaRoute("u-audit-answer");
    await callRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "A" }) });
    const repeat = await callRoute(`/api/player/attempts/${attemptId}/answer`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 2, alternative: "A" }), // idêntico — changed:false no serviço
    });
    expect(repeat.status).toBe(200);
    const auditRows = countRows("audit_log", `WHERE event_type = 'question_answer_selected' AND user_id = 'u-audit-answer'`);
    expect(auditRows).toBe(1); // não duplicou por causa da repetição idempotente
  });

  it("reabrir uma camada já aberta (via rota HTTP) não grava um segundo evento de auditoria (question_help_opened)", async () => {
    const { token, attemptId } = await startAttemptViaRoute("u-audit-help");
    await callRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    const reopen = await callRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    expect(reopen.status).toBe(200);
    const auditRows = countRows("audit_log", `WHERE event_type = 'question_help_opened' AND user_id = 'u-audit-help'`);
    expect(auditRows).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* 6) Sprint 16 v1.0 (A3) — student_pattern_progress: escrita mínima e     */
/*    factual, no MESMO lote atômico do reconhecimento, nunca inventando  */
/*    índice/score algum.                                                 */
/* ---------------------------------------------------------------------- */

function progressRow(
  userId: string,
  patternId: string
): {
  raw_evidence_count: number;
  last_practiced_at: string | null;
  next_review_at: string | null;
  recognition_index: number | null;
  resolution_index: number | null;
  mastery_index: number | null;
} | null {
  return (
    (db.sqlite
      .prepare(
        "SELECT raw_evidence_count, last_practiced_at, next_review_at, recognition_index, resolution_index, mastery_index FROM student_pattern_progress WHERE user_id = ? AND pattern_id = ?"
      )
      .get(userId, patternId) as never) ?? null
  );
}

describe("student_pattern_progress: evidência real, mínima e factual (A3)", () => {
  it("reconhecimento genuíno cria a linha de progresso com raw_evidence_count=1 e nenhum índice inventado", async () => {
    const { attemptId } = await startAttempt("u-progress-new", "recognition");
    expect(progressRow("u-progress-new", "pat-1")).toBeNull(); // nada antes

    const result = await saveRecognition(db as never, "u-progress-new", attemptId, 1, {
      patternSlug: "padrao-1",
      clue: "reconheço pelo enunciado",
      strategy: "isolar a variável",
    });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const row = progressRow("u-progress-new", "pat-1");
    expect(row).not.toBeNull();
    expect(row!.raw_evidence_count).toBe(1);
    expect(row!.last_practiced_at).not.toBeNull();
    // Nunca zero, nunca um cálculo improvisado — só ausência real (NULL).
    expect(row!.next_review_at).toBeNull();
    expect(row!.recognition_index).toBeNull();
    expect(row!.resolution_index).toBeNull();
    expect(row!.mastery_index).toBeNull();
  });

  it("uma segunda evidência real (outra tentativa) incrementa raw_evidence_count para 2", async () => {
    const first = await startAttempt("u-progress-two", "recognition");
    await saveRecognition(db as never, "u-progress-two", first.attemptId, 1, { patternSlug: "padrao-1", clue: "a", strategy: "b" });

    const qId2 = seedPublishedQuestion();
    const second = await startOrResumeAttempt(db as never, "u-progress-two", qId2, "recognition");
    await saveRecognition(db as never, "u-progress-two", second.value!.attemptId, 1, {
      patternSlug: "padrao-1",
      clue: "c",
      strategy: "d",
    });

    expect(progressRow("u-progress-two", "pat-1")!.raw_evidence_count).toBe(2);
  });

  it("repetição idêntica (idempotente, changed:false) NÃO incrementa raw_evidence_count de novo", async () => {
    const { attemptId } = await startAttempt("u-progress-idem", "recognition");
    await saveRecognition(db as never, "u-progress-idem", attemptId, 1, { patternSlug: "padrao-1", clue: "a", strategy: "b" });
    expect(progressRow("u-progress-idem", "pat-1")!.raw_evidence_count).toBe(1);

    const repeat = await saveRecognition(db as never, "u-progress-idem", attemptId, 2, {
      patternSlug: "padrao-1",
      clue: "a",
      strategy: "b",
    });
    expect(repeat.ok).toBe(true);
    expect(repeat.changed).toBe(false);
    expect(progressRow("u-progress-idem", "pat-1")!.raw_evidence_count).toBe(1); // inalterado
  });

  it("conflito de versão real (409) não cria nenhuma linha de progresso", async () => {
    const { attemptId } = await startAttempt("u-progress-conflict", "recognition");
    const result = await saveRecognition(db as never, "u-progress-conflict", attemptId, 99, {
      patternSlug: "padrao-1",
      clue: "a",
      strategy: "b",
    });
    expect(result.conflict).toBe(true);
    expect(progressRow("u-progress-conflict", "pat-1")).toBeNull();
  });

  it("falha genuína de SQL no INSERT do evento de reconhecimento reverte também o progresso do padrão (atomicidade)", async () => {
    const { attemptId } = await startAttempt("u-progress-fail", "recognition");
    db.failNextMatching(/INSERT INTO question_recognition_events/);
    await expect(
      saveRecognition(db as never, "u-progress-fail", attemptId, 1, { patternSlug: "padrao-1", clue: "a", strategy: "b" })
    ).rejects.toThrow();
    expect(progressRow("u-progress-fail", "pat-1")).toBeNull(); // nenhuma escrita parcial
  });
});
