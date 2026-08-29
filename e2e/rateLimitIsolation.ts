import type { Page } from "@playwright/test";

/* Sprint 3 v1.2 — correção estrutural da dependência de ordem entre arquivos
   de teste E2E. Sem isso, todo tráfego local compartilha o identificador de
   IP fixo "local-dev" (ver worker/src/lib/rateLimit.ts), então um arquivo
   que esgota o limite de cadastro/login "vazava" esse esgotamento para
   qualquer outro arquivo — dependendo implicitamente de qual arquivo rodava
   antes/depois, algo que renomear alfabeticamente só mascarava.

   O Worker só honra o cabeçalho abaixo sob as três condições de falha
   fechada de isTestRateLimitIsolationAllowed (worker/src/env.ts), nunca em
   produção.

   IMPORTANTE — por que isto não usa test.use({ extraHTTPHeaders }): esse
   mecanismo aplica o cabeçalho a TODA requisição da página, inclusive
   cross-origin (ex.: fontes do Google Fonts), o que quebra o preflight CORS
   dessas requisições de terceiros (elas não esperam nem permitem esse
   cabeçalho customizado). Por isso, o cabeçalho é aplicado de duas formas
   cirúrgicas, escolhidas conforme como cada teste fala com a API:
   - `testClientIdHeader(tag)` — objeto de cabeçalho para passar diretamente
     em chamadas via `request`/`page.request` (APIRequestContext, nunca passa
     pelo navegador, então nunca afeta terceiros);
   - `installTestClientIdRoute(page, tag)` — intercepta só requisições de
     MESMA ORIGEM para `/api/**` feitas pelo próprio navegador (formulários
     reais, ex. cadastro via UI), sem tocar em nenhuma requisição
     cross-origin. */

const HEADER_NAME = "X-E2E-RateLimit-Client-Id";

function testClientId(fileTag: string): string {
  // process.pid distingue execuções separadas de `npm run test:e2e` (novo
  // processo Node a cada invocação) sem exigir Math.random()/Date.now() em
  // todo arquivo que usar este helper.
  return `${fileTag}-${process.pid}`;
}

/** Para uso em `request.post(url, { headers: testClientIdHeader("tag"), data })`
 *  ou `page.request.post(...)` — chamadas via APIRequestContext, que nunca
 *  passam pelo navegador e por isso nunca arriscam vazar para terceiros. */
export function testClientIdHeader(fileTag: string): Record<string, string> {
  return { [HEADER_NAME]: testClientId(fileTag) };
}

/** Para uso quando o teste dirige a UI real (preenche formulário e clica) —
 *  intercepta só `/api/**` de mesma origem e injeta o cabeçalho ali; qualquer
 *  outra requisição da página (fontes, etc.) passa intacta. */
export async function installTestClientIdRoute(page: Page, fileTag: string): Promise<void> {
  const value = testClientId(fileTag);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) {
      await route.continue({ headers: { ...request.headers(), [HEADER_NAME]: value } });
      return;
    }
    await route.continue();
  });
}
