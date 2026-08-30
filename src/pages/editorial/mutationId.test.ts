import { describe, expect, it } from "vitest";
import { computePayloadSignature, isNetworkFailure, resolveMutationId } from "./mutationId";

/* Sprint 7 v1.2, Correção A, item 15 — cobertura da lógica de
   geração/reaproveitamento de mutationId no frontend. Testado em isolamento
   como funções puras (mesma convenção de monthCalendar.test.ts) — cobertura
   de integração completa da UX de retry (simular uma falha de rede real
   contra o componente montado) fica para uma suíte E2E futura, documentada
   em docs/BANCO_QUESTOES.md. */

describe("resolveMutationId", () => {
  it("gera um novo ID quando não há estado de retry (primeira tentativa de salvar)", () => {
    const id = resolveMutationId(null, "sig-1", () => "fixed-id-1");
    expect(id).toBe("fixed-id-1");
  });

  it("reutiliza o MESMO ID quando o payload da nova tentativa é idêntico ao da tentativa que falhou (retry de rede)", () => {
    const retryState = { mutationId: "retry-id-1", payloadSignature: "sig-1" };
    const id = resolveMutationId(retryState, "sig-1", () => "should-not-be-used");
    expect(id).toBe("retry-id-1");
  });

  it("gera um ID NOVO quando o payload mudou desde a última tentativa (edição nova, não um retry)", () => {
    const retryState = { mutationId: "retry-id-1", payloadSignature: "sig-1" };
    const id = resolveMutationId(retryState, "sig-2-diferente", () => "fresh-id");
    expect(id).toBe("fresh-id");
    expect(id).not.toBe(retryState.mutationId);
  });

  it("usa crypto.randomUUID() por padrão quando nenhum gerador é injetado", () => {
    const id = resolveMutationId(null, "sig-x");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("computePayloadSignature", () => {
  it("produz a MESMA assinatura para o mesmo conteúdo, independente da ordem das chaves", () => {
    const a = { enunciado: "x", dificuldade: "media" };
    const b = { dificuldade: "media", enunciado: "x" };
    expect(computePayloadSignature(a)).toBe(computePayloadSignature(b));
  });

  it("produz assinaturas DIFERENTES para conteúdos diferentes", () => {
    const a = { enunciado: "x" };
    const b = { enunciado: "y" };
    expect(computePayloadSignature(a)).not.toBe(computePayloadSignature(b));
  });
});

describe("isNetworkFailure", () => {
  it("uma EditorialApiError (tem status+code) NÃO é falha de rede — o servidor respondeu", () => {
    const apiError = { status: 409, code: "version_conflict", message: "conflito" };
    expect(isNetworkFailure(apiError)).toBe(false);
  });

  it("um erro genérico (ex.: TypeError de fetch) É tratado como falha de rede", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("um valor não-objeto também é tratado como falha de rede (fail-safe: permite retry)", () => {
    expect(isNetworkFailure("erro string qualquer")).toBe(true);
    expect(isNetworkFailure(null)).toBe(true);
  });
});
