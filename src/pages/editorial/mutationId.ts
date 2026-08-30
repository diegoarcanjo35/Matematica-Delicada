/* Sprint 7 v1.2, Correção A — geração/reaproveitamento de `mutationId` no
   frontend. Regra da ordem: gerar um ID novo por AÇÃO EXPLÍCITA de salvar;
   reutilizar o MESMO ID somente ao repetir a MESMA requisição por falha de
   rede; gerar outro ID para uma edição nova.

   Extraído como funções puras (sem estado de componente, sem DOM) para ser
   testável em isolamento — mesma convenção de
   src/pages/schedule/monthCalendar.ts (lógica pura ao lado da página,
   testada separadamente do componente React). Cobertura de integração
   completa da UX de retry (simular falha de rede real) fica para uma
   suíte E2E futura — documentado em docs/BANCO_QUESTOES.md. */

export interface MutationRetryState {
  mutationId: string;
  /** Assinatura estável do ÚLTIMO payload tentado — comparação por
   *  igualdade de string, nunca por objeto (evita falso-negativo por
   *  identidade de referência). */
  payloadSignature: string;
}

/** Decide qual `mutationId` usar para a PRÓXIMA tentativa de salvar.
 *  Reaproveita o ID em `retryState` SOMENTE se o payload desta tentativa é
 *  byte-a-byte igual ao da tentativa anterior que falhou (mesma edição,
 *  sendo reenviada) — qualquer mudança no conteúdo (mesmo mínima) é tratada
 *  como uma edição NOVA, com um ID novo. */
export function resolveMutationId(
  retryState: MutationRetryState | null,
  payloadSignature: string,
  generateId: () => string = () => crypto.randomUUID()
): string {
  if (retryState && retryState.payloadSignature === payloadSignature) {
    return retryState.mutationId;
  }
  return generateId();
}

/** Serialização estável de um payload para comparação — chaves ordenadas,
 *  para que a mesma edição sempre produza a mesma assinatura independente
 *  da ordem de inserção das propriedades no objeto JS. */
export function computePayloadSignature(payload: unknown): string {
  return JSON.stringify(payload, Object.keys(payload as object).sort());
}

/** `true` quando o erro indica que a requisição NUNCA chegou a uma resposta
 *  do servidor (falha de rede real — ex.: `fetch` lançando `TypeError`,
 *  timeout, DNS, offline). Uma resposta HTTP de erro (400/409/etc.) SEMPRE
 *  chega como `EditorialApiError` (tem `status` e `code`) — isso significa
 *  que o servidor processou a requisição, então NÃO é um caso de retry por
 *  falha de rede (a política de retry-com-mesmo-ID é só para quando o
 *  servidor nunca viu a tentativa anterior). */
export function isNetworkFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  return !("status" in error && "code" in error);
}
