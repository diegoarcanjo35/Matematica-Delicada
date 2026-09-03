// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { hashPassword } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { handleAuthRequest } from "../src/routes/auth";

/* Sprint 16 v1.0 (A1) — prova, pela ROTA real (nunca só a chamada direta ao
   serviço), que uma falha de envio de e-mail NUNCA fica silenciosa: gera
   sempre um evento `email_send_failed` em audit_log, sem nunca mudar a
   resposta HTTP genérica (anti-enumeração continua intacta).

   Deliberadamente NÃO mocka fetch/Resend aqui: um ambiente "produção real"
   (sem ENVIRONMENT, sem DEV_OUTBOX_ENABLED, sem RESEND_API_KEY/
   EMAIL_FROM_ADDRESS) já resolve para NoProviderEmailAdapter — que sempre
   retorna `{ sent: false }` por desenho (worker/src/email/devOutboxAdapter.ts)
   — exatamente o estado real de produção hoje, antes de um secret real ser
   configurado numa rodada separada. Isso prova o comportamento fim a fim
   com o MENOR número de peças móveis possível. O adaptador Resend em si
   (sucesso/falha do provedor) já é testado isoladamente em
   worker/src/email/resendAdapter.test.ts. */

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
});

async function seedUser(id: string, emailConfirmed = false): Promise<void> {
  await createUser(db as never, {
    id,
    name: "Usuária Teste",
    email: `${id}@teste.dev`,
    emailNormalized: `${id}@teste.dev`,
    passwordHash: await hashPassword("senha-original-123"),
  });
  if (emailConfirmed) {
    db.sqlite.exec(`UPDATE users SET email_confirmed_at = datetime('now') WHERE id = '${id}'`);
  }
}

const PROD_ORIGIN = "https://matematica-delicada.proffandreia5.workers.dev";

/** Config "produção real hoje" — nenhuma flag de dev, nenhum provedor real
 *  configurado ainda. Resolve para NoProviderEmailAdapter (sent: false, sempre). */
function productionEnvWithoutProvider(): Env {
  return { DB: db as never, ASSETS: {} as never };
}

/** Config local com outbox dev habilitado — DevOutboxEmailAdapter (sent: true, sempre). */
function localEnvWithOutbox(): Env {
  return { DB: db as never, ASSETS: {} as never, ENVIRONMENT: "development", DEV_OUTBOX_ENABLED: "true" };
}

function countAuditRows(eventType: string): number {
  return (db.sqlite.prepare(`SELECT COUNT(*) as total FROM audit_log WHERE event_type = ?`).get(eventType) as { total: number })
    .total;
}

async function postJson(env: Env, origin: string, path: string, body: unknown): Promise<Response> {
  const request = new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await handleAuthRequest(request, env, new URL(request.url))) as Response;
}

describe("falha real de envio de e-mail nunca fica silenciosa (audit_log: email_send_failed)", () => {
  it("cadastro em ambiente sem provedor real configurado: conta criada normalmente, mas a falha de envio é auditada", async () => {
    const response = await postJson(productionEnvWithoutProvider(), PROD_ORIGIN, "/api/auth/signup", {
      name: "Aluna Teste",
      email: "aluna.nova@teste.dev",
      password: "senha-real-123456",
      confirmPassword: "senha-real-123456",
      acceptTerms: true,
    });

    // Resposta HTTP continua 201/{ok:true} — a conta FOI criada, isso nunca muda.
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(countAuditRows("email_send_failed")).toBe(1);
    const row = db.sqlite
      .prepare(`SELECT metadata FROM audit_log WHERE event_type = 'email_send_failed'`)
      .get() as { metadata: string | null };
    const metadata = JSON.parse(row.metadata ?? "{}");
    expect(metadata.kind).toBe("email_confirmation");
  });

  it("reenvio de confirmação sem provedor real configurado: resposta genérica, falha auditada", async () => {
    await seedUser("user-resend");
    const response = await postJson(
      productionEnvWithoutProvider(),
      PROD_ORIGIN,
      "/api/auth/email/request-confirmation",
      { email: "user-resend@teste.dev" }
    );

    expect(response.status).toBe(200);
    expect(countAuditRows("email_send_failed")).toBe(1);
  });

  it("solicitação de redefinição de senha sem provedor real configurado: resposta genérica, falha auditada", async () => {
    await seedUser("user-reset");
    const response = await postJson(productionEnvWithoutProvider(), PROD_ORIGIN, "/api/auth/password/request-reset", {
      email: "user-reset@teste.dev",
    });

    expect(response.status).toBe(200);
    expect(countAuditRows("email_send_failed")).toBe(1);
    // O evento "de negócio" (password_reset_requested) continua sendo gravado
    // independentemente do envio — são dois fatos distintos.
    expect(countAuditRows("password_reset_requested")).toBe(1);
  });

  it("e-mail já confirmado: nenhum envio é tentado, e portanto nenhuma falha é auditada (não é um erro)", async () => {
    await seedUser("user-already-confirmed", true);
    const response = await postJson(
      productionEnvWithoutProvider(),
      PROD_ORIGIN,
      "/api/auth/email/request-confirmation",
      { email: "user-already-confirmed@teste.dev" }
    );

    expect(response.status).toBe(200);
    expect(countAuditRows("email_send_failed")).toBe(0);
  });

  it("e-mail inexistente na recuperação de senha: nenhum envio é tentado, nenhuma falha auditada (anti-enumeração)", async () => {
    const response = await postJson(productionEnvWithoutProvider(), PROD_ORIGIN, "/api/auth/password/request-reset", {
      email: "nao-existe@teste.dev",
    });

    expect(response.status).toBe(200);
    expect(countAuditRows("email_send_failed")).toBe(0);
  });

  it("com o outbox local habilitado (envio sempre bem-sucedido), nenhuma falha é auditada", async () => {
    const response = await postJson(localEnvWithOutbox(), "http://localhost:8793", "/api/auth/signup", {
      name: "Aluno Local",
      email: "aluno.local@teste.dev",
      password: "senha-real-123456",
      confirmPassword: "senha-real-123456",
      acceptTerms: true,
    });

    expect(response.status).toBe(201);
    expect(countAuditRows("email_send_failed")).toBe(0);
    // Confirma que o outbox realmente recebeu a mensagem (prova positiva, não só ausência de falha).
    expect(countRows(db, "dev_email_outbox")).toBe(1);
  });
});

function countRows(database: FakeD1Database, table: string): number {
  return (database.sqlite.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number }).total;
}
