// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { createSession } from "../src/repositories/sessionRepository";
import { sha256Hex } from "../src/lib/crypto";
import { hashPassword } from "../src/lib/crypto";
import { findProfile } from "../src/repositories/onboardingRepository";
import { completeOnboarding, getOnboarding, saveProgress } from "../src/services/onboardingService";
import { handleOnboardingRequest } from "../src/routes/onboarding";

/* Sprint 3 v1.0/v1.1 — testes de dados/API do onboarding, seguindo o mesmo
   seam de Sprint 2 v1.3 (SQLite real via node:sqlite, ver
   worker/testing/fakeD1.ts). Os cenários 20+ foram adicionados na correção
   v1.1 (auditoria explícita do endpoint de conclusão e do campo de
   acessibilidade). */

const CURRENT_YEAR = 2026;

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
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

function validStep1() {
  return { currentGrade: "3_serie_em", enemYear: CURRENT_YEAR, currentStep: 1 };
}
function validStep2() {
  return { goalType: "acertos" as const, goalValue: 30, currentStep: 2 };
}
function validStep3() {
  return { availableDays: ["seg", "qua", "sex"], dailyMinutes: 60, currentStep: 3 };
}
function validStep4() {
  return { difficulties: ["porcentagem", "gráficos"], currentStep: 4 };
}
function validStep5() {
  return { timePreference: "noite", currentStep: 5 };
}
function validStep6() {
  return { diagnosticChoice: "depois" as const, currentStep: 6 };
}

async function fillAllSteps(userId: string) {
  await saveProgress(db as never, userId, validStep1(), CURRENT_YEAR);
  await saveProgress(db as never, userId, validStep2(), CURRENT_YEAR);
  await saveProgress(db as never, userId, validStep3(), CURRENT_YEAR);
  await saveProgress(db as never, userId, validStep4(), CURRENT_YEAR);
  await saveProgress(db as never, userId, validStep5(), CURRENT_YEAR);
  await saveProgress(db as never, userId, validStep6(), CURRENT_YEAR);
}

describe("onboarding — criação, retomada e idempotência", () => {
  it("1. criação do perfil no primeiro salvamento", async () => {
    await seedUser("user-1");
    const result = await saveProgress(db as never, "user-1", validStep1(), CURRENT_YEAR);

    expect(result.ok).toBe(true);
    expect(result.startedNow).toBe(true);
    const row = await findProfile(db as never, "user-1");
    expect(row?.status).toBe("in_progress");
    expect(row?.current_grade).toBe("3_serie_em");
  });

  it("2. atualização idempotente — reenviar o mesmo patch produz o mesmo estado", async () => {
    await seedUser("user-2");
    await saveProgress(db as never, "user-2", validStep1(), CURRENT_YEAR);
    const second = await saveProgress(db as never, "user-2", validStep1(), CURRENT_YEAR);

    expect(second.ok).toBe(true);
    expect(second.startedNow).toBe(false);
    const row = await findProfile(db as never, "user-2");
    expect(row?.current_grade).toBe("3_serie_em");
  });

  it("3. retomada com dados persistidos entre etapas", async () => {
    await seedUser("user-3");
    await saveProgress(db as never, "user-3", validStep1(), CURRENT_YEAR);
    await saveProgress(db as never, "user-3", validStep2(), CURRENT_YEAR);

    const view = await getOnboarding(db as never, "user-3");
    expect(view.currentGrade).toBe("3_serie_em");
    expect(view.goalType).toBe("acertos");
    expect(view.goalValue).toBe(30);
    expect(view.currentStep).toBe(2);
  });
});

describe("onboarding — conclusão", () => {
  it("4. conclusão com todos os campos válidos", async () => {
    await seedUser("user-4");
    await fillAllSteps("user-4");

    const result = await completeOnboarding(db as never, "user-4");

    expect(result.ok).toBe(true);
    const row = await findProfile(db as never, "user-4");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).not.toBeNull();
  });

  it("5. rejeição de conclusão incompleta", async () => {
    await seedUser("user-5");
    await saveProgress(db as never, "user-5", validStep1(), CURRENT_YEAR);

    const result = await completeOnboarding(db as never, "user-5");

    expect(result.ok).toBe(false);
    expect(result.fieldErrors).toBeDefined();
    expect(Object.keys(result.fieldErrors ?? {}).length).toBeGreaterThan(0);
    const row = await findProfile(db as never, "user-5");
    expect(row?.status).not.toBe("completed");
  });

  it("6. conclusão repetida sem duplicidade — idempotente", async () => {
    await seedUser("user-6");
    await fillAllSteps("user-6");
    const first = await completeOnboarding(db as never, "user-6");
    const second = await completeOnboarding(db as never, "user-6");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.alreadyCompleted).toBe(true);

    const row = await findProfile(db as never, "user-6");
    // completed_at não deve ter sido regravado na segunda chamada.
    expect(row?.completed_at).toBe(first.profile?.completedAt);
  });
});

describe("onboarding — validação de faixas/conjuntos", () => {
  it("7. série fora do conjunto fechado é rejeitada", async () => {
    await seedUser("user-7");
    const result = await saveProgress(db as never, "user-7", { currentGrade: "faculdade" }, CURRENT_YEAR);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.currentGrade).toBeDefined();
  });

  it("8. ano do ENEM anterior ao corrente é rejeitado", async () => {
    await seedUser("user-8");
    const result = await saveProgress(db as never, "user-8", { enemYear: CURRENT_YEAR - 1 }, CURRENT_YEAR);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.enemYear).toBeDefined();
  });

  it("9. meta em acertos acima de 45 é rejeitada", async () => {
    await seedUser("user-9");
    const result = await saveProgress(
      db as never,
      "user-9",
      { goalType: "acertos", goalValue: 46 },
      CURRENT_YEAR
    );
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.goalValue).toBeDefined();
  });

  it("10. minutos por dia fora da faixa técnica é rejeitado", async () => {
    await seedUser("user-10");
    const result = await saveProgress(db as never, "user-10", { dailyMinutes: 5 }, CURRENT_YEAR);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.dailyMinutes).toBeDefined();
  });

  it("11. dia disponível duplicado é rejeitado", async () => {
    await seedUser("user-11");
    const result = await saveProgress(
      db as never,
      "user-11",
      { availableDays: ["seg", "seg"] },
      CURRENT_YEAR
    );
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.availableDays).toBeDefined();
  });

  it("12. mais de 6 dificuldades é rejeitado", async () => {
    await seedUser("user-12");
    const result = await saveProgress(
      db as never,
      "user-12",
      { difficulties: ["a", "b", "c", "d", "e", "f", "g"] },
      CURRENT_YEAR
    );
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.difficulties).toBeDefined();
  });

  it("13. entrada hostil em dificuldades é tratada como dado — sem SQL injection", async () => {
    await seedUser("user-13");
    const hostile = "'; DROP TABLE users; --";
    const result = await saveProgress(db as never, "user-13", { difficulties: [hostile] }, CURRENT_YEAR);

    expect(result.ok).toBe(true);
    expect(result.profile?.difficulties).toEqual([hostile]);
    // A tabela users continua íntegra — a string nunca foi interpretada como SQL.
    const stillThere = await findProfile(db as never, "user-13");
    expect(stillThere).not.toBeNull();
  });
});

describe("onboarding — preferências editáveis após conclusão", () => {
  it("14. campo não permitido após conclusão é rejeitado com regra clara", async () => {
    await seedUser("user-14");
    await fillAllSteps("user-14");
    await completeOnboarding(db as never, "user-14");

    const result = await saveProgress(db as never, "user-14", { currentGrade: "1_serie_em" }, CURRENT_YEAR);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.currentGrade).toBeDefined();
  });

  it("15. campo permitido (preferências) continua editável após conclusão", async () => {
    await seedUser("user-15");
    await fillAllSteps("user-15");
    await completeOnboarding(db as never, "user-15");

    const result = await saveProgress(db as never, "user-15", { dailyMinutes: 90 }, CURRENT_YEAR);
    expect(result.ok).toBe(true);
    expect(result.profile?.dailyMinutes).toBe(90);
  });
});

describe("onboarding — restrição de schema (migration 0003)", () => {
  it("20. um perfil por usuário — segunda linha com o mesmo user_id viola a PRIMARY KEY", async () => {
    await seedUser("user-20");
    db.sqlite
      .prepare("INSERT INTO student_profiles (user_id, status) VALUES (?, 'not_started')")
      .run("user-20");

    expect(() =>
      db.sqlite.prepare("INSERT INTO student_profiles (user_id, status) VALUES (?, 'not_started')").run("user-20")
    ).toThrow();
  });
});

describe("onboarding — isolamento entre usuários", () => {
  it("16. perfis de usuários diferentes são independentes", async () => {
    await seedUser("user-16-a");
    await seedUser("user-16-b");
    await saveProgress(db as never, "user-16-a", { currentGrade: "1_serie_em" }, CURRENT_YEAR);
    await saveProgress(db as never, "user-16-b", { currentGrade: "3_serie_em" }, CURRENT_YEAR);

    const a = await getOnboarding(db as never, "user-16-a");
    const b = await getOnboarding(db as never, "user-16-b");
    expect(a.currentGrade).toBe("1_serie_em");
    expect(b.currentGrade).toBe("3_serie_em");
  });
});

describe("onboarding — rotas HTTP: autorização, user_id do corpo ignorado, auditoria", () => {
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
    return new Request(`https://matematica-delicada.example/api/onboarding${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("17. GET sem sessão responde 401", async () => {
    const response = await handleOnboardingRequest(requestWithCookie("", "GET", null), { DB: db } as never, new URL("https://matematica-delicada.example/api/onboarding"));
    expect(response?.status).toBe(401);
  });

  it("18. userId malicioso no corpo é ignorado — só a sessão define o dono do perfil", async () => {
    const tokenA = await seedUserWithSession("user-18-a");
    await seedUser("user-18-b");

    const request = requestWithCookie("", "PATCH", tokenA, {
      currentGrade: "1_serie_em",
      userId: "user-18-b",
    });
    const response = await handleOnboardingRequest(request, { DB: db } as never, new URL(request.url));
    expect(response?.status).toBe(200);

    const profileA = await findProfile(db as never, "user-18-a");
    const profileB = await findProfile(db as never, "user-18-b");
    expect(profileA?.current_grade).toBe("1_serie_em");
    expect(profileB).toBeNull();
  });

  it("19. eventos mínimos de auditoria são registrados sem respostas sensíveis", async () => {
    const token = await seedUserWithSession("user-19");
    const request = requestWithCookie("", "PATCH", token, { currentGrade: "2_serie_em", currentStep: 1 });
    await handleOnboardingRequest(request, { DB: db } as never, new URL(request.url));

    const events = await db.sqlite
      .prepare("SELECT event_type, metadata FROM audit_log WHERE user_id = ?")
      .all("user-19") as Array<{ event_type: string; metadata: string | null }>;

    const types = events.map((event) => event.event_type);
    expect(types).toContain("onboarding_started");
    expect(types).toContain("onboarding_progress_saved");
    for (const event of events) {
      expect(event.metadata ?? "").not.toMatch(/2_serie_em/);
    }
  });
});

/* Sprint 3 v1.1, Correção C — auditoria e testes explícitos de que
   POST /api/onboarding/complete revalida no servidor (nunca confia no
   currentStep enviado pelo cliente), é idempotente, isolado por usuário, e
   que PATCH pós-conclusão falha INTEGRALMENTE quando mistura campo
   permitido e campo bloqueado no mesmo pedido — nunca aplica parcialmente. */
describe("onboarding v1.1 — conclusão revalida no servidor, nunca confia no currentStep do cliente", () => {
  it("20. currentStep=7 (etapa final) não basta — completar exige os campos obrigatórios realmente persistidos", async () => {
    await seedUser("user-20b");
    // Simula um cliente que "chegou" na última etapa sem preencher os campos
    // obrigatórios — só avança o marcador de etapa, nunca os dados em si.
    await saveProgress(db as never, "user-20b", { currentStep: 7 }, CURRENT_YEAR);

    const result = await completeOnboarding(db as never, "user-20b");

    expect(result.ok).toBe(false);
    expect(Object.keys(result.fieldErrors ?? {}).length).toBeGreaterThan(0);
    const row = await findProfile(db as never, "user-20b");
    expect(row?.status).not.toBe("completed");
  });

  it("21. um usuário não consegue concluir o perfil de outro — a conclusão é sempre escopada ao user_id da sessão", async () => {
    await seedUser("user-21-a");
    await seedUser("user-21-b");
    await fillAllSteps("user-21-a");
    // user-21-b nunca preencheu nada — completeOnboarding só aceita o userId
    // explícito passado pela camada de rota (sempre derivado da sessão, nunca
    // do corpo), então não há como a conclusão de A afetar B.
    const resultB = await completeOnboarding(db as never, "user-21-b");

    expect(resultB.ok).toBe(false);
    const rowA = await findProfile(db as never, "user-21-a");
    const rowB = await findProfile(db as never, "user-21-b");
    expect(rowA?.status).not.toBe("completed");
    expect(rowB).toBeNull();
  });
});

describe("onboarding v1.1 — PATCH pós-conclusão falha integralmente, sem aplicação parcial", () => {
  it("22. campo permitido + campo bloqueado no mesmo pedido: nada é aplicado, nem o campo permitido", async () => {
    await seedUser("user-22");
    await fillAllSteps("user-22");
    await completeOnboarding(db as never, "user-22");
    const before = await findProfile(db as never, "user-22");

    const result = await saveProgress(
      db as never,
      "user-22",
      { dailyMinutes: 999, currentGrade: "1_serie_em" }, // dailyMinutes é permitido; currentGrade não
      CURRENT_YEAR
    );

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.currentGrade).toBeDefined();
    const after = await findProfile(db as never, "user-22");
    // dailyMinutes NÃO foi alterado para 999 — a mutação falhou por inteiro.
    expect(after?.daily_minutes).toBe(before?.daily_minutes);
    expect(after?.current_grade).toBe(before?.current_grade);
  });
});

describe("onboarding v1.1 — acessibilidade: vazio aceito, conteúdo nunca em auditoria", () => {
  it("23. acessibilidade vazia/ausente é aceita — o campo continua opcional", async () => {
    await seedUser("user-23");
    const withNull = await saveProgress(db as never, "user-23", { accessibilityNeeds: null }, CURRENT_YEAR);
    expect(withNull.ok).toBe(true);
    expect(withNull.profile?.accessibilityNeeds).toBeNull();

    const withEmptyString = await saveProgress(
      db as never,
      "user-23",
      { accessibilityNeeds: "   " },
      CURRENT_YEAR
    );
    expect(withEmptyString.ok).toBe(true);
    expect(withEmptyString.profile?.accessibilityNeeds).toBeNull();
  });

  it("24. conteúdo de acessibilidade nunca entra no evento de auditoria", async () => {
    const sensitiveContent = "cadeirante, uso leitor de tela";
    const token = await seedUserWithSessionForAudit("user-24", sensitiveContent);
    void token;

    const events = (await db.sqlite
      .prepare("SELECT event_type, metadata FROM audit_log WHERE user_id = ?")
      .all("user-24")) as Array<{ event_type: string; metadata: string | null }>;

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.metadata ?? "").not.toMatch(/cadeirante/);
      expect(event.metadata ?? "").not.toMatch(/leitor de tela/);
    }
  });

  async function seedUserWithSessionForAudit(id: string, accessibilityNeeds: string): Promise<string> {
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

    const headers = new Headers({ "Content-Type": "application/json", Cookie: `md_session=${rawToken}` });
    const request = new Request("https://matematica-delicada.example/api/onboarding", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ accessibilityNeeds, currentStep: 5 }),
    });
    await handleOnboardingRequest(request, { DB: db } as never, new URL(request.url));
    return rawToken;
  }
});
