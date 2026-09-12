// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { seedQuestion } from "./questionFixtures";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex, hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handlePlayerRequest } from "../src/routes/player";
import { handleErrorNotebookRequest } from "../src/routes/errorNotebook";
import { handleStudentMetricsRequest } from "../src/routes/studentMetrics";
import { findEntryByUserAndQuestion } from "../src/repositories/errorNotebookRepository";
import { getPatternEvidence } from "../src/repositories/studentMetricsRepository";
import { deriveProvisionalState, derivePatternAttention, PROVISIONAL_STATES, PROVISIONAL_STATE_LABELS, type StateInput } from "../src/lib/studentMetricsRules";
import { getPatternPerformanceOverview, type PatternPerformanceOverviewItemDTO } from "../src/services/studentMetricsService";

/* Sprint 10 v1.0 — Métricas Centrais e Mapa ENEM do Aluno. Testes
   ALVEJADOS (seção 15 da ordem, seção 2 tornada permanente): cobrem só os
   itens de maior risco real desta sprint — agregação por padrão
   PRINCIPAL (nunca secundário), isolamento entre alunos, tentativa
   incompleta nunca vira acerto/erro confirmado, GET nunca escreve, e o
   rótulo provisório nunca usa a palavra "dominado". Mesma convenção de
   worker/testing/errorNotebook.test.ts: SQLite real por trás do
   FakeD1Database, prova sempre por consulta DIRETA ao banco além da
   resposta HTTP. */

let db: FakeD1Database;
const seededUsers = new Set<string>();

beforeEach(() => {
  db = new FakeD1Database();
  seededUsers.clear();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'Frase de reconhecimento', 'D', 'E', 'X', 'R', 'published')`
  );
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-2', 'PAD-02', 'padrao-2', 'Padrão 2', 'Frase de reconhecimento 2', 'D2', 'E2', 'X2', 'R2', 'published')`
  );
});

async function seedUserWithSession(id: string): Promise<string> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
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

async function ensureUserSession(userId: string): Promise<string> {
  if (!seededUsers.has(userId)) {
    await seedUserWithSession(userId);
    seededUsers.add(userId);
  }
  return `session-token-${userId}`;
}

function seedPublishedQuestion(overrides: Parameters<typeof seedQuestion>[1] = {}): string {
  const qId = seedQuestion(db.sqlite, { patternId: "pat-1", status: "draft", version: 1, ...overrides });
  db.sqlite.exec(`UPDATE questions SET editorial_status = 'published' WHERE id = '${qId}'`);
  return qId;
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

async function callPlayerRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handlePlayerRequest(request, localEnv(), url))!;
}

async function callNotebookRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handleErrorNotebookRequest(request, localEnv(), url))!;
}

async function callMetricsRoute(path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
  const request = requestWithCookie(path, token, init);
  const url = new URL(request.url);
  return (await handleStudentMetricsRequest(request, localEnv(), url))!;
}

async function startAndConfirm(
  userId: string,
  questionId: string,
  alternative: "A" | "B",
  mode: "learning" | "practice" | "recognition" = "learning"
): Promise<string> {
  const token = await ensureUserSession(userId);
  const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId, mode }) });
  const { attemptId } = (await create.json()) as { attemptId: string };
  await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative } as never) });
  await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
  return attemptId;
}

function countRows(table: string, where = ""): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table} ${where}`).get() as { total: number }).total;
}

/* ---------------------------------------------------------------------- */
/* Estado sem evidência                                                    */
/* ---------------------------------------------------------------------- */

describe("aluno sem evidência", () => {
  it("summary reporta hasAnyEvidence=false e nunca fabrica um zero como desempenho", async () => {
    const token = await ensureUserSession("semev-1");
    const response = await callMetricsRoute("/api/student-metrics/summary", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { summary: { hasAnyEvidence: boolean; patternsByState: Record<string, number> } };
    expect(body.summary.hasAnyEvidence).toBe(false);
    expect(body.summary.patternsByState.sem_evidencias).toBe(2);
  });

  it("patterns lista os dois padrões publicados, ambos em sem_evidencias", async () => {
    const token = await ensureUserSession("semev-2");
    const response = await callMetricsRoute("/api/student-metrics/patterns", token);
    const body = (await response.json()) as { patterns: Array<{ state: string; questionsConfirmed: number }> };
    expect(body.patterns).toHaveLength(2);
    expect(body.patterns.every((p) => p.state === "sem_evidencias" && p.questionsConfirmed === 0)).toBe(true);
  });
});

/* ---------------------------------------------------------------------- */
/* Isolamento entre alunos                                                 */
/* ---------------------------------------------------------------------- */

describe("isolamento entre alunos", () => {
  it("aluno A só vê a própria evidência, nunca a de B (via rota HTTP)", async () => {
    const q1 = seedPublishedQuestion({ id: "q-iso-1" });
    await startAndConfirm("iso-a", q1, "B"); // correta
    const q2 = seedPublishedQuestion({ id: "q-iso-2" });
    await startAndConfirm("iso-b", q2, "A"); // incorreta, aluno diferente

    const tokenA = await ensureUserSession("iso-a");
    const responseA = await callMetricsRoute("/api/student-metrics/patterns/padrao-1", tokenA);
    const bodyA = (await responseA.json()) as { pattern: { correctCount: number; incorrectCount: number; questionsConfirmed: number } };
    expect(bodyA.pattern.correctCount).toBe(1);
    expect(bodyA.pattern.incorrectCount).toBe(0); // o erro de iso-b nunca aparece na leitura de iso-a.
  });

  it("aluno A só vê a própria evidência, nunca a de B (verificação direta no repositório)", async () => {
    const qa = seedPublishedQuestion({ id: "q-iso-a" });
    await startAndConfirm("isoA", qa, "B");
    const qb = seedPublishedQuestion({ id: "q-iso-b" });
    await startAndConfirm("isoB", qb, "A");

    const evidenceA = await getPatternEvidence(db as never, "isoA", "pat-1");
    const evidenceB = await getPatternEvidence(db as never, "isoB", "pat-1");

    expect(evidenceA.correctCount).toBe(1);
    expect(evidenceA.incorrectCount).toBe(0);
    expect(evidenceB.correctCount).toBe(0);
    expect(evidenceB.incorrectCount).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Padrão principal x secundário                                          */
/* ---------------------------------------------------------------------- */

describe("padrão principal x secundário", () => {
  it("um vínculo secundário nunca contribui para a métrica do padrão", async () => {
    const qId = seedPublishedQuestion({ id: "q-sec-1" });
    // Vínculo secundário adicional com pat-2, além do principal (pat-1) já
    // criado por seedQuestion.
    db.sqlite.exec(`INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp-sec-1', 'q-sec-1', 'pat-2', 'secundario')`);
    await startAndConfirm("sec-1", qId, "B");

    const evidencePrincipal = await getPatternEvidence(db as never, "sec-1", "pat-1");
    const evidenceSecundario = await getPatternEvidence(db as never, "sec-1", "pat-2");
    expect(evidencePrincipal.correctCount).toBe(1);
    expect(evidenceSecundario.correctCount).toBe(0);
    expect(evidenceSecundario.questionsStarted).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* Tentativa incompleta nunca vira acerto/erro confirmado                  */
/* ---------------------------------------------------------------------- */

describe("tentativa incompleta", () => {
  it("uma tentativa in_progress conta como 'iniciada', nunca como confirmada/acerto/erro", async () => {
    const qId = seedPublishedQuestion({ id: "q-incompleta-1" });
    const token = await ensureUserSession("incompleto-1");
    await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });

    const evidence = await getPatternEvidence(db as never, "incompleto-1", "pat-1");
    expect(evidence.questionsStarted).toBe(1);
    expect(evidence.questionsConfirmed).toBe(0);
    expect(evidence.confirmedAttempts).toBe(0);
    expect(evidence.correctCount).toBe(0);
    expect(evidence.incorrectCount).toBe(0);
  });
});

/* ---------------------------------------------------------------------- */
/* Revisão correta/incorreta                                               */
/* ---------------------------------------------------------------------- */

describe("revisões contadas separadamente dos erros comuns", () => {
  it("uma revisão correta é contada em reviewsCorrect e faz o modo aparecer como 'review'", async () => {
    const originalId = seedPublishedQuestion({ id: "q-rev-orig" });
    seedPublishedQuestion({ id: "q-rev-sim" }); // mesmo pat-1, questão semelhante para a seleção
    await startAndConfirm("rev-1", originalId, "A"); // errada, cria a entrada
    const entry = await findEntryByUserAndQuestion(db as never, "rev-1", originalId);
    const token = await ensureUserSession("rev-1");

    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, token, { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });

    const evidence = await getPatternEvidence(db as never, "rev-1", "pat-1");
    expect(evidence.reviewsCorrect).toBe(1);
    expect(evidence.reviewsIncorrect).toBe(0);
    expect(evidence.attemptsReview).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* GET nunca escreve                                                       */
/* ---------------------------------------------------------------------- */

describe("GET nunca escreve", () => {
  it("chamar todos os 4 endpoints não altera nenhuma linha em nenhuma tabela de evidência", async () => {
    const qId = seedPublishedQuestion({ id: "q-getonly" });
    await startAndConfirm("getonly-1", qId, "B");
    const token = await ensureUserSession("getonly-1");

    const before = {
      attempts: countRows("question_attempts"),
      answerEvents: countRows("question_answer_events"),
      entries: countRows("error_notebook_entries"),
      reviewEvents: countRows("error_review_events"),
    };

    await callMetricsRoute("/api/student-metrics/summary", token);
    await callMetricsRoute("/api/student-metrics/patterns", token);
    await callMetricsRoute("/api/student-metrics/patterns/padrao-1", token);
    await callMetricsRoute("/api/student-metrics/activity", token);

    const after = {
      attempts: countRows("question_attempts"),
      answerEvents: countRows("question_answer_events"),
      entries: countRows("error_notebook_entries"),
      reviewEvents: countRows("error_review_events"),
    };
    expect(after).toEqual(before);
  });
});

/* ---------------------------------------------------------------------- */
/* Isolamento e 404-não-403 nas rotas                                     */
/* ---------------------------------------------------------------------- */

describe("acesso entre alunos via rota", () => {
  it("um padrão publicado existe para qualquer aluno autenticado (não há 'dono' de padrão) — a evidência é que muda por aluno", async () => {
    const token = await ensureUserSession("acesso-1");
    const response = await callMetricsRoute("/api/student-metrics/patterns/padrao-1", token);
    expect(response.status).toBe(200);
  });

  it("slug inexistente responde 404", async () => {
    const token = await ensureUserSession("acesso-2");
    const response = await callMetricsRoute("/api/student-metrics/patterns/nao-existe", token);
    expect(response.status).toBe(404);
  });

  it("sem sessão responde 401", async () => {
    const response = await callMetricsRoute("/api/student-metrics/summary", null);
    expect(response.status).toBe(401);
  });

  it("método errado responde 405", async () => {
    const token = await ensureUserSession("acesso-3");
    const response = await callMetricsRoute("/api/student-metrics/summary", token, { method: "POST", body: "{}" });
    expect(response.status).toBe(405);
  });
});

/* ---------------------------------------------------------------------- */
/* Rótulo provisório nunca "dominado"                                      */
/* ---------------------------------------------------------------------- */

describe("rótulos provisórios", () => {
  it("nenhum rótulo usa a palavra 'dominado' como conclusão", () => {
    for (const label of Object.values(PROVISIONAL_STATE_LABELS)) {
      expect(label.toLowerCase()).not.toContain("dominado");
    }
  });
});

/* ======================================================================== */
/* v1.1 — CORREÇÃO DE AUDITORIA DA PO EM CIMA DA v1.0                        */
/* ======================================================================== */

/* ---------------------------------------------------------------------- */
/* Seção 1 da ordem — nova regra de deriveProvisionalState.                */
/*                                                                          */
/* Camada 1 (abaixo): testes PUROS diretos contra deriveProvisionalState,  */
/* sem banco — isolam exatamente UMA variável por vez a partir de um       */
/* input que já qualifica para consistente_no_recorte em todos os outros  */
/* critérios, provando a lógica da regra em si com precisão absoluta.      */
/*                                                                          */
/* Camada 2 (mais abaixo, seção "diversidade/sessão real — repositório"):  */
/* testes de INTEGRAÇÃO contra o banco real, provando que a agregação SQL */
/* (distinctQuestionsUsed, distinctPracticeDays, attemptsWithHelp) está    */
/* correta — uma prova pura não consegue provar isso, porque recebe os    */
/* números já prontos.                                                     */
/* ---------------------------------------------------------------------- */

// v1.2 (correção PO, seção 1 da ordem desta rodada): firstConfirmedAt/
// lastConfirmedAt agora são campos obrigatórios de StateInput. Aqui o
// intervalo entre os dois é de só 1 dia (< MIN_MAINTENANCE_WINDOW_DAYS),
// de propósito — prova, por construção, que o baseline qualifica só pelo
// caminho hasCorrectReview (v1.1, inalterado), nunca por
// sustainedEvidenceWithoutReview.
const QUALIFYING_STATE_INPUT: StateInput = {
  confirmedAttempts: 3,
  correctCount: 3,
  distinctQuestionsUsed: 3,
  distinctSessionDates: 2,
  hasCorrectReview: true,
  firstConfirmedAt: "2026-01-01T10:00:00.000Z",
  lastConfirmedAt: "2026-01-02T10:00:00.000Z",
  attemptsWithHelp: 0,
  hasOverdueActiveReview: false,
};

describe("deriveProvisionalState — regra v1.1 (correção PO, seção 1 da ordem, 8 casos de fronteira)", () => {
  it("baseline: todos os cinco critérios de consistência satisfeitos ao mesmo tempo → consistente_no_recorte", () => {
    expect(deriveProvisionalState(QUALIFYING_STATE_INPUT)).toBe("consistente_no_recorte");
  });

  it("caso 1 (nível de regra): mesmo com confirmedAttempts suficiente, distinctQuestionsUsed=1 (a MESMA questão repetida) nunca é suficiente sozinho — a regra confia só no número já deduplicado que recebe; a prova de que o SQL realmente dedupe está na seção 'diversidade real — repositório' abaixo", () => {
    expect(
      deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, confirmedAttempts: 3, correctCount: 3, distinctQuestionsUsed: 1 })
    ).toBe("em_desenvolvimento");
  });

  it("caso 2: evidência concentrada num único dia (distinctSessionDates=1) nunca é suficiente, mesmo com os outros quatro critérios OK", () => {
    expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, distinctSessionDates: 1 })).toBe("em_desenvolvimento");
  });

  it("caso 3: tentativas corretas e diversas suficientes, mas SEM nenhuma revisão correta registrada → no máximo em_desenvolvimento", () => {
    expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, hasCorrectReview: false })).toBe("em_desenvolvimento");
  });

  it("caso 4: uma revisão correta registrada após a prática inicial habilita consistente_no_recorte quando os demais critérios também valem", () => {
    expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, hasCorrectReview: true })).toBe("consistente_no_recorte");
  });

  it("caso 5: revisão vencida tem prioridade MÁXIMA sobre todos os demais sinais, mesmo um padrão que seria 'perfeitamente consistente'", () => {
    expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, hasOverdueActiveReview: true })).toBe("revisao_pendente");
  });

  it("caso 6: dependência de ajuda elevada (mais da metade das tentativas confirmadas usou ajuda) bloqueia consistente_no_recorte", () => {
    // 3 de 4 tentativas confirmadas usaram ajuda = 75% > 50% (MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT).
    expect(
      deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, confirmedAttempts: 4, correctCount: 4, attemptsWithHelp: 3 })
    ).toBe("em_desenvolvimento");
  });

  it("caso 6b: exatamente 50% de dependência de ajuda ainda é tolerado — fronteira inclusiva (<=)", () => {
    // 2 de 4 = exatamente 50%.
    expect(
      deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, confirmedAttempts: 4, correctCount: 4, attemptsWithHelp: 2 })
    ).toBe("consistente_no_recorte");
  });

  it("caso 7 (nível de regra): retry não duplica evidência — a regra recebe contadores já corretos e nunca precisa 'saber' quantas vezes a mesma questão foi tentada; a prova de que o repositório não duplica está na seção 'retry não duplica evidência — repositório' abaixo", () => {
    expect(
      deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, confirmedAttempts: 5, correctCount: 5, distinctQuestionsUsed: 3 })
    ).toBe("consistente_no_recorte");
  });

  describe("caso 8: transições exatas de fronteira (off-by-one) em cada limiar", () => {
    it("confirmedAttempts: 2 (abaixo do mínimo de 3) → evidencias_iniciais, independente de tudo mais", () => {
      expect(
        deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, confirmedAttempts: 2, correctCount: 2, distinctQuestionsUsed: 2 })
      ).toBe("evidencias_iniciais");
    });

    it("confirmedAttempts: 3 (exatamente no mínimo) → já sai de evidencias_iniciais", () => {
      expect(deriveProvisionalState(QUALIFYING_STATE_INPUT)).not.toBe("evidencias_iniciais");
    });

    it("distinctQuestionsUsed: 2 (abaixo do mínimo de 3) → em_desenvolvimento, mesmo com os outros quatro critérios OK", () => {
      expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, distinctQuestionsUsed: 2 })).toBe("em_desenvolvimento");
    });

    it("distinctQuestionsUsed: 3 (exatamente no mínimo) → qualifica (com os demais critérios OK)", () => {
      expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, distinctQuestionsUsed: 3 })).toBe("consistente_no_recorte");
    });

    it("taxa de acerto: 69% (abaixo do mínimo de 70%) → em_desenvolvimento", () => {
      expect(
        deriveProvisionalState({
          ...QUALIFYING_STATE_INPUT,
          confirmedAttempts: 100,
          correctCount: 69,
          distinctQuestionsUsed: 3,
        })
      ).toBe("em_desenvolvimento");
    });

    it("taxa de acerto: exatamente 70% (no mínimo) → qualifica (com os demais critérios OK) — fronteira inclusiva (>=)", () => {
      expect(
        deriveProvisionalState({
          ...QUALIFYING_STATE_INPUT,
          confirmedAttempts: 100,
          correctCount: 70,
          distinctQuestionsUsed: 3,
        })
      ).toBe("consistente_no_recorte");
    });

    it("distinctSessionDates: 1 (abaixo do mínimo de 2) → em_desenvolvimento", () => {
      expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, distinctSessionDates: 1 })).toBe("em_desenvolvimento");
    });

    it("distinctSessionDates: exatamente 2 (no mínimo) → qualifica (com os demais critérios OK)", () => {
      expect(deriveProvisionalState({ ...QUALIFYING_STATE_INPUT, distinctSessionDates: 2 })).toBe("consistente_no_recorte");
    });
  });
});

/* ======================================================================== */
/* v1.2 — CORREÇÃO DE AUDITORIA DA PO EM CIMA DA v1.1                        */
/* ======================================================================== */

/* ---------------------------------------------------------------------- */
/* Seção 1 da ordem (rodada v1.2) — hasMaintenanceEvidence /               */
/* sustainedEvidenceWithoutReview: aluno que NUNCA errou agora pode        */
/* alcançar consistente_no_recorte por desempenho sustentado ao longo de   */
/* pelo menos MIN_MAINTENANCE_WINDOW_DAYS (7) dias de intervalo real entre */
/* a primeira e a última tentativa confirmada. Só os 6 testes ALVEJADOS    */
/* pedidos pela ordem desta rodada — nenhum outro.                         */
/* ---------------------------------------------------------------------- */

// Mesma base de QUALIFYING_STATE_INPUT, mas SEM revisão correta nenhuma —
// o aluno que nunca errou este padrão. Cada teste abaixo só varia
// firstConfirmedAt/lastConfirmedAt (o intervalo de manutenção) ou um dos
// outros quatro critérios, isolando exatamente uma variável por vez.
const NEVER_ERRED_STATE_INPUT: StateInput = {
  ...QUALIFYING_STATE_INPUT,
  hasCorrectReview: false,
};

describe("deriveProvisionalState — regra v1.2 (correção PO, seção 1 da ordem, hasMaintenanceEvidence)", () => {
  it("caso 1: zero erros, evidência espalhada por menos de 7 dias de intervalo → em_desenvolvimento (nunca consistente sem revisão nem janela suficiente)", () => {
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "2026-01-01T10:00:00.000Z",
        lastConfirmedAt: "2026-01-06T10:00:00.000Z", // 5 dias de intervalo, < 7
      })
    ).toBe("em_desenvolvimento");
  });

  it("caso 2: zero erros, evidência espalhada por EXATAMENTE 7 dias de intervalo → consistente_no_recorte (fronteira inclusiva, >=)", () => {
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "2026-01-01T10:00:00.000Z",
        lastConfirmedAt: "2026-01-08T10:00:00.000Z", // exatamente 7 dias (7 * 24h)
      })
    ).toBe("consistente_no_recorte");
  });

  it("caso 3: zero erros, intervalo suficiente (>= 7 dias), mas dependência de ajuda ACIMA do limite → em_desenvolvimento", () => {
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "2026-01-01T10:00:00.000Z",
        lastConfirmedAt: "2026-01-10T10:00:00.000Z", // 9 dias, bem acima do mínimo
        confirmedAttempts: 4,
        correctCount: 4,
        attemptsWithHelp: 3, // 75% > MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT (50%)
      })
    ).toBe("em_desenvolvimento");
  });

  it("caso 4 (regressão): aluno COM revisão correta ainda alcança consistente_no_recorte pelo caminho hasCorrectReview, mesmo com intervalo curto (< 7 dias) — o refactor não quebrou o caminho v1.1", () => {
    expect(
      deriveProvisionalState({
        ...QUALIFYING_STATE_INPUT,
        hasCorrectReview: true,
        firstConfirmedAt: "2026-01-01T10:00:00.000Z",
        lastConfirmedAt: "2026-01-01T11:00:00.000Z", // mesmo dia, 1 hora de intervalo
      })
    ).toBe("consistente_no_recorte");
  });

  it("caso 5 (regressão): revisão vencida continua com prioridade MÁXIMA sobre tudo — mesmo quando sustainedEvidenceWithoutReview sozinho já qualificaria", () => {
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "2026-01-01T10:00:00.000Z",
        lastConfirmedAt: "2026-01-10T10:00:00.000Z", // 9 dias, qualificaria sozinho
        hasOverdueActiveReview: true,
      })
    ).toBe("revisao_pendente");
  });

  it("caso 6: relógio/data é sempre injetado como DADO, nunca lido do relógio real da máquina — datas sintéticas muito no futuro e muito no passado produzem o mesmo resultado correto", () => {
    // Bem no futuro (ano 2099): 7 dias exatos de intervalo → consistente_no_recorte.
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "2099-03-01T00:00:00.000Z",
        lastConfirmedAt: "2099-03-08T00:00:00.000Z",
      })
    ).toBe("consistente_no_recorte");

    // Bem no passado (ano 1999): mesmo intervalo de 7 dias → mesmo resultado.
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "1999-06-01T00:00:00.000Z",
        lastConfirmedAt: "1999-06-08T00:00:00.000Z",
      })
    ).toBe("consistente_no_recorte");

    // Intervalo insuficiente (6 dias) nas mesmas datas sintéticas distantes → em_desenvolvimento.
    expect(
      deriveProvisionalState({
        ...NEVER_ERRED_STATE_INPUT,
        firstConfirmedAt: "2099-03-01T00:00:00.000Z",
        lastConfirmedAt: "2099-03-07T00:00:00.000Z",
      })
    ).toBe("em_desenvolvimento");
  });
});

/* ---------------------------------------------------------------------- */
/* Diversidade real, multi-sessão e retry — REPOSITÓRIO (camada 2).        */
/* Prova, contra SQLite real, que a agregação em                          */
/* studentMetricsRepository.ts realmente dedupe por questão e por         */
/* dia-calendário — o que um teste puro contra a regra não consegue       */
/* provar, porque a regra só recebe os números já prontos.                 */
/* ---------------------------------------------------------------------- */

describe("diversidade real — mesma questão repetida (correção PO v1.1, seção 1, caso 1)", () => {
  it("três tentativas confirmadas na MESMA questão contam distinctQuestionsUsed=1, nunca 3", async () => {
    const qId = seedPublishedQuestion({ id: "q-dup-1" });
    await startAndConfirm("dup-1", qId, "B");
    await startAndConfirm("dup-1", qId, "B");
    await startAndConfirm("dup-1", qId, "B");

    const evidence = await getPatternEvidence(db as never, "dup-1", "pat-1");
    expect(evidence.confirmedAttempts).toBe(3); // contador bruto de volume cresce normalmente
    expect(evidence.distinctQuestionsUsed).toBe(1); // NUNCA 3 — diversidade não duplica
  });
});

describe("multi-sessão real — repositório (correção PO v1.1, seção 1, caso 2)", () => {
  it("três questões distintas respondidas no MESMO dia real contam distinctPracticeDays=1, mesmo com distinctQuestionsUsed=3", async () => {
    const q1 = seedPublishedQuestion({ id: "q-sess-1" });
    const q2 = seedPublishedQuestion({ id: "q-sess-2" });
    const q3 = seedPublishedQuestion({ id: "q-sess-3" });
    await startAndConfirm("sess-1", q1, "B");
    await startAndConfirm("sess-1", q2, "B");
    await startAndConfirm("sess-1", q3, "B");

    const evidence = await getPatternEvidence(db as never, "sess-1", "pat-1");
    expect(evidence.distinctQuestionsUsed).toBe(3);
    expect(evidence.distinctPracticeDays).toBe(1); // tudo no mesmo dia real do teste
  });
});

describe("retry não duplica evidência — repositório (correção PO v1.1, seção 1, caso 7)", () => {
  it("repetir a MESMA questão em dois dias diferentes conta 1 questão distinta (nunca 2), mas 2 dias de prática distintos (multi-sessão real preservada)", async () => {
    const qId = seedPublishedQuestion({ id: "q-retry-1" });
    const attempt1 = await startAndConfirm("retry-1", qId, "B");
    db.sqlite.exec(`UPDATE question_attempts SET completed_at = '2026-01-01 10:00:00' WHERE id = '${attempt1}'`);
    const attempt2 = await startAndConfirm("retry-1", qId, "B");
    db.sqlite.exec(`UPDATE question_attempts SET completed_at = '2026-01-02 10:00:00' WHERE id = '${attempt2}'`);

    const evidence = await getPatternEvidence(db as never, "retry-1", "pat-1");
    expect(evidence.confirmedAttempts).toBe(2); // contador bruto cresce normalmente com o retry
    expect(evidence.distinctQuestionsUsed).toBe(1); // NUNCA duplica diversidade de questão
    expect(evidence.distinctPracticeDays).toBe(2); // mas dias reais diferentes contam corretamente
  });
});

describe("dependência de ajuda — repositório (correção PO v1.1, seção 1)", () => {
  it("attemptsWithHelp conta tentativas CONFIRMADAS distintas que abriram ajuda, nunca o total bruto de eventos de camada", async () => {
    const qId = seedPublishedQuestion({ id: "q-help-1" });
    const token = await ensureUserSession("help-1");
    const create = await callPlayerRoute("/api/player/attempts", token, {
      method: "POST",
      body: JSON.stringify({ questionId: qId, mode: "learning" }),
    });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/help/2`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, {
      method: "PATCH",
      body: JSON.stringify({ version: 3, alternative: "B" }),
    });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 4 }) });

    const evidence = await getPatternEvidence(db as never, "help-1", "pat-1");
    expect(evidence.helpOpens).toBe(2); // 2 eventos de camada abertos (camada 1 e camada 2)
    expect(evidence.attemptsWithHelp).toBe(1); // mas só 1 TENTATIVA usou ajuda — nunca 2
    expect(evidence.confirmedAttempts).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Seção 2 da ordem — isolamento completo padrão PRINCIPAL x SECUNDÁRIO.   */
/* ---------------------------------------------------------------------- */

describe("padrão principal x secundário — isolamento completo (correção PO v1.1, seção 2 da ordem)", () => {
  function seedThirdPattern(): void {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-3', 'PAD-03', 'padrao-3', 'Padrão 3', 'Frase de reconhecimento 3', 'D3', 'E3', 'X3', 'R3', 'published')`
    );
  }

  it("uma questão com 1 padrão principal + 2 padrões secundários: evidência pedagógica vai SÓ para o principal, zero para os dois secundários", async () => {
    seedThirdPattern();
    const qId = seedPublishedQuestion({ id: "q-multisec-1", patternId: "pat-1", secondaryPatternIds: ["pat-2", "pat-3"] });
    await startAndConfirm("multisec-1", qId, "B");

    const principal = await getPatternEvidence(db as never, "multisec-1", "pat-1");
    const sec1 = await getPatternEvidence(db as never, "multisec-1", "pat-2");
    const sec2 = await getPatternEvidence(db as never, "multisec-1", "pat-3");

    expect(principal.confirmedAttempts).toBe(1);
    expect(principal.correctCount).toBe(1);

    for (const secundario of [sec1, sec2]) {
      expect(secundario.confirmedAttempts).toBe(0);
      expect(secundario.correctCount).toBe(0);
      expect(secundario.incorrectCount).toBe(0);
      expect(secundario.questionsStarted).toBe(0);
      expect(secundario.distinctQuestionsUsed).toBe(0);
    }
  });

  it("retry (segunda tentativa confirmada na mesma questão): isolamento continua preservado, nenhum secundário ganha evidência", async () => {
    seedThirdPattern();
    const qId = seedPublishedQuestion({ id: "q-multisec-2", patternId: "pat-1", secondaryPatternIds: ["pat-2", "pat-3"] });
    await startAndConfirm("multisec-2", qId, "B");
    await startAndConfirm("multisec-2", qId, "A"); // segunda tentativa, agora errada

    const principal = await getPatternEvidence(db as never, "multisec-2", "pat-1");
    const sec1 = await getPatternEvidence(db as never, "multisec-2", "pat-2");
    const sec2 = await getPatternEvidence(db as never, "multisec-2", "pat-3");

    expect(principal.confirmedAttempts).toBe(2);
    expect(principal.correctCount).toBe(1);
    expect(principal.incorrectCount).toBe(1);
    expect(sec1.confirmedAttempts).toBe(0);
    expect(sec2.confirmedAttempts).toBe(0);
  });

  it("o resumo agregado (/patterns) nunca conta a mesma questão confirmada duas vezes (uma no principal, outra num secundário)", async () => {
    seedThirdPattern();
    const qId = seedPublishedQuestion({ id: "q-multisec-3", patternId: "pat-1", secondaryPatternIds: ["pat-2", "pat-3"] });
    await startAndConfirm("multisec-3", qId, "B");
    const token = await ensureUserSession("multisec-3");

    const response = await callMetricsRoute("/api/student-metrics/patterns", token);
    const body = (await response.json()) as { patterns: Array<{ patternId: string; questionsConfirmed: number }> };
    const totalQuestionsConfirmedAcrossAllPatterns = body.patterns.reduce((sum, p) => sum + p.questionsConfirmed, 0);
    expect(totalQuestionsConfirmedAcrossAllPatterns).toBe(1); // a questão só é "confirmada" uma vez, só no padrão principal (pat-1)
  });
});

/* ---------------------------------------------------------------------- */
/* Seção 4 da ordem — contratos semânticos, nunca só busca textual.        */
/* ---------------------------------------------------------------------- */

describe("contratos semânticos da API (correção PO v1.1, seção 4 da ordem)", () => {
  const FORBIDDEN_KEY_PATTERN = /^(tri|triscore|domainscore|domainpercent|masteryscore|overallscore|dominioscore|notatri|score)$/i;

  function collectKeysDeep(value: unknown, keys: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
      for (const item of value) collectKeysDeep(item, keys);
    } else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key);
        collectKeysDeep(nested, keys);
      }
    }
    return keys;
  }

  it("os 4 endpoints nunca expõem um campo tri/triScore/domainScore/domainPercent/score (checagem ESTRUTURAL de chaves do JSON, nunca busca de texto)", async () => {
    const qId = seedPublishedQuestion({ id: "q-semantic-1" });
    await startAndConfirm("semantic-1", qId, "B");
    const token = await ensureUserSession("semantic-1");

    const responses = await Promise.all([
      callMetricsRoute("/api/student-metrics/summary", token),
      callMetricsRoute("/api/student-metrics/patterns", token),
      callMetricsRoute("/api/student-metrics/patterns/padrao-1", token),
      callMetricsRoute("/api/student-metrics/activity", token),
    ]);
    for (const response of responses) {
      const body = await response.json();
      const keys = collectKeysDeep(body);
      for (const key of keys) {
        expect(FORBIDDEN_KEY_PATTERN.test(key), `campo proibido encontrado: ${key}`).toBe(false);
      }
    }
  });

  it("enum fechado: todo campo 'state' devolvido pertence exatamente aos 5 estados provisórios conhecidos (checagem por Set, nunca por texto solto)", async () => {
    const qId = seedPublishedQuestion({ id: "q-semantic-2" });
    await startAndConfirm("semantic-2", qId, "B");
    const token = await ensureUserSession("semantic-2");
    const response = await callMetricsRoute("/api/student-metrics/patterns", token);
    const body = (await response.json()) as { patterns: Array<{ state: string }> };
    const knownStates = new Set<string>(PROVISIONAL_STATES);
    expect(body.patterns.length).toBeGreaterThan(0);
    for (const p of body.patterns) {
      expect(knownStates.has(p.state)).toBe(true);
    }
  });

  it("o resumo agregado não inventa nenhum score geral: as chaves de StudentMetricsSummaryDTO são EXATAMENTE o conjunto conhecido, nem uma a mais", async () => {
    const token = await ensureUserSession("semantic-3");
    const response = await callMetricsRoute("/api/student-metrics/summary", token);
    const body = (await response.json()) as { summary: Record<string, unknown> };
    expect(Object.keys(body.summary).sort()).toEqual(
      ["totalPublishedPatterns", "hasAnyEvidence", "patternsByState", "pendingReviewCount", "lastPracticeAt"].sort()
    );
  });

  it("contadores da API batem EXATAMENTE com a contagem real de linhas em question_attempts (rastreável ao banco, nunca um número fabricado)", async () => {
    const qId = seedPublishedQuestion({ id: "q-semantic-4" });
    await startAndConfirm("semantic-4", qId, "B"); // correta
    await startAndConfirm("semantic-4", qId, "A"); // errada
    const token = await ensureUserSession("semantic-4");

    const realCorrectCount = countRows("question_attempts", `WHERE user_id = 'semantic-4' AND status = 'completed' AND is_correct = 1`);
    const realIncorrectCount = countRows("question_attempts", `WHERE user_id = 'semantic-4' AND status = 'completed' AND is_correct = 0`);

    const response = await callMetricsRoute("/api/student-metrics/patterns/padrao-1", token);
    const body = (await response.json()) as { pattern: { correctCount: number; incorrectCount: number } };
    expect(body.pattern.correctCount).toBe(realCorrectCount);
    expect(body.pattern.incorrectCount).toBe(realIncorrectCount);
    expect(realCorrectCount).toBe(1);
    expect(realIncorrectCount).toBe(1);
  });

  it("ausência de evidência retorna o estado explícito 'sem_evidencias' — nunca um zero pedagógico disfarçado (prova pelo campo estruturado, não por busca de '0%')", async () => {
    const token = await ensureUserSession("semantic-5");
    const response = await callMetricsRoute("/api/student-metrics/patterns", token);
    const body = (await response.json()) as { patterns: Array<{ state: string }> };
    expect(body.patterns.length).toBeGreaterThan(0);
    for (const p of body.patterns) {
      expect(p.state).toBe("sem_evidencias");
    }
  });
});

/* ---------------------------------------------------------------------- */
/* Seção 5 da ordem — GET somente leitura, provado para CADA UM dos 4     */
/* endpoints separadamente, incluindo audit_log e idempotência.            */
/* ---------------------------------------------------------------------- */

describe("GET somente leitura — por endpoint, com audit_log e idempotência (correção PO v1.1, seção 5 da ordem)", () => {
  const EVIDENCE_AND_AUDIT_TABLES = [
    "question_attempts",
    "question_answer_events",
    "question_recognition_events",
    "question_help_events",
    "error_notebook_entries",
    "error_review_events",
    "audit_log",
  ];

  function snapshotAllTables(): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const table of EVIDENCE_AND_AUDIT_TABLES) snap[table] = countRows(table);
    return snap;
  }

  async function setupEvidence(prefix: string): Promise<string> {
    const qId = seedPublishedQuestion({ id: `q-getro-${prefix}` });
    await startAndConfirm(`getro-${prefix}`, qId, "B");
    return ensureUserSession(`getro-${prefix}`);
  }

  const endpoints: Array<{ name: string; path: string }> = [
    { name: "summary", path: "/api/student-metrics/summary" },
    { name: "patterns", path: "/api/student-metrics/patterns" },
    { name: "patterns/:slug", path: "/api/student-metrics/patterns/padrao-1" },
    { name: "activity", path: "/api/student-metrics/activity" },
  ];

  for (const endpoint of endpoints) {
    it(`GET ${endpoint.name}: zero linhas criadas/alteradas/removidas em NENHUMA tabela de evidência nem em audit_log, e chamadas repetidas são idempotentes`, async () => {
      const token = await setupEvidence(endpoint.name.replace(/[^a-z0-9]/gi, ""));
      const before = snapshotAllTables();

      const first = await callMetricsRoute(endpoint.path, token);
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const afterFirst = snapshotAllTables();
      expect(afterFirst).toEqual(before);

      const second = await callMetricsRoute(endpoint.path, token);
      const secondBody = await second.json();
      const afterSecond = snapshotAllTables();
      expect(afterSecond).toEqual(before);

      // Idempotência: duas chamadas seguidas, sem nenhuma mutação real entre elas, devolvem o MESMO corpo.
      expect(secondBody).toEqual(firstBody);
    });
  }
});

/* Sprint 16 v1.2 (correção do bloqueador remanescente da v1.1, seção 1 da
   ordem) — o Mapa ENEM migrou de isLocalEditorialFixturesAllowed para
   isQuestionBankAvailable, o MESMO critério já usado por Player/Treino
   Diário/Simulados/Caderno de Erros desde a v1.1. Mesma matriz de prova já
   usada em worker/testing/playerAttempts.test.ts para o Player. */
describe("gate de disponibilidade do módulo (Sprint 16 v1.2 — isQuestionBankAvailable substitui isLocalEditorialFixturesAllowed)", () => {
  function prodEnv(): Env {
    return { DB: db as never, ASSETS: {} as never };
  }

  it("produção real (sem flag) sem nenhuma questão real publicada: resposta acolhedora, nunca 401/404", async () => {
    const token = await ensureUserSession("u-gate-1");
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/student-metrics/summary", {
      headers: { Cookie: `md_session=${token}` },
    });
    const response = (await handleStudentMetricsRequest(request, prodEnv(), new URL(request.url)))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  it("produção real (sem flag) COM uma questão real publicada: módulo disponível, mesma capacidade nova do Player/Treino/Simulados/Caderno", async () => {
    seedPublishedQuestion();
    const token = await ensureUserSession("u-gate-2");
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/student-metrics/summary", {
      headers: { Cookie: `md_session=${token}` },
    });
    const response = (await handleStudentMetricsRequest(request, prodEnv(), new URL(request.url)))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available?: boolean };
    expect(body.available).not.toBe(false);
  });

  it("dev local com ENABLE_LOCAL_EDITORIAL_FIXTURES habilitado: continua disponível incondicionalmente (comportamento antigo preservado)", async () => {
    const token = await ensureUserSession("u-gate-3");
    const response = await callMetricsRoute("/api/student-metrics/summary", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available?: boolean };
    expect(body.available).not.toBe(false);
  });
});

/* ==========================================================================
 * Sprint 21 — Dashboard de Desempenho por Padrão.
 *
 * `getPatternPerformanceOverview` reaproveita 100% de `deriveProvisionalState`
 * (inalterado) e a nova `derivePatternAttention` — nenhuma fórmula de
 * domínio nova. As consultas agregadas (studentMetricsRepository.ts) são
 * testadas aqui pela EQUIVALÊNCIA com `getPatternEvidence` (já exaustivamente
 * provado acima) para os mesmos cenários — nunca reimplementando os testes
 * de fronteira de deriveProvisionalState, que já existem e continuam
 * passando sem alteração nenhuma. ========================================== */

function findOverviewItem(items: PatternPerformanceOverviewItemDTO[], patternId: string): PatternPerformanceOverviewItemDTO {
  const item = items.find((i) => i.pattern.id === patternId);
  if (!item) throw new Error(`padrão ${patternId} não encontrado no overview`);
  return item;
}

describe("getPatternPerformanceOverview — catálogo completo (Sprint 21, seções 5/18)", () => {
  it("todos os padrões PUBLISHED aparecem, mesmo sem nenhuma tentativa — accuracy null, state sem_evidencias", async () => {
    const items = await getPatternPerformanceOverview(db as never, "overview-catalog-1", false);
    expect(items.map((i) => i.pattern.id).sort()).toEqual(["pat-1", "pat-2"]);
    for (const item of items) {
      expect(item.state.code).toBe("sem_evidencias");
      expect(item.accuracy).toBeNull();
      expect(item.attention.needed).toBe(false);
    }
  });

  it("padrão DRAFT e padrão ARCHIVED nunca aparecem no overview", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-draft', 'PAD-DRAFT', 'padrao-draft', 'Padrão Rascunho', 'F', 'D', 'E', 'X', 'R', 'draft')`
    );
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-archived', 'PAD-ARCH', 'padrao-arquivado', 'Padrão Arquivado', 'F', 'D', 'E', 'X', 'R', 'archived')`
    );
    const items = await getPatternPerformanceOverview(db as never, "overview-catalog-2", false);
    const ids = items.map((i) => i.pattern.id);
    expect(ids).not.toContain("pat-draft");
    expect(ids).not.toContain("pat-archived");
    expect(ids.sort()).toEqual(["pat-1", "pat-2"]);
  });

  it("padrão sem questão treinável elegível: training.canTrain=false, availableQuestionCount=0", async () => {
    const items = await getPatternPerformanceOverview(db as never, "overview-catalog-3", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.training.canTrain).toBe(false);
    expect(pat1.training.availableQuestionCount).toBe(0);
  });

  it("padrão com questão publicada elegível: training.canTrain=true, availableQuestionCount reflete a contagem real", async () => {
    seedPublishedQuestion({ id: "q-overview-trainable" });
    const items = await getPatternPerformanceOverview(db as never, "overview-catalog-4", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.training.canTrain).toBe(true);
    expect(pat1.training.availableQuestionCount).toBe(1);
  });
});

describe("getPatternPerformanceOverview — evidência agregada (equivalência com getPatternEvidence, Sprint 21 seção 3)", () => {
  it("três tentativas confirmadas na MESMA questão: confirmedAttempts=3, distinctQuestionsUsed=1 (nunca 3)", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-repeat" });
    await startAndConfirm("overview-repeat", qId, "B");
    await startAndConfirm("overview-repeat", qId, "A");
    await startAndConfirm("overview-repeat", qId, "B");
    const items = await getPatternPerformanceOverview(db as never, "overview-repeat", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.evidence.confirmedAttempts).toBe(3);
    expect(pat1.evidence.distinctQuestionsUsed).toBe(1);
    expect(pat1.evidence.correctCount).toBe(2);
    expect(pat1.evidence.incorrectCount).toBe(1);
  });

  it("tentativa in_progress nunca entra em accuracy nem em confirmedAttempts", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-inprogress" });
    const token = await ensureUserSession("overview-inprogress");
    await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    // Nunca respondida/confirmada — permanece in_progress.
    const items = await getPatternPerformanceOverview(db as never, "overview-inprogress", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.evidence.confirmedAttempts).toBe(0);
    expect(pat1.accuracy).toBeNull();
    expect(pat1.state.code).toBe("sem_evidencias");
  });

  it("tentativa abandoned nunca entra em accuracy nem em confirmedAttempts", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-abandoned" });
    const token = await ensureUserSession("overview-abandoned");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    db.sqlite.exec(`UPDATE question_attempts SET status = 'abandoned' WHERE id = '${attemptId}'`);
    const items = await getPatternPerformanceOverview(db as never, "overview-abandoned", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.evidence.confirmedAttempts).toBe(0);
    expect(pat1.accuracy).toBeNull();
  });

  it("vínculo SECUNDÁRIO nunca contribui para a evidência do overview (mesmo isolamento já provado para getPatternEvidence)", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-secondary" });
    db.sqlite.exec(`INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp-overview-sec', '${qId}', 'pat-2', 'secundario')`);
    await startAndConfirm("overview-secondary", qId, "B");
    const items = await getPatternPerformanceOverview(db as never, "overview-secondary", false);
    const pat1 = findOverviewItem(items, "pat-1");
    const pat2 = findOverviewItem(items, "pat-2");
    expect(pat1.evidence.confirmedAttempts).toBe(1); // padrão principal real da questão
    expect(pat2.evidence.confirmedAttempts).toBe(0); // vínculo secundário nunca conta
  });

  it("dependência de ajuda: attemptsWithHelp conta tentativas CONFIRMADAS distintas, nunca o total bruto de aberturas de camada", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-help" });
    const token = await ensureUserSession("overview-help");
    const create = await callPlayerRoute("/api/player/attempts", token, { method: "POST", body: JSON.stringify({ questionId: qId, mode: "learning" }) });
    const { attemptId } = (await create.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/help/1`, token, { method: "POST", body: JSON.stringify({ version: 1 }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/help/2`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 3, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 4 }) });
    const items = await getPatternPerformanceOverview(db as never, "overview-help", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.evidence.attemptsWithHelp).toBe(1); // uma tentativa, duas camadas abertas — conta 1, nunca 2
  });

  it("lastPracticeAt reflete a tentativa CONFIRMADA mais recente", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-lastpractice" });
    await startAndConfirm("overview-lastpractice", qId, "B");
    const items = await getPatternPerformanceOverview(db as never, "overview-lastpractice", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.evidence.lastPracticeAt).not.toBeNull();
    const real = countRows("question_attempts", `WHERE user_id = 'overview-lastpractice' AND status = 'completed'`);
    expect(real).toBe(1);
  });

  it("revisão correta/incorreta entram no padrão PRINCIPAL correto (reviewsCorrect/reviewsIncorrect)", async () => {
    const originalId = seedPublishedQuestion({ id: "q-overview-review-orig" });
    seedPublishedQuestion({ id: "q-overview-review-sim" });
    await startAndConfirm("overview-review", originalId, "A"); // errada, cria a entrada
    const entry = await findEntryByUserAndQuestion(db as never, "overview-review", originalId);
    const token = await ensureUserSession("overview-review");
    const start = await callNotebookRoute(`/api/error-notebook/${entry!.id}/start-review`, token, { method: "POST" });
    const { attemptId } = (await start.json()) as { attemptId: string };
    await callPlayerRoute(`/api/player/attempts/${attemptId}/answer`, token, { method: "PATCH", body: JSON.stringify({ version: 1, alternative: "B" }) });
    await callPlayerRoute(`/api/player/attempts/${attemptId}/confirm`, token, { method: "POST", body: JSON.stringify({ version: 2 }) });

    const items = await getPatternPerformanceOverview(db as never, "overview-review", false);
    const pat1 = findOverviewItem(items, "pat-1");
    expect(pat1.evidence.reviewsCorrect).toBe(1);
    expect(pat1.evidence.reviewsIncorrect).toBe(0);
  });
});

describe("isolamento entre alunos — getPatternPerformanceOverview (Sprint 21, seção 22)", () => {
  it("aluno A só vê a própria evidência agregada, nunca a de B", async () => {
    const qId = seedPublishedQuestion({ id: "q-overview-isolation" });
    await startAndConfirm("overview-iso-a", qId, "B");
    await startAndConfirm("overview-iso-b", qId, "A");
    await startAndConfirm("overview-iso-b", qId, "A");

    const itemsA = await getPatternPerformanceOverview(db as never, "overview-iso-a", false);
    const itemsB = await getPatternPerformanceOverview(db as never, "overview-iso-b", false);

    expect(findOverviewItem(itemsA, "pat-1").evidence.confirmedAttempts).toBe(1);
    expect(findOverviewItem(itemsA, "pat-1").evidence.correctCount).toBe(1);
    expect(findOverviewItem(itemsB, "pat-1").evidence.confirmedAttempts).toBe(2);
    expect(findOverviewItem(itemsB, "pat-1").evidence.incorrectCount).toBe(2);
  });
});

describe("endpoint /api/student-metrics/patterns/overview — HTTP (Sprint 21)", () => {
  it("sem sessão responde 401", async () => {
    const response = await callMetricsRoute("/api/student-metrics/patterns/overview", null);
    expect(response.status).toBe(401);
  });

  it("com sessão responde 200 com o catálogo publicado, roteado ANTES de /patterns/:slug (nunca casa 'overview' como slug)", async () => {
    const token = await ensureUserSession("overview-http-1");
    const response = await callMetricsRoute("/api/student-metrics/patterns/overview", token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { patterns: PatternPerformanceOverviewItemDTO[] };
    expect(body.patterns.map((p) => p.pattern.id).sort()).toEqual(["pat-1", "pat-2"]);
  });

  it("GET nunca escreve: nenhuma tabela de evidência muda com a chamada", async () => {
    const token = await ensureUserSession("overview-http-2");
    const before = countRows("question_attempts") + countRows("error_notebook_entries") + countRows("error_review_events");
    await callMetricsRoute("/api/student-metrics/patterns/overview", token);
    const after = countRows("question_attempts") + countRows("error_notebook_entries") + countRows("error_review_events");
    expect(after).toBe(before);
  });
});

/* Sprint 21.1 — correção de auditoria: o overview de desempenho por padrão
   NÃO pode depender de existir questão publicada. Antes desta correção,
   handleStudentMetricsRequest aplicava isQuestionBankAvailable (gate
   global do módulo) ANTES de identificar a rota, então /patterns/overview
   herdava indevidamente o "available:false" dos endpoints legados
   (summary/patterns/patterns/:slug/activity) sempre que não havia nenhuma
   questão real publicada — mesmo com padrões publicados no catálogo. A
   prova aqui usa prodEnv() (sem ENABLE_LOCAL_EDITORIAL_FIXTURES, sem
   ENVIRONMENT de dev) deliberadamente, o mesmo ambiente que a Sprint 16
   v1.2 já usa para provar o gate — é o cenário exato em que o bug
   aparecia. */
describe("Sprint 21.1 — overview de desempenho não depende de existir questão publicada", () => {
  function prodEnv(): Env {
    return { DB: db as never, ASSETS: {} as never };
  }

  async function callOverviewProd(token: string | null, method = "GET"): Promise<Response> {
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/student-metrics/patterns/overview", {
      method,
      headers: token ? { Cookie: `md_session=${token}` } : {},
    });
    return (await handleStudentMetricsRequest(request, prodEnv(), new URL(request.url)))!;
  }

  it("A — produção real (sem flag), 3 padrões published, ZERO questões: 200 com os 3, todos sem_evidencias/accuracy=null/canTrain=false/count=0", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-3', 'PAD-03', 'padrao-3', 'Padrão 3', 'Frase de reconhecimento 3', 'D3', 'E3', 'X3', 'R3', 'published')`
    );
    expect(countRows("questions")).toBe(0);
    const token = await ensureUserSession("gate211-a");
    const response = await callOverviewProd(token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; patterns: PatternPerformanceOverviewItemDTO[] };
    expect(body.patterns).toHaveLength(3);
    for (const item of body.patterns) {
      expect(item.state.code).toBe("sem_evidencias");
      expect(item.accuracy).toBeNull();
      expect(item.training.canTrain).toBe(false);
      expect(item.training.availableQuestionCount).toBe(0);
    }
  });

  it("B — produção real, ZERO padrões published, ZERO questões: 200 com patterns=[] (nunca available:false)", async () => {
    db.sqlite.exec(`DELETE FROM patterns`);
    const token = await ensureUserSession("gate211-b");
    const response = await callOverviewProd(token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; patterns: PatternPerformanceOverviewItemDTO[] };
    expect(body.patterns).toEqual([]);
  });

  it("C — sem sessão responde 401 mesmo em produção real sem nenhuma questão publicada", async () => {
    const response = await callOverviewProd(null);
    expect(response.status).toBe(401);
  });

  it("D — POST /patterns/overview responde method-not-allowed, mesmo sem questão publicada", async () => {
    const token = await ensureUserSession("gate211-d");
    const response = await callOverviewProd(token, "POST");
    expect(response.status).toBe(405);
  });

  it("E — endpoint LEGADO /summary sem questão real publicada preserva o comportamento anterior (available:false)", async () => {
    const token = await ensureUserSession("gate211-e");
    const request = new Request("https://matematica-delicada.proffandreia5.workers.dev/api/student-metrics/summary", {
      headers: { Cookie: `md_session=${token}` },
    });
    const response = (await handleStudentMetricsRequest(request, prodEnv(), new URL(request.url)))!;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { available?: boolean };
    expect(body.available).toBe(false);
  });

  it("F — um padrão published sem questão + outro com questão publicada: ambos aparecem, só o segundo canTrain=true", async () => {
    seedPublishedQuestion({ patternId: "pat-2" });
    const token = await ensureUserSession("gate211-f");
    const response = await callOverviewProd(token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; patterns: PatternPerformanceOverviewItemDTO[] };
    expect(body.patterns.map((p) => p.pattern.id).sort()).toEqual(["pat-1", "pat-2"]);
    const withQuestion = body.patterns.find((p) => p.pattern.id === "pat-2")!;
    const withoutQuestion = body.patterns.find((p) => p.pattern.id === "pat-1")!;
    expect(withQuestion.training.canTrain).toBe(true);
    expect(withoutQuestion.training.canTrain).toBe(false);
  });
});

describe("derivePatternAttention — regra centralizada (Sprint 21, seção 7 da ordem)", () => {
  const BASE = { confirmedAttempts: 0, correctCount: 0, incorrectCount: 0, attemptsWithHelp: 0, reviewsIncorrect: 0 };

  it("revisao_pendente → sempre needed=true, independente de qualquer outro contador", () => {
    const result = derivePatternAttention({ ...BASE, state: "revisao_pendente", confirmedAttempts: 0 });
    expect(result.needed).toBe(true);
    expect(result.reason).not.toBeNull();
  });

  it("1 tentativa errada (evidencias_iniciais, abaixo do mínimo de 3) → NÃO precisa de atenção automaticamente", () => {
    const result = derivePatternAttention({ ...BASE, state: "evidencias_iniciais", confirmedAttempts: 1, incorrectCount: 1 });
    expect(result.needed).toBe(false);
  });

  it("2 tentativas (ainda evidencias_iniciais, abaixo do mínimo de 3) → ainda não classifica agressivamente", () => {
    const result = derivePatternAttention({ ...BASE, state: "evidencias_iniciais", confirmedAttempts: 2, incorrectCount: 2 });
    expect(result.needed).toBe(false);
  });

  it("confirmedAttempts suficiente (>=3) + em_desenvolvimento + mais erros que acertos → attention=true", () => {
    const result = derivePatternAttention({ ...BASE, state: "em_desenvolvimento", confirmedAttempts: 3, correctCount: 1, incorrectCount: 2 });
    expect(result.needed).toBe(true);
    expect(result.reason).not.toBeNull();
  });

  it("em_desenvolvimento + confirmedAttempts suficiente MAS sem nenhuma evidência negativa → attention=false", () => {
    const result = derivePatternAttention({ ...BASE, state: "em_desenvolvimento", confirmedAttempts: 3, correctCount: 3, incorrectCount: 0 });
    expect(result.needed).toBe(false);
  });

  it("em_desenvolvimento + alta dependência de ajuda (acima do limiar já existente) → attention=true", () => {
    const result = derivePatternAttention({
      ...BASE,
      state: "em_desenvolvimento",
      confirmedAttempts: 4,
      correctCount: 4,
      incorrectCount: 0,
      attemptsWithHelp: 3, // 75% > MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT (0.5)
    });
    expect(result.needed).toBe(true);
  });

  it("em_desenvolvimento + revisão incorreta registrada → attention=true", () => {
    const result = derivePatternAttention({ ...BASE, state: "em_desenvolvimento", confirmedAttempts: 3, correctCount: 3, incorrectCount: 0, reviewsIncorrect: 1 });
    expect(result.needed).toBe(true);
  });

  it("consistente_no_recorte → nunca precisa de atenção, mesmo hipoteticamente com contadores ruins", () => {
    const result = derivePatternAttention({ ...BASE, state: "consistente_no_recorte", confirmedAttempts: 10, correctCount: 1, incorrectCount: 9 });
    expect(result.needed).toBe(false);
  });

  it("sem_evidencias → nunca precisa de atenção", () => {
    const result = derivePatternAttention({ ...BASE, state: "sem_evidencias" });
    expect(result.needed).toBe(false);
  });

  it("nunca é um score combinado: dois padrões com o mesmo state e MESMOS contadores produzem o MESMO resultado (determinístico, sem aleatoriedade)", () => {
    const input = { ...BASE, state: "em_desenvolvimento" as const, confirmedAttempts: 3, correctCount: 1, incorrectCount: 2 };
    expect(derivePatternAttention(input)).toEqual(derivePatternAttention(input));
  });
});

describe("ordenação de prioridade de ação (Sprint 21, seção 10 da ordem — nunca ranking de nota)", () => {
  it("revisao_pendente vem antes de attention, que vem antes de em_desenvolvimento, evidencias_iniciais, sem_evidencias, consistente_no_recorte", async () => {
    // pat-1: sem evidência (permanece sem_evidencias).
    // pat-2: revisão vencida (revisao_pendente) — prioridade máxima.
    seedPublishedQuestion({ id: "q-order-1", patternId: "pat-2" });
    await startAndConfirm("overview-order", "q-order-1", "A"); // errada, cria entrada
    const entry = await findEntryByUserAndQuestion(db as never, "overview-order", "q-order-1");
    db.sqlite.exec(`UPDATE error_notebook_entries SET next_review_at = '2020-01-01T00:00:00.000Z' WHERE id = '${entry!.id}'`);

    const items = await getPatternPerformanceOverview(db as never, "overview-order", false);
    expect(items[0].pattern.id).toBe("pat-2");
    expect(items[0].state.code).toBe("revisao_pendente");
    expect(items[1].pattern.id).toBe("pat-1");
    expect(items[1].state.code).toBe("sem_evidencias");
  });
});

describe("performance D1 — 20 padrões published, sem N+1 (Sprint 21, seção 21 da ordem)", () => {
  it("20 padrões publicados → menos de 20 chamadas D1 para o overview completo (meta <= 6)", async () => {
    for (let i = 3; i <= 20; i++) {
      db.sqlite.exec(
        `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
         VALUES ('pat-${i}', 'PAD-${String(i).padStart(2, "0")}', 'padrao-${i}', 'Padrão ${i}', 'F', 'D', 'E', 'X', 'R', 'published')`
      );
    }
    expect(countRows("patterns", `WHERE editorial_status = 'published'`)).toBe(20);

    db.resetD1CallCount();
    const items = await getPatternPerformanceOverview(db as never, "overview-perf", false);
    const calls = db.getD1CallCount();

    expect(items).toHaveLength(20);
    expect(calls).toBeLessThan(20);
    expect(calls).toBeLessThanOrEqual(6);
  });
});
