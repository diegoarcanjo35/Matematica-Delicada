import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* Cria (ou reaproveita) um usuário de teste fixo e salva o cookie de sessão como
   storageState do Playwright, para que os testes de UI da área autenticada não
   precisem repetir login em cada arquivo. Testes que precisam começar deslogados
   usam test.use({ storageState: { cookies: [], origins: [] } }) por arquivo. */

const BASE_URL = "http://localhost:8788";
export const E2E_TEST_EMAIL = "e2e-tests@matematicadelicada.dev";
export const E2E_TEST_PASSWORD = "senha-de-teste-e2e-123";
const STORAGE_STATE_PATH = path.join(import.meta.dirname, ".auth", "user.json");

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Servidor não respondeu em /api/health a tempo.");
}

export default async function globalSetup(): Promise<void> {
  await waitForServer();

  // Tenta cadastrar; se já existir (execuções anteriores), segue para o login.
  await fetch(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({
      name: "Usuário E2E",
      email: E2E_TEST_EMAIL,
      password: E2E_TEST_PASSWORD,
      confirmPassword: E2E_TEST_PASSWORD,
      acceptTerms: true,
    }),
  });

  // Confirma o e-mail via caixa de saída local/dev, para testar com conta confirmada.
  const outboxResponse = await fetch(
    `${BASE_URL}/api/dev/outbox/last?to=${encodeURIComponent(E2E_TEST_EMAIL)}&kind=email_confirmation`
  );
  if (outboxResponse.ok) {
    const { email } = (await outboxResponse.json()) as { email: { body: string } };
    const token = new URL(email.body.split(": ").pop()!.trim()).searchParams.get("token");
    if (token) {
      await fetch(`${BASE_URL}/api/auth/email/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        body: JSON.stringify({ token }),
      });
    }
  }

  const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: E2E_TEST_EMAIL, password: E2E_TEST_PASSWORD }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Falha ao autenticar o usuário de teste E2E: ${loginResponse.status}`);
  }

  const setCookie = loginResponse.headers.get("set-cookie");
  if (!setCookie) throw new Error("Login não retornou cookie de sessão.");

  const tokenValue = setCookie.split(";")[0].split("=").slice(1).join("=");

  mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(
    STORAGE_STATE_PATH,
    JSON.stringify({
      cookies: [
        {
          name: "md_session",
          value: tokenValue,
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    })
  );
}
