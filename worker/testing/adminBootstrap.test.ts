// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleAdminBootstrapRequest } from "../src/routes/adminBootstrap";

/* Sprint 15 v1.1 (adendo) — Bootstrap Administrativo Seguro
   (worker/src/routes/adminBootstrap.ts -> worker/src/services/
   adminBootstrapService.ts). Cobre os 15 itens da seção O do adendo.

   Mesma convenção de worker/testing/weeklyReviewAtomicity.test.ts para a
   prova de concorrência real: pauseReadsMatching bloqueia a pré-checagem
   de AMBAS as chamadas concorrentes no mesmo ponto, garantindo que as duas
   cheguem a tentar o db.batch() — só assim a corrida real (não só a ordem
   "natural" de microtasks) é exercitada. */

const SECRET = "test-only-bootstrap-secret-not-real-1234567890";

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
});

function envWithSecret(secret: string | undefined = SECRET): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ADMIN_BOOTSTRAP_SECRET: secret };
}

const LOCAL_ORIGIN = "http://localhost:8793";

async function seedAccount(id: string, email: string): Promise<void> {
  await createUser(db as never, {
    id,
    name: `Conta ${id}`,
    email,
    emailNormalized: email.toLowerCase(),
    passwordHash: await hashPassword("senha-original-123"),
  });
}

function newMutationId(): string {
  return crypto.randomUUID();
}

async function callBootstrap(
  body: Record<string, unknown>,
  opts: { secretHeader?: string | null; env?: Env } = {}
): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const secretHeader = opts.secretHeader === undefined ? SECRET : opts.secretHeader;
  if (secretHeader !== null) headers.set("X-Admin-Bootstrap-Secret", secretHeader);
  const request = new Request(`${LOCAL_ORIGIN}/api/admin-bootstrap/run`, { method: "POST", headers, body: JSON.stringify(body) });
  const response = await handleAdminBootstrapRequest(request, opts.env ?? envWithSecret(), new URL(request.url));
  return response!;
}

function countRows(table: string): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number }).total;
}

describe("Exposição da rota (adendo seção N/Q)", () => {
  it("sem ADMIN_BOOTSTRAP_SECRET configurado, a rota não existe (retorna null, index.ts responderia 404)", async () => {
    const request = new Request(`${LOCAL_ORIGIN}/api/admin-bootstrap/run`, { method: "POST", headers: { "X-Admin-Bootstrap-Secret": "qualquer" } });
    const unconfiguredEnv: Env = { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development" }; // ADMIN_BOOTSTRAP_SECRET ausente de propósito
    const response = await handleAdminBootstrapRequest(request, unconfiguredEnv, new URL(request.url));
    expect(response).toBeNull();
  });

  it("ADMIN_BOOTSTRAP_SECRET curto demais (<20 caracteres) também é tratado como não configurado", async () => {
    const request = new Request(`${LOCAL_ORIGIN}/api/admin-bootstrap/run`, { method: "POST", headers: { "X-Admin-Bootstrap-Secret": "curto" } });
    const shortSecretEnv: Env = { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", ADMIN_BOOTSTRAP_SECRET: "curto" };
    const response = await handleAdminBootstrapRequest(request, shortSecretEnv, new URL(request.url));
    expect(response).toBeNull();
  });

  it("GET não é aceito", async () => {
    const request = new Request(`${LOCAL_ORIGIN}/api/admin-bootstrap/run`, { method: "GET", headers: { "X-Admin-Bootstrap-Secret": SECRET } });
    const response = await handleAdminBootstrapRequest(request, envWithSecret(), new URL(request.url));
    expect(response!.status).toBe(405);
  });
});

describe("1. bootstrap sem credencial -> negado", () => {
  it("sem cabeçalho X-Admin-Bootstrap-Secret: 401, nada alterado", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    const response = await callBootstrap(
      { identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() },
      { secretHeader: null }
    );
    expect(response.status).toBe(401);
    expect(countRows("admin_bootstrap_state")).toBe(0);
    expect(countRows("user_roles")).toBe(0);
  });
});

describe("2. credencial inválida -> negado", () => {
  it("segredo incorreto: 401, nada alterado", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    const response = await callBootstrap(
      { identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() },
      { secretHeader: "segredo-errado" }
    );
    expect(response.status).toBe(401);
    expect(countRows("admin_bootstrap_state")).toBe(0);
  });
});

describe("3/4. conta inexistente -> nada alterado", () => {
  it("conta A inexistente: 400, nenhuma linha criada", async () => {
    await seedAccount("u-b", "diego@teste.dev");
    const response = await callBootstrap({ identifierA: "nao-existe@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() });
    expect(response.status).toBe(400);
    expect(countRows("admin_bootstrap_state")).toBe(0);
    expect(countRows("user_roles")).toBe(0);
  });

  it("conta B inexistente: 400, nenhuma linha criada", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    const response = await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "nao-existe@teste.dev", mutationId: newMutationId() });
    expect(response.status).toBe(400);
    expect(countRows("admin_bootstrap_state")).toBe(0);
    expect(countRows("user_roles")).toBe(0);
  });
});

describe("5/6/7/8. contas válidas -> ambas recebem admin, bootstrap concluído, auditoria criada, sem segredo na auditoria", () => {
  it("caminho feliz completo", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    const mutationId = newMutationId();
    const response = await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: true; alreadyCompleted: false; promotedUserIds: [string, string] };
    expect(body.promotedUserIds.sort()).toEqual(["u-a", "u-b"]);

    const state = db.sqlite.prepare(`SELECT * FROM admin_bootstrap_state WHERE id = 'singleton'`).get() as {
      promoted_user_id_1: string;
      promoted_user_id_2: string;
    };
    expect(state).toBeTruthy();

    const adminRoleRow = db.sqlite.prepare(`SELECT id FROM roles WHERE name = 'admin'`).get() as { id: string };
    const grants = db.sqlite.prepare(`SELECT user_id FROM user_roles WHERE role_id = ?`).all(adminRoleRow.id) as Array<{ user_id: string }>;
    expect(grants.map((g) => g.user_id).sort()).toEqual(["u-a", "u-b"]);

    const auditRows = db.sqlite.prepare(`SELECT event_type, metadata FROM audit_log ORDER BY event_type`).all() as Array<{
      event_type: string;
      metadata: string | null;
    }>;
    const eventTypes = auditRows.map((r) => r.event_type).sort();
    expect(eventTypes).toEqual(["admin_bootstrap_completed", "admin_role_assigned", "admin_role_assigned"]);

    for (const row of auditRows) {
      expect(row.metadata ?? "").not.toContain(SECRET);
      expect((row.metadata ?? "").toLowerCase()).not.toContain("secret");
    }
  });
});

describe("9. segunda execução -> negada", () => {
  it("depois de concluído, uma nova tentativa (contas diferentes) é recusada sem alterar nada", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    await seedAccount("u-c", "terceiro@teste.dev");
    await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() });

    const before = { state: countRows("admin_bootstrap_state"), roles: countRows("user_roles"), audit: countRows("audit_log") };
    const response = await callBootstrap({ identifierA: "diego@teste.dev", identifierB: "terceiro@teste.dev", mutationId: newMutationId() });
    const body = (await response.json()) as { ok: true; alreadyCompleted: true };
    expect(body.alreadyCompleted).toBe(true);
    expect({ state: countRows("admin_bootstrap_state"), roles: countRows("user_roles"), audit: countRows("audit_log") }).toEqual(before);
  });
});

describe("10/11. retry não duplica user_roles nem auditoria", () => {
  it("retry com o MESMO mutationId, mesmas contas: idempotente, nenhuma linha nova", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    const mutationId = newMutationId();
    await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId });

    const before = { roles: countRows("user_roles"), audit: countRows("audit_log") };
    const response = await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; alreadyCompleted: true };
    expect(body.alreadyCompleted).toBe(true);
    expect({ roles: countRows("user_roles"), audit: countRows("audit_log") }).toEqual(before);
  });
});

describe("12. falha no meio -> rollback/nenhum estado parcial", () => {
  it("uma falha forçada no meio do lote não deixa NENHUM traço (nem estado, nem papel, nem auditoria)", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    // Força uma falha na PRIMEIRA concessão de papel (INSERT OR IGNORE
    // INTO user_roles) — o INSERT do estado do bootstrap (statement
    // anterior no mesmo lote) já teria "acontecido" dentro da transação
    // em andamento; a exceção aborta o BEGIN inteiro (ROLLBACK real do
    // FakeD1Database, mesma garantia transacional do D1 real), então nada
    // deve sobreviver — nem o estado, nem qualquer papel, nem auditoria.
    db.failNextMatching(/INSERT OR IGNORE INTO user_roles/);

    // O erro forçado não é uma violação de UNIQUE reconhecida pelo serviço
    // (adminBootstrapService.ts só trata colisões de
    // admin_bootstrap_state/audit_log como esperadas) — propaga (a rota
    // real, atrás de worker/src/index.ts, converteria isso num 500 opaco;
    // aqui, chamando a rota diretamente, o teste prova a propagação em si
    // — nunca um 200/201 de sucesso mentiroso).
    await expect(
      callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() })
    ).rejects.toThrow("forced_failure_for_test");

    expect(countRows("admin_bootstrap_state")).toBe(0);
    expect(countRows("user_roles")).toBe(0);
    expect(countRows("audit_log")).toBe(0);
  });
});

describe("13. usuário já admin em uma das contas -> comportamento determinístico e seguro", () => {
  it("conta A já é admin antes do bootstrap: bootstrap conclui normalmente, sem duplicar papel", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    db.sqlite.exec(`INSERT OR IGNORE INTO roles (id, name) VALUES ('role-admin', 'admin')`);
    db.sqlite.exec(`INSERT INTO user_roles (id, user_id, role_id, granted_by) VALUES ('pre-existing', 'u-a', 'role-admin', NULL)`);

    const response = await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() });
    expect(response.status).toBe(201);

    const grants = db.sqlite.prepare(`SELECT COUNT(*) as total FROM user_roles WHERE user_id = 'u-a' AND role_id = 'role-admin'`).get() as {
      total: number;
    };
    expect(grants.total).toBe(1); // nunca duplicado
    const bGrants = db.sqlite.prepare(`SELECT COUNT(*) as total FROM user_roles WHERE user_id = 'u-b' AND role_id = 'role-admin'`).get() as {
      total: number;
    };
    expect(bGrants.total).toBe(1);
  });
});

describe("14. tentativa de promover role diferente de admin -> impossível pelo contrato", () => {
  it("o corpo da requisição não aceita nenhum campo de papel — o contrato só promove a 'admin'", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    const response = await callBootstrap({
      identifierA: "andreia@teste.dev",
      identifierB: "diego@teste.dev",
      mutationId: newMutationId(),
      role: "super_admin", // campo ignorado — nunca lido pelo serviço
    });
    expect(response.status).toBe(201);
    const roles = db.sqlite.prepare(`SELECT DISTINCT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id`).all() as Array<{ name: string }>;
    expect(roles.map((r) => r.name)).toEqual(["admin"]);
  });
});

describe("15. GETs continuam sem mutação", () => {
  it("GET na mesma URL não é aceito e não altera nada", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    const request = new Request(`${LOCAL_ORIGIN}/api/admin-bootstrap/run`, { method: "GET", headers: { "X-Admin-Bootstrap-Secret": SECRET } });
    const response = await handleAdminBootstrapRequest(request, envWithSecret(), new URL(request.url));
    expect(response!.status).toBe(405);
    expect(countRows("admin_bootstrap_state")).toBe(0);
  });
});

describe("Validações adicionais", () => {
  it("mesma conta para identifierA e identifierB é rejeitada", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    const response = await callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "andreia@teste.dev", mutationId: newMutationId() });
    expect(response.status).toBe(400);
    expect(countRows("admin_bootstrap_state")).toBe(0);
  });

  it("e-mail mal formado é rejeitado", async () => {
    const response = await callBootstrap({ identifierA: "nao-e-email", identifierB: "diego@teste.dev", mutationId: newMutationId() });
    expect(response.status).toBe(400);
  });
});

describe("Concorrência real (adendo seção I/J — prova por interleaving forçado)", () => {
  it("duas execuções verdadeiramente concorrentes: só UMA conclui, nunca estado parcial, nunca dois vencedores", async () => {
    await seedAccount("u-a", "andreia@teste.dev");
    await seedAccount("u-b", "diego@teste.dev");
    await seedAccount("u-c", "terceiro@teste.dev");
    await seedAccount("u-d", "quarto@teste.dev");

    // Pausa a pré-checagem (SELECT ... admin_bootstrap_state) das DUAS
    // chamadas concorrentes no mesmo ponto — só assim as duas chegam a
    // tentar o db.batch() de verdade, exercitando a corrida real (mesmo
    // padrão de worker/testing/weeklyReviewAtomicity.test.ts).
    const gate = db.pauseReadsMatching(/SELECT \* FROM admin_bootstrap_state WHERE id = 'singleton'/, 2);

    const call1 = callBootstrap({ identifierA: "andreia@teste.dev", identifierB: "diego@teste.dev", mutationId: newMutationId() });
    const call2 = callBootstrap({ identifierA: "terceiro@teste.dev", identifierB: "quarto@teste.dev", mutationId: newMutationId() });

    await gate.arrived;
    gate.release();

    const [r1, r2] = await Promise.all([call1, call2]);
    const statuses = [r1.status, r2.status].sort();
    // Uma vence (201), a outra perde a corrida e é informada como já
    // concluída (200, alreadyCompleted:true) — nunca as duas vencem, nunca
    // as duas falham silenciosamente.
    expect(statuses).toEqual([200, 201]);

    expect(countRows("admin_bootstrap_state")).toBe(1);
    const adminRoleRow = db.sqlite.prepare(`SELECT id FROM roles WHERE name = 'admin'`).get() as { id: string };
    const grants = db.sqlite.prepare(`SELECT user_id FROM user_roles WHERE role_id = ?`).all(adminRoleRow.id) as Array<{ user_id: string }>;
    // Exatamente o par vencedor foi promovido — nunca os dois pares, nunca
    // uma promoção parcial de só uma conta de um dos pares.
    expect(grants.length).toBe(2);
    const winners = grants.map((g) => g.user_id).sort();
    expect(["u-a", "u-b"].sort().join(",") === winners.join(",") || ["u-c", "u-d"].sort().join(",") === winners.join(",")).toBe(true);

    const auditCount = db.sqlite.prepare(`SELECT COUNT(*) as total FROM audit_log`).get() as { total: number };
    expect(auditCount.total).toBe(3); // 2x admin_role_assigned + 1x admin_bootstrap_completed, nunca 6
  });
});
