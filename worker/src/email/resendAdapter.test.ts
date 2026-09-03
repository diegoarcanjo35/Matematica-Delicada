// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResendEmailAdapter } from "./resendAdapter";

/* Sprint 16 v1.0 (A1) — testes direcionados do adaptador de e-mail real.
   `fetch` é substituído por um mock controlado (nunca uma chamada de rede
   real em teste) — mesma disciplina do resto do projeto de nunca depender
   de um serviço externo genuíno para um teste passar de forma determinística. */

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

let consoleErrorSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  consoleErrorSpy = vi.fn();
  console.error = consoleErrorSpy as never;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  vi.restoreAllMocks();
});

const MESSAGE = {
  to: "aluno@exemplo.com",
  subject: "Confirme seu e-mail",
  body: "Olá! Confirme acessando: https://exemplo.com/confirmar?token=abc",
  kind: "email_confirmation" as const,
};

describe("ResendEmailAdapter.send", () => {
  it("HTTP 200 da Resend -> sent:true, sem console.error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const adapter = new ResendEmailAdapter("re_chave-de-teste-1234567890", "No-Reply <no-reply@exemplo.com>");
    const result = await adapter.send(MESSAGE);

    expect(result.sent).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Confirma a forma real da requisição — endpoint, método, autenticação
    // via header (nunca na URL), payload mínimo esperado pela API da Resend.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://api.resend.com/emails");
    expect(calledInit.method).toBe("POST");
    expect((calledInit.headers as Record<string, string>).Authorization).toBe("Bearer re_chave-de-teste-1234567890");
    const body = JSON.parse(calledInit.body as string);
    expect(body.from).toBe("No-Reply <no-reply@exemplo.com>");
    expect(body.to).toEqual(["aluno@exemplo.com"]);
    expect(body.subject).toBe(MESSAGE.subject);
    expect(body.text).toBe(MESSAGE.body);
  });

  it("HTTP não-2xx da Resend -> sent:false, falha NUNCA silenciosa (console.error com contexto)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: "chave inválida" }), { status: 401 }));
    globalThis.fetch = fetchMock as never;

    const adapter = new ResendEmailAdapter("re_chave-invalida", "no-reply@exemplo.com");
    const result = await adapter.send(MESSAGE);

    expect(result.sent).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedMessage = consoleErrorSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain("email_confirmation");
    expect(loggedMessage).toContain("401");
    // Nunca loga o corpo da MENSAGEM (que pode conter o link/token) — só o
    // status e a resposta de erro DO PROVEDOR.
    expect(loggedMessage).not.toContain(MESSAGE.body);
  });

  it("falha de rede (fetch rejeita) -> sent:false, também nunca silenciosa", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network error"));
    globalThis.fetch = fetchMock as never;

    const adapter = new ResendEmailAdapter("re_chave-de-teste-1234567890", "no-reply@exemplo.com");
    const result = await adapter.send(MESSAGE);

    expect(result.sent).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const loggedMessage = consoleErrorSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain("email_confirmation");
    expect(loggedMessage).toContain("erro de rede");
  });
});
