/* Recorte de "prática recente" do Mapa ENEM — Sprint 10, v1.1 (correção de
   auditoria da PO em cima da v1.0).

   v1.0 tinha `RECENT_PRACTICE_WINDOW_DAYS` e `isRecentPractice` declarados
   DENTRO de `MapaEnemListPage.tsx`, chamando `Date.now()` diretamente — um
   limiar técnico provisório real (mesma classe dos limiares de
   `worker/src/lib/studentMetricsRules.ts`), mas impossível de testar de
   forma determinística sem depender do relógio real da máquina rodando o
   teste.

   v1.1 — correção (seção 3 da ordem): extraído para este módulo dedicado,
   único lugar no frontend onde o número `14` aparece (auditável por
   `grep -rn "RECENT_PRACTICE_WINDOW_DAYS" src/`). `isRecentPractice` agora
   aceita um segundo parâmetro `now: Date` INJETÁVEL — `new Date()` só como
   valor padrão — mesmo princípio de `Clock`/`systemClock` já usado no
   worker (`worker/src/services/scheduleService.ts`), mantido como um par
   PRÓPRIO aqui em vez de um import cross-pacote: este projeto já separa
   deliberadamente as constantes espelhadas entre frontend e worker (mesma
   convenção de `src/pages/onboarding/onboardingOptions.ts` vs.
   `worker/src/lib/onboardingValidation.ts` — "mantidas separadas de
   propósito"), porque frontend e worker são dois bundles publicáveis
   independentes, sem nenhum import cruzado em nenhum lugar do
   código-fonte hoje.

   Continua um limiar PROVISÓRIO, não uma decisão pedagógica definitiva —
   ajustável aqui, num único lugar, sem tocar em nenhum outro arquivo. */

export const RECENT_PRACTICE_WINDOW_DAYS = 14;

const RECENT_PRACTICE_WINDOW_MS = RECENT_PRACTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Verdadeiro quando `lastPracticeAt` está dentro do recorte de
 *  `RECENT_PRACTICE_WINDOW_DAYS` dias a partir de `now` (fronteira
 *  INCLUSIVA — exatamente no limite ainda conta como recente, mesma
 *  convenção de fronteira `<=` já usada pelos limiares do worker). `now` é
 *  sempre injetável — nunca lê `Date.now()`/relógio do sistema além do
 *  valor padrão do parâmetro, então o resultado não depende do relógio
 *  real nem do fuso horário do ambiente que chama esta função. */
export function isRecentPractice(lastPracticeAt: string | null, now: Date = new Date()): boolean {
  if (!lastPracticeAt) return false;
  const practiced = new Date(lastPracticeAt).getTime();
  if (Number.isNaN(practiced)) return false;
  return now.getTime() - practiced <= RECENT_PRACTICE_WINDOW_MS;
}
