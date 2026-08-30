// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedDiagnosticFixtures, TEST_QUESTIONS } from "./diagnosticFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import {
  completeAttempt,
  createAttempt,
  getAttemptDetail,
  getResult,
  getStatus,
  openHelp,
  saveResponse,
} from "../src/services/diagnosticService";
import { findAttempt, listResponses } from "../src/repositories/diagnosticRepository";
import { handleDiagnosticRequest } from "../src/routes/diagnostic";
import { TIME_SPENT_MS_MAX } from "../src/lib/diagnosticValidation";

/* Sprint 4 v1.0 — testes de dados/API do diagnóstico, seguindo o mesmo seam
   das Sprints 2/3 (SQLite real via node:sqlite, ver worker/testing/fakeD1.ts). */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
  seedDiagnosticFixtures(db.sqlite);
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

function requestWithCookie(path: string, method: string, token: string | null, body?: unknown): Request {
  const headers = new Headers();
  if (token) headers.set("Cookie", `md_session=${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://matematica-delicada.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const FIXTURES_ALLOWED = true;
const FIXTURES_BLOCKED = false;

describe("diagnóstico — status e disponibilidade", () => {
  it("1. indisponível fora do ambiente local autorizado — nenhuma questão é carregada", async () => {
    await seedUser("user-1");
    const status = await getStatus(db as never, "user-1", FIXTURES_BLOCKED);
    expect(status.available).toBe(false);
    expect(status.activeAttemptId).toBeNull();

    const created = await createAttempt(db as never, "user-1", FIXTURES_BLOCKED, false);
    expect(created.ok).toBe(false);
    expect(created.reason).toBe("unavailable");
  });

  it("2. disponível quando o gate está satisfeito", async () => {
    await seedUser("user-2");
    const status = await getStatus(db as never, "user-2", FIXTURES_ALLOWED);
    expect(status.available).toBe(true);
  });
});

describe("diagnóstico — criação e retomada de tentativa", () => {
  it("3. criação da tentativa inclui todas as questões do catálogo, na ordem", async () => {
    await seedUser("user-3");
    const result = await createAttempt(db as never, "user-3", FIXTURES_ALLOWED, false);
    expect(result.ok).toBe(true);

    const detail = await getAttemptDetail(db as never, "user-3", result.attemptId!);
    expect(detail?.questions.map((q) => q.id)).toEqual(TEST_QUESTIONS.map((q) => q.id));
    expect(detail?.status).toBe("in_progress");
  });

  it("4. tentativa em andamento é retomável (mesmo attemptId no status)", async () => {
    await seedUser("user-4");
    const result = await createAttempt(db as never, "user-4", FIXTURES_ALLOWED, false);
    const status = await getStatus(db as never, "user-4", FIXTURES_ALLOWED);
    expect(status.activeAttemptId).toBe(result.attemptId);
  });

  it("5. criar de novo sem restart, com tentativa ativa, é rejeitado", async () => {
    await seedUser("user-5");
    const first = await createAttempt(db as never, "user-5", FIXTURES_ALLOWED, false);
    const second = await createAttempt(db as never, "user-5", FIXTURES_ALLOWED, false);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("active_exists");
    expect(second.attemptId).toBe(first.attemptId);
  });

  it("6. reinício explícito (restart) abandona a anterior e preserva seu histórico", async () => {
    await seedUser("user-6");
    const first = await createAttempt(db as never, "user-6", FIXTURES_ALLOWED, false);
    await saveResponse(db as never, "user-6", first.attemptId!, "test-q1", { optionId: "test-q1-a" });

    const second = await createAttempt(db as never, "user-6", FIXTURES_ALLOWED, true);
    expect(second.ok).toBe(true);
    expect(second.attemptId).not.toBe(first.attemptId);

    const oldAttempt = await findAttempt(db as never, first.attemptId!);
    expect(oldAttempt?.status).toBe("abandoned");
    // Histórico preservado — a resposta antiga continua no banco.
    const oldResponses = await listResponses(db as never, first.attemptId!);
    expect(oldResponses).toHaveLength(1);
  });
});

describe("diagnóstico — isolamento entre usuários", () => {
  it("7. tentativa de um usuário não é visível/editável por outro", async () => {
    await seedUser("user-7-a");
    await seedUser("user-7-b");
    const attemptA = await createAttempt(db as never, "user-7-a", FIXTURES_ALLOWED, false);

    const detailForB = await getAttemptDetail(db as never, "user-7-b", attemptA.attemptId!);
    expect(detailForB).toBeNull();

    const saveByB = await saveResponse(db as never, "user-7-b", attemptA.attemptId!, "test-q1", {
      optionId: "test-q1-a",
    });
    expect(saveByB.ok).toBe(false);
    expect(saveByB.notFound).toBe(true);
  });
});

describe("diagnóstico — questão entregue sem gabarito", () => {
  it("8. getAttemptDetail nunca inclui is_correct das alternativas nem do reconhecimento", async () => {
    await seedUser("user-8");
    const attempt = await createAttempt(db as never, "user-8", FIXTURES_ALLOWED, false);
    const detail = await getAttemptDetail(db as never, "user-8", attempt.attemptId!);

    const raw = JSON.stringify(detail);
    expect(raw).not.toMatch(/is_correct/);
    expect(raw).not.toMatch(/isCorrect/);
    const question1 = detail?.questions.find((q) => q.id === "test-q1");
    expect(question1?.options[0]).toEqual({ id: "test-q1-a", text: "Opção A" });
  });
});

describe("diagnóstico — resposta calculada no Worker", () => {
  it("9. alternativa de outra questão é rejeitada", async () => {
    await seedUser("user-9");
    const attempt = await createAttempt(db as never, "user-9", FIXTURES_ALLOWED, false);
    const result = await saveResponse(db as never, "user-9", attempt.attemptId!, "test-q1", {
      optionId: "test-q2-a", // pertence à questão 2, não à 1
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.optionId).toBeDefined();
  });

  it("10. is_correct nunca é aceito do cliente — sempre recalculado no servidor", async () => {
    await seedUser("user-10");
    const attempt = await createAttempt(db as never, "user-10", FIXTURES_ALLOWED, false);
    // Envia optionId errado junto de um isCorrect=true forjado — o forjado é
    // ignorado (o tipo do serviço nem aceita esse campo do cliente).
    await saveResponse(db as never, "user-10", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-b", // errada
      isCorrect: true, // forjado — não existe no tipo aceito pelo serviço
    } as never);

    const responses = await listResponses(db as never, attempt.attemptId!);
    expect(responses[0].is_correct).toBe(0); // calculado pelo servidor a partir da opção real
  });

  it('11. "não sei por onde começar" é aceito sem alternativa selecionada', async () => {
    await seedUser("user-11");
    const attempt = await createAttempt(db as never, "user-11", FIXTURES_ALLOWED, false);
    const result = await saveResponse(db as never, "user-11", attempt.attemptId!, "test-q1", {
      isDontKnow: true,
    });
    expect(result.ok).toBe(true);
    const responses = await listResponses(db as never, attempt.attemptId!);
    expect(responses[0].is_dont_know).toBe(1);
    expect(responses[0].selected_option_id).toBeNull();
    expect(responses[0].is_correct).toBeNull();
  });

  it("12. resposta é idempotente — reenviar substitui sem duplicar linha", async () => {
    await seedUser("user-12");
    const attempt = await createAttempt(db as never, "user-12", FIXTURES_ALLOWED, false);
    await saveResponse(db as never, "user-12", attempt.attemptId!, "test-q1", { optionId: "test-q1-a" });
    await saveResponse(db as never, "user-12", attempt.attemptId!, "test-q1", { optionId: "test-q1-b" });

    const responses = await listResponses(db as never, attempt.attemptId!);
    expect(responses).toHaveLength(1);
    expect(responses[0].selected_option_id).toBe("test-q1-b");
  });
});

describe("diagnóstico — camadas de ajuda", () => {
  it("13. abertura progressiva das quatro camadas retorna o conteúdo de cada uma", async () => {
    await seedUser("user-13");
    const attempt = await createAttempt(db as never, "user-13", FIXTURES_ALLOWED, false);
    for (const layer of [1, 2, 3, 4]) {
      const result = await openHelp(db as never, "user-13", attempt.attemptId!, "test-q1", layer);
      expect(result.ok).toBe(true);
      expect(result.content).toContain(`questão 1`);
    }
    const detail = await getAttemptDetail(db as never, "user-13", attempt.attemptId!);
    const question1 = detail?.questions.find((q) => q.id === "test-q1");
    expect(question1?.helpLayersOpened.sort()).toEqual([1, 2, 3, 4]);
  });

  it("14. camada fora de 1-4 é rejeitada", async () => {
    await seedUser("user-14");
    const attempt = await createAttempt(db as never, "user-14", FIXTURES_ALLOWED, false);
    const result = await openHelp(db as never, "user-14", attempt.attemptId!, "test-q1", 5);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.layer).toBeDefined();
  });

  it("15. reabrir a mesma camada é idempotente — não duplica registro", async () => {
    await seedUser("user-15");
    const attempt = await createAttempt(db as never, "user-15", FIXTURES_ALLOWED, false);
    await openHelp(db as never, "user-15", attempt.attemptId!, "test-q1", 1);
    await openHelp(db as never, "user-15", attempt.attemptId!, "test-q1", 1);

    const rows = db.sqlite
      .prepare("SELECT COUNT(*) as count FROM diagnostic_help_opens WHERE attempt_id = ? AND question_id = ? AND layer = 1")
      .get(attempt.attemptId, "test-q1") as { count: number };
    expect(rows.count).toBe(1);
  });
});

describe("diagnóstico — conclusão", () => {
  async function answerAll(userId: string, attemptId: string) {
    await saveResponse(db as never, userId, attemptId, "test-q1", { optionId: "test-q1-a" });
    await saveResponse(db as never, userId, attemptId, "test-q2", { optionId: "test-q2-b" });
    await saveResponse(db as never, userId, attemptId, "test-q3", { isDontKnow: true });
  }

  it("16. conclusão incompleta é rejeitada", async () => {
    await seedUser("user-16");
    const attempt = await createAttempt(db as never, "user-16", FIXTURES_ALLOWED, false);
    await saveResponse(db as never, "user-16", attempt.attemptId!, "test-q1", { optionId: "test-q1-a" });

    const result = await completeAttempt(db as never, "user-16", attempt.attemptId!);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.questions).toBeDefined();

    const row = await findAttempt(db as never, attempt.attemptId!);
    expect(row?.status).toBe("in_progress");
  });

  it("17. conclusão completa e idempotente", async () => {
    await seedUser("user-17");
    const attempt = await createAttempt(db as never, "user-17", FIXTURES_ALLOWED, false);
    await answerAll("user-17", attempt.attemptId!);

    const first = await completeAttempt(db as never, "user-17", attempt.attemptId!);
    const second = await completeAttempt(db as never, "user-17", attempt.attemptId!);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.alreadyCompleted).toBe(true);

    const row = await findAttempt(db as never, attempt.attemptId!);
    expect(row?.status).toBe("completed");
  });

  it("18. corrida de conclusão — chamadas concorrentes resultam em exatamente uma transição real", async () => {
    await seedUser("user-18");
    const attempt = await createAttempt(db as never, "user-18", FIXTURES_ALLOWED, false);
    await answerAll("user-18", attempt.attemptId!);

    const [a, b] = await Promise.all([
      completeAttempt(db as never, "user-18", attempt.attemptId!),
      completeAttempt(db as never, "user-18", attempt.attemptId!),
    ]);
    const realTransitions = [a.alreadyCompleted, b.alreadyCompleted].filter((already) => !already).length;
    expect(realTransitions).toBe(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("19. tentativa concluída é imutável — nova resposta e nova ajuda são rejeitadas", async () => {
    await seedUser("user-19");
    const attempt = await createAttempt(db as never, "user-19", FIXTURES_ALLOWED, false);
    await answerAll("user-19", attempt.attemptId!);
    await completeAttempt(db as never, "user-19", attempt.attemptId!);

    const saveResult = await saveResponse(db as never, "user-19", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-b",
    });
    expect(saveResult.ok).toBe(false);

    const helpResult = await openHelp(db as never, "user-19", attempt.attemptId!, "test-q2", 1);
    expect(helpResult.ok).toBe(false);

    // A resposta original continua intacta.
    const responses = await listResponses(db as never, attempt.attemptId!);
    const q1Response = responses.find((r) => r.question_id === "test-q1");
    expect(q1Response?.selected_option_id).toBe("test-q1-a");
  });
});

describe("diagnóstico — rollback em falha forçada", () => {
  it("20. falha forçada na inserção das questões da tentativa reverte a criação inteira", async () => {
    await seedUser("user-20");
    db.failNextMatching(/INSERT INTO diagnostic_attempt_questions/);

    await expect(createAttempt(db as never, "user-20", FIXTURES_ALLOWED, false)).rejects.toThrow();

    const status = await getStatus(db as never, "user-20", FIXTURES_ALLOWED);
    expect(status.activeAttemptId).toBeNull();
    const countRow = db.sqlite.prepare("SELECT COUNT(*) as count FROM diagnostic_attempts WHERE user_id = ?").get(
      "user-20"
    ) as { count: number };
    expect(countRow.count).toBe(0);
  });
});

describe("diagnóstico — resultado estritamente factual", () => {
  it("21. resultado só contém contagens factuais, nunca TRI/índice/nível", async () => {
    await seedUser("user-21");
    const attempt = await createAttempt(db as never, "user-21", FIXTURES_ALLOWED, false);
    await saveResponse(db as never, "user-21", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-a",
      recognitionOptionId: "test-q1-r-a",
      timeSpentMs: 5000,
    });
    await saveResponse(db as never, "user-21", attempt.attemptId!, "test-q2", { optionId: "test-q2-a" }); // errada
    await saveResponse(db as never, "user-21", attempt.attemptId!, "test-q3", { isDontKnow: true });
    await openHelp(db as never, "user-21", attempt.attemptId!, "test-q2", 1);
    await completeAttempt(db as never, "user-21", attempt.attemptId!);

    const result = await getResult(db as never, "user-21", attempt.attemptId!);
    expect(result).not.toBeNull();
    expect(result!.totalQuestions).toBe(3);
    expect(result!.answeredCount).toBe(3);
    expect(result!.correctCount).toBe(1);
    expect(result!.dontKnowCount).toBe(1);
    expect(result!.totalTimeMs).toBe(5000);
    expect(result!.recognitionConfiguredCount).toBe(1);
    expect(result!.recognitionInformedCount).toBe(1);
    expect(result!.recognitionCorrectCount).toBe(1);
    expect(result!.helpOpensByLayer[1]).toBe(1);
    expect(result!.disclaimer).toContain("provisório");

    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toMatch(/tri\b/);
    expect(serialized).not.toMatch(/índice/);
    expect(serialized).not.toMatch(/indice/);
    expect(serialized).not.toMatch(/nível/);
    expect(serialized).not.toMatch(/nivel/);
    expect(serialized).not.toMatch(/domínio/);
    expect(serialized).not.toMatch(/dominio/);
  });

  it("22. resultado não existe para tentativa não concluída", async () => {
    await seedUser("user-22");
    const attempt = await createAttempt(db as never, "user-22", FIXTURES_ALLOWED, false);
    const result = await getResult(db as never, "user-22", attempt.attemptId!);
    expect(result).toBeNull();
  });
});

describe("diagnóstico — rotas HTTP: auditoria sem conteúdo sensível", () => {
  it("23. eventos de auditoria nunca contêm enunciado, alternativa ou gabarito", async () => {
    const token = await seedUserWithSession("user-23");
    const localEnv = { DB: db, ENVIRONMENT: "test", ENABLE_LOCAL_DIAGNOSTIC_FIXTURES: "true" } as never;

    const createRequest = requestWithCookie("/api/diagnostic/attempts", "POST", token, {});
    const createResponse = await handleDiagnosticRequest(
      createRequest,
      localEnv,
      new URL("http://localhost/api/diagnostic/attempts")
    );
    expect(createResponse?.status).toBe(201);
    const { attemptId } = (await createResponse!.json()) as { attemptId: string };

    const responseRequest = requestWithCookie(
      `/api/diagnostic/attempts/${attemptId}/responses/test-q1`,
      "PATCH",
      token,
      { optionId: "test-q1-a" }
    );
    await handleDiagnosticRequest(
      responseRequest,
      localEnv,
      new URL(`http://localhost/api/diagnostic/attempts/${attemptId}/responses/test-q1`)
    );

    const events = db.sqlite
      .prepare("SELECT event_type, metadata FROM audit_log WHERE user_id = ?")
      .all("user-23") as Array<{ event_type: string; metadata: string | null }>;

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const metadata = event.metadata ?? "";
      expect(metadata).not.toMatch(/Opção/);
      expect(metadata).not.toMatch(/test-q1-a/);
      expect(metadata).not.toMatch(/PROVISÓRIO/);
    }
  });
});

/* Correção B (Ordem de Correção e Fechamento v1.1) — comprovação conjunta e
   explícita de que o reinício preserva histórico, não herda respostas, é
   auditado com metadados mínimos e não pode ser usado para afetar a
   tentativa de outro usuário. O teste 6 já cobria os pontos 1/2/4; os
   pontos 3/5/7 estavam implementados mas sem prova direta — o ponto 6
   ("sem confirmação pela interface não ocorre") é uma garantia de UI, não
   de API, e está coberto em e2e/diagnostic.spec.ts. */
describe("diagnóstico — reinício com preservação de histórico (comprovação completa)", () => {
  it("tentativa reiniciada (B) não herda nenhuma resposta da tentativa anterior (A)", async () => {
    await seedUser("user-restart-fresh");
    const first = await createAttempt(db as never, "user-restart-fresh", FIXTURES_ALLOWED, false);
    await saveResponse(db as never, "user-restart-fresh", first.attemptId!, "test-q1", {
      optionId: "test-q1-a",
    });
    await saveResponse(db as never, "user-restart-fresh", first.attemptId!, "test-q2", {
      optionId: "test-q2-b",
    });

    const second = await createAttempt(db as never, "user-restart-fresh", FIXTURES_ALLOWED, true);
    expect(second.attemptId).not.toBe(first.attemptId);

    const detailB = await getAttemptDetail(db as never, "user-restart-fresh", second.attemptId!);
    expect(detailB?.questions.every((question) => !question.answered)).toBe(true);

    const responsesB = await listResponses(db as never, second.attemptId!);
    expect(responsesB).toHaveLength(0);

    // A permanece exatamente como estava — nem apagada, nem alterada.
    const responsesA = await listResponses(db as never, first.attemptId!);
    expect(responsesA).toHaveLength(2);
    const attemptA = await findAttempt(db as never, first.attemptId!);
    expect(attemptA?.status).toBe("abandoned");
  });

  it("evento diagnostic_restarted é registrado com metadados mínimos, sem resposta/enunciado", async () => {
    const token = await seedUserWithSession("user-restart-audit");
    const localEnv = { DB: db, ENVIRONMENT: "test", ENABLE_LOCAL_DIAGNOSTIC_FIXTURES: "true" } as never;

    const firstRequest = requestWithCookie("/api/diagnostic/attempts", "POST", token, {});
    const firstResponse = await handleDiagnosticRequest(
      firstRequest,
      localEnv,
      new URL("http://localhost/api/diagnostic/attempts")
    );
    const { attemptId: firstAttemptId } = (await firstResponse!.json()) as { attemptId: string };
    await saveResponse(db as never, "user-restart-audit", firstAttemptId, "test-q1", {
      optionId: "test-q1-a",
    });

    const restartRequest = requestWithCookie("/api/diagnostic/attempts", "POST", token, { restart: true });
    const restartResponse = await handleDiagnosticRequest(
      restartRequest,
      localEnv,
      new URL("http://localhost/api/diagnostic/attempts")
    );
    expect(restartResponse?.status).toBe(201);

    const restartEvents = db.sqlite
      .prepare("SELECT metadata FROM audit_log WHERE user_id = ? AND event_type = 'diagnostic_restarted'")
      .all("user-restart-audit") as Array<{ metadata: string | null }>;
    expect(restartEvents).toHaveLength(1);
    // Sem metadados de negócio nenhum — nem IDs de questão/resposta, muito
    // menos enunciado, alternativa ou gabarito (seção 3.5 da ordem v1.1).
    expect(restartEvents[0].metadata).toBeNull();
  });

  it("reinício de um usuário não afeta a tentativa ativa de outro usuário", async () => {
    await seedUser("user-restart-victim");
    await seedUser("user-restart-attacker");
    const victimAttempt = await createAttempt(db as never, "user-restart-victim", FIXTURES_ALLOWED, false);
    await createAttempt(db as never, "user-restart-attacker", FIXTURES_ALLOWED, false);

    // O endpoint de reinício nunca aceita um attemptId — opera só sobre a
    // tentativa ativa DO PRÓPRIO chamador, então não existe parâmetro por
    // onde o atacante poderia sequer tentar apontar para a tentativa da
    // vítima. Esta prova confirma que a tentativa da vítima realmente não
    // é tocada quando outro usuário reinicia a própria.
    await createAttempt(db as never, "user-restart-attacker", FIXTURES_ALLOWED, true);

    const victimAfter = await findAttempt(db as never, victimAttempt.attemptId!);
    expect(victimAfter?.status).toBe("in_progress");
    expect(victimAfter?.id).toBe(victimAttempt.attemptId);
  });
});

/* Correção C (Ordem de Correção e Fechamento v1.1) — origem, cálculo e
   limites do tempo registrado. O motor mede tempo aproximado por questão,
   reportado pelo cliente e saturado no servidor (worker/src/lib/
   diagnosticValidation.ts:TIME_SPENT_MS_MAX) — nunca uma medida pedagógica
   nem uma reconstrução independente a partir de timestamps de requisição.
   Ver docs/DIAGNOSTICO.md, seção "Origem e limites do tempo registrado". */
describe("diagnóstico — origem e limites do tempo registrado", () => {
  it("tempo negativo é rejeitado — nenhuma resposta é persistida", async () => {
    await seedUser("user-time-negative");
    const attempt = await createAttempt(db as never, "user-time-negative", FIXTURES_ALLOWED, false);

    const result = await saveResponse(db as never, "user-time-negative", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-a",
      timeSpentMs: -500,
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.timeSpentMs).toBeDefined();

    const responses = await listResponses(db as never, attempt.attemptId!);
    expect(responses).toHaveLength(0);
  });

  it("tempo não numérico/fracionário é rejeitado", async () => {
    await seedUser("user-time-invalid");
    const attempt = await createAttempt(db as never, "user-time-invalid", FIXTURES_ALLOWED, false);

    const result = await saveResponse(db as never, "user-time-invalid", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-a",
      timeSpentMs: "muito tempo" as unknown,
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.timeSpentMs).toBeDefined();
  });

  it("tempo absurdamente alto (payload adulterado) é saturado, nunca rejeitado nem aceito integralmente", async () => {
    await seedUser("user-time-huge");
    const attempt = await createAttempt(db as never, "user-time-huge", FIXTURES_ALLOWED, false);

    const result = await saveResponse(db as never, "user-time-huge", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-a",
      timeSpentMs: 999_999_999,
    });
    expect(result.ok).toBe(true);

    const responses = await listResponses(db as never, attempt.attemptId!);
    expect(responses[0].time_spent_ms).toBe(TIME_SPENT_MS_MAX);
  });

  it("retomada (nova leitura da tentativa) não duplica nem zera o tempo já persistido de outra questão", async () => {
    await seedUser("user-time-resume");
    const attempt = await createAttempt(db as never, "user-time-resume", FIXTURES_ALLOWED, false);

    await saveResponse(db as never, "user-time-resume", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-a",
      timeSpentMs: 12_000,
    });

    // Simula o refresh/retomada: relê o estado da tentativa (mesmo caminho
    // usado pelo frontend ao remontar a página) sem reenviar nada de q1.
    await getAttemptDetail(db as never, "user-time-resume", attempt.attemptId!);
    await saveResponse(db as never, "user-time-resume", attempt.attemptId!, "test-q2", {
      optionId: "test-q2-b",
      timeSpentMs: 8_000,
    });

    const responses = await listResponses(db as never, attempt.attemptId!);
    const q1 = responses.find((response) => response.question_id === "test-q1");
    expect(q1?.time_spent_ms).toBe(12_000);
  });

  it("resultado soma o tempo persistido por questão — nunca aceita um total/média enviado pelo cliente", async () => {
    await seedUser("user-time-summary");
    const attempt = await createAttempt(db as never, "user-time-summary", FIXTURES_ALLOWED, false);

    // SaveResponseInput não tem campo de total/média — não há sequer como o
    // cliente enviar um valor agregado; esta prova confirma que a soma bate
    // exatamente com os tempos por questão persistidos no servidor.
    await saveResponse(db as never, "user-time-summary", attempt.attemptId!, "test-q1", {
      optionId: "test-q1-a",
      timeSpentMs: 10_000,
    });
    await saveResponse(db as never, "user-time-summary", attempt.attemptId!, "test-q2", {
      optionId: "test-q2-b",
      timeSpentMs: 20_000,
    });
    await saveResponse(db as never, "user-time-summary", attempt.attemptId!, "test-q3", {
      isDontKnow: true,
      timeSpentMs: 6_000,
    });

    await completeAttempt(db as never, "user-time-summary", attempt.attemptId!);
    const result = await getResult(db as never, "user-time-summary", attempt.attemptId!);

    expect(result?.totalTimeMs).toBe(36_000);
    expect(result?.averageTimeMs).toBe(12_000);
  });
});
