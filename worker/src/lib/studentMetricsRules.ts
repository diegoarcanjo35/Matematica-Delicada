/* Regras técnicas PROVISÓRIAS do Mapa ENEM — Sprint 10, v1.2 (correção de
   auditoria da PO em cima da v1.1, que por sua vez corrigiu a v1.0).
   Centralizadas aqui, exatamente como
   worker/src/lib/spacedReview.ts fez para a revisão espaçada (Sprint 9):
   nada aqui é fórmula pedagógica definitiva de reconhecimento, resolução
   ou domínio — são só rótulos DESCRITIVOS derivados de contadores brutos
   já reais, para dar ao aluno uma leitura honesta do que já foi
   praticado, nunca uma nota. Ajustáveis no futuro sem qualquer migration
   destrutiva (é só código, nenhum dado é gravado com este rótulo — ele é
   sempre recalculado na leitura).

   v1.1 — o que mudou (correção PO, seção 1 da ordem): a v1.0 usava só
   "≥3 questões distintas E ≥70% de acerto" para `consistente_no_recorte`
   — pura taxa de acerto bruta, que ignora repetição em momentos
   diferentes, dependência de ajuda, revisão espaçada e resultado
   sustentado ao longo do tempo. A taxa de acerto CONTINUA existindo como
   dado descritivo (é literalmente o que a UI mostra), mas deixou de ser a
   ÚNICA base do estado: agora é só UM entre cinco critérios que precisam
   valer TODOS juntos (E, nunca OU) para o estado mais forte.

   v1.2 — o que mudou (correção PO, seção 1 da ordem desta rodada): a v1.1
   exigia `hasCorrectReview` como critério ISOLADO e obrigatório — mas
   revisão espaçada só nasce do Caderno de Erros, que só nasce de um erro
   confirmado. Um aluno que NUNCA erra, por mais prática distinta e
   multi-sessão que acumule, nunca gera revisão nenhuma e ficava PRESO
   para sempre em `em_desenvolvimento` — a v1.1 documentava isso como
   "limitação conhecida", mas a PO pediu correção estrutural, não só o
   registro do limite. `hasCorrectReview` isolado foi substituído por
   `hasMaintenanceEvidence = hasCorrectReview OR
   sustainedEvidenceWithoutReview`: um aluno que errou prova manutenção
   por revisão correta (caminho antigo, inalterado); um aluno que nunca
   errou prova manutenção por desempenho sustentado ao longo de pelo menos
   `MIN_MAINTENANCE_WINDOW_DAYS` dias entre a primeira e a última
   tentativa confirmada — nunca pela quantidade de dias-calendário
   distintos sozinha (que já é o critério (b) de sempre), e sim pelo
   INTERVALO real entre o primeiro e o último registro. Evidência
   concentrada num único dia ou em poucos dias (< 7 dias de intervalo)
   continua insuficiente nos dois caminhos. */

export const PROVISIONAL_STATES = [
  "sem_evidencias",
  "evidencias_iniciais",
  "em_desenvolvimento",
  "consistente_no_recorte",
  "revisao_pendente",
] as const;
export type ProvisionalState = (typeof PROVISIONAL_STATES)[number];

export const PROVISIONAL_STATE_LABELS: Record<ProvisionalState, string> = {
  sem_evidencias: "Ainda sem evidências suficientes",
  evidencias_iniciais: "Evidências iniciais",
  em_desenvolvimento: "Em desenvolvimento",
  consistente_no_recorte: "Consistente neste recorte",
  revisao_pendente: "Revisão pendente",
};

/** Limiares PROVISÓRIOS — nenhum validado pedagogicamente pela Andreia
 *  ainda (mesma ressalva de `spacedReview.ts`). Escolhidos para serem
 *  simples e explicáveis, não para otimizar nenhuma métrica. Ajustáveis
 *  aqui, num único lugar, sem tocar em nenhuma tabela ou em nenhum outro
 *  arquivo (seção 1 da ordem v1.1: "todos os novos limiares centralizados
 *  num único módulo"). */
export const MIN_CONFIRMED_FOR_DEVELOPMENT = 3;
export const MIN_DISTINCT_QUESTIONS_FOR_CONSISTENT = 3;
export const MIN_CORRECT_RATE_FOR_CONSISTENT = 0.7;
/** v1.1 — evidência precisa se espalhar por pelo menos DOIS dias-calendário
 *  distintos de prática confirmada; um único dia/momento, por mais
 *  questões distintas ou acerto que tenha, nunca é "consistência ao longo
 *  do tempo" — só repetição dentro de uma mesma sessão. */
export const MIN_DISTINCT_SESSIONS_FOR_CONSISTENT = 2;
/** v1.1 — proporção MÁXIMA de tentativas confirmadas deste padrão que
 *  podem ter usado ajuda (qualquer camada) para o padrão ainda contar como
 *  "consistente neste recorte". Acima disso, o resultado correto está
 *  sendo alcançado COM apoio pesado, o que a PO explicitamente pediu para
 *  nunca ser confundido com consistência independente. Comparação é
 *  `<=` (metade das tentativas com ajuda ainda é tolerado; mais que
 *  metade já bloqueia) — mesma convenção de fronteira inclusiva já usada
 *  por `MIN_CORRECT_RATE_FOR_CONSISTENT` (`>=`). */
export const MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT = 0.5;
/** v1.2 (correção PO, seção 1 da ordem) — limiar PROVISÓRIO TÉCNICO, ainda
 *  pendente de validação pedagógica da Andréia (mesma ressalva de todos os
 *  outros limiares deste arquivo — NÃO é uma decisão pedagógica definitiva
 *  dela, só um número técnico razoável escolhido para ser simples e
 *  explicável). Intervalo MÍNIMO, em dias corridos, entre a PRIMEIRA e a
 *  ÚLTIMA tentativa CONFIRMADA deste padrão, exigido para que um aluno que
 *  NUNCA errou (e portanto nunca tem `hasCorrectReview`) ainda assim prove
 *  "manutenção ao longo do tempo" por desempenho sustentado — ver
 *  `sustainedEvidenceWithoutReview` em `deriveProvisionalState` abaixo.
 *  Comparação é `>=` (fronteira inclusiva, mesma convenção dos demais
 *  limiares deste arquivo). */
export const MIN_MAINTENANCE_WINDOW_DAYS = 7;

export interface StateInput {
  /** Tentativas CONFIRMADAS (status = 'completed') para este padrão —
   *  nunca tentativas incompletas/abandonadas (seção 12: "tentativa
   *  incompleta nunca vira acerto/erro confirmado"). Contador BRUTO de
   *  volume de prática — repetir a mesma questão várias vezes incrementa
   *  este número normalmente (é volume, não diversidade). */
  confirmedAttempts: number;
  correctCount: number;
  /** Questões DISTINTAS (`COUNT(DISTINCT question_id)`) entre as
   *  tentativas confirmadas — responder a MESMA questão três vezes conta
   *  como 1 aqui, nunca como 3 (seção 1 da ordem: "tentativas repetidas na
   *  MESMA questão não contam para a diversidade"). Já garantido pela
   *  consulta SQL em studentMetricsRepository.ts, nunca recalculado aqui. */
  distinctQuestionsUsed: number;
  /** Dias-calendário DISTINTOS (`COUNT(DISTINCT date(completed_at))`) com
   *  ao menos uma tentativa confirmada deste padrão — exige evidência
   *  espalhada por mais de um momento/sessão (seção 1 da ordem: "evidência
   *  num único dia/sessão não é suficiente"). PROXY técnico por data, não
   *  uma sessão de navegador real — ver o comentário completo em
   *  `PatternEvidenceRow.distinctPracticeDays`. */
  distinctSessionDates: number;
  /** Verdadeiro quando existe pelo menos UMA revisão CORRETA
   *  (`error_review_events.result = 'correct'`) já registrada para este
   *  padrão (via `error_notebook_entries.primary_pattern_id`) — seção 1 da
   *  ordem v1.1. Uma revisão só pode existir depois de uma entrada do
   *  Caderno de Erros, que só pode existir depois de uma tentativa
   *  confirmada errada — logo, por construção, toda revisão correta já é
   *  necessariamente POSTERIOR à prática inicial; nenhuma checagem de
   *  ordem temporal adicional é necessária aqui.
   *
   *  v1.2 (correção PO, seção 1 da ordem desta rodada): deixou de ser,
   *  sozinho, o único caminho para `consistente_no_recorte` — agora é UM
   *  dos dois caminhos de `hasMaintenanceEvidence` (o outro é
   *  `sustainedEvidenceWithoutReview`, para quem nunca errou). Continua
   *  obrigatoriamente verdadeiro sempre que existe revisão correta — este
   *  campo em si não mudou de significado, só deixou de ser avaliado
   *  isolado em `deriveProvisionalState`. */
  hasCorrectReview: boolean;
  /** v1.2 (correção PO, seção 1 da ordem) — data/hora (`completed_at`) da
   *  PRIMEIRA tentativa CONFIRMADA deste padrão. Sempre um valor de DADO
   *  vindo do repositório (`PatternEvidenceRow.firstConfirmedAt`), nunca um
   *  relógio interno — `deriveProvisionalState` nunca chama
   *  `Date.now()`/`new Date()` sem argumento, mesmo princípio de
   *  `Clock`/`systemClock` já usado em `scheduleService.ts`. Junto com
   *  `lastConfirmedAt` abaixo, forma a base do intervalo de manutenção de
   *  `sustainedEvidenceWithoutReview`. `null` só quando não há nenhuma
   *  tentativa confirmada (nunca alcançável na prática nesta branch, que só
   *  roda com `confirmedAttempts >= MIN_CONFIRMED_FOR_DEVELOPMENT`, mas o
   *  tipo permanece nulável por honestidade com a origem real do dado). */
  firstConfirmedAt: string | null;
  /** v1.2 — data/hora da ÚLTIMA tentativa CONFIRMADA deste padrão — mesmo
   *  valor de `PatternEvidenceRow.lastPracticeAt` (reaproveitado pelo
   *  chamador, nunca uma segunda consulta redundante ao banco). */
  lastConfirmedAt: string | null;
  /** Quantas das tentativas confirmadas usaram ajuda (qualquer camada) —
   *  numerador da proporção de dependência de ajuda, comparado contra
   *  `confirmedAttempts` (denominador) internamente por esta função.
   *  Nunca o total bruto de eventos de ajuda (uma tentativa pode abrir
   *  várias camadas e ainda contar só 1 vez aqui). */
  attemptsWithHelp: number;
  /** Verdadeiro quando existe pelo menos uma entrada ATIVA (não arquivada,
   *  não corrigida) do Caderno de Erros deste padrão com
   *  `next_review_at <= agora` (calculado pelo chamador com o relógio
   *  injetado, nunca aqui). */
  hasOverdueActiveReview: boolean;
}

/** Deriva o estado provisório — SEMPRE a partir de contadores reais,
 *  nunca de uma fórmula de domínio. Ordem de avaliação (a primeira
 *  condição verdadeira decide, mutuamente exclusivas):
 *
 *    1) zero tentativas confirmadas → `sem_evidencias` (nunca "zero" como
 *       desempenho — seção 4: "ausência de evidência não pode virar nota
 *       zero" — este estado é sobre AUSÊNCIA, nunca sobre fracasso);
 *
 *    2) existe revisão ativa vencida → `revisao_pendente` (prioridade
 *       MÁXIMA sobre TODOS os demais critérios, incluindo os cinco novos
 *       abaixo — seção 1 da ordem v1.1: "revisão vencida continua tendo
 *       prioridade sobre tudo o mais" — é a ação mais imediata e
 *       acionável para o aluno, independente de quanta evidência/
 *       consistência já existe);
 *
 *    3) poucas tentativas confirmadas ainda (< `MIN_CONFIRMED_FOR_DEVELOPMENT`)
 *       → `evidencias_iniciais`;
 *
 *    4) TODOS os cinco critérios abaixo precisam valer AO MESMO TEMPO (E,
 *       nunca OU — seção 1 da ordem v1.1: "taxa de acerto sozinha nunca
 *       pode ser a única base do estado") para `consistente_no_recorte`:
 *         a) questões distintas ≥ `MIN_DISTINCT_QUESTIONS_FOR_CONSISTENT`
 *            (diversidade real, nunca a mesma questão repetida);
 *         b) dias de prática distintos ≥
 *            `MIN_DISTINCT_SESSIONS_FOR_CONSISTENT` (repetição em
 *            MOMENTOS diferentes, nunca só dentro de uma única sessão);
 *         c) taxa de acerto ≥ `MIN_CORRECT_RATE_FOR_CONSISTENT` (o dado
 *            descritivo de acerto, mantido, mas agora só UM entre cinco);
 *         d) `hasMaintenanceEvidence` verdadeiro — v1.2 (correção PO,
 *            seção 1 da ordem desta rodada): substituiu o antigo critério
 *            isolado `hasCorrectReview` por
 *            `hasCorrectReview OR sustainedEvidenceWithoutReview`, dois
 *            caminhos EQUIVALENTES de provar manutenção ao longo do tempo:
 *              - `hasCorrectReview` (caminho v1.1, inalterado): revisão
 *                espaçada CORRETA já comprovada — só existe para quem já
 *                errou este padrão alguma vez;
 *              - `sustainedEvidenceWithoutReview` (NOVO na v1.2): para quem
 *                NUNCA errou (e portanto nunca tem `hasCorrectReview`),
 *                desempenho sustentado por pelo menos
 *                `MIN_MAINTENANCE_WINDOW_DAYS` dias corridos entre a
 *                PRIMEIRA e a ÚLTIMA tentativa confirmada
 *                (`input.lastConfirmedAt - input.firstConfirmedAt`).
 *                Implementação NÃO-DUPLICATIVA de propósito: este sinal
 *                verifica SÓ o intervalo de dias — os outros quatro
 *                critērios (a, b, c, e) já são exigidos pelo `&&` do passo
 *                4 inteiro, então não são reavaliados de novo dentro de
 *                `sustainedEvidenceWithoutReview`; ele só "empresta" essa
 *                garantia do AND externo em vez de repetir a mesma
 *                expressão booleana duas vezes. Evidência concentrada num
 *                único dia ou em poucos dias (< 7 dias de intervalo) NUNCA
 *                é suficiente por este caminho, mesmo com os outros quatro
 *                critérios OK — é isso que a distingue de simplesmente
 *                reaproveitar o critério (b) (que já conta dias-calendário
 *                DISTINTOS, mas não exige que estejam espalhados por um
 *                INTERVALO mínimo real);
 *         e) proporção de tentativas com ajuda ≤
 *            `MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT` (alta dependência
 *            de ajuda bloqueia — o acerto não pode estar apoiado demais);
 *       → `consistente_no_recorte` — sempre "neste recorte" explicitamente,
 *       nunca "dominado" (seção 7 original: "nunca usar a palavra dominado
 *       como conclusão definitiva");
 *
 *    5) caso contrário (evidência suficiente para sair de
 *       `evidencias_iniciais`, mas algum dos cinco critérios de (4) ainda
 *       não vale — por exemplo, "correta mas sem revisão E sem 7 dias de
 *       intervalo", ou "correta mas só num único dia") → `em_desenvolvimento`.
 *
 *  LIMITAÇÃO CONHECIDA, documentada aqui de propósito (revista na v1.2 —
 *  ver o parágrafo "v1.2" no topo deste arquivo para o histórico completo
 *  da correção): a v1.1 deixava um padrão em que o aluno NUNCA errou preso
 *  para sempre em `em_desenvolvimento`, por mais prática distinta e
 *  multi-sessão que acumulasse — a v1.2 corrigiu isso estruturalmente com
 *  `sustainedEvidenceWithoutReview`. A limitação que PERMANECE, agora mais
 *  estreita: evidência concentrada em menos de `MIN_MAINTENANCE_WINDOW_DAYS`
 *  dias de intervalo continua insuficiente nos dois caminhos (com ou sem
 *  revisão) — isto é uma consequência DELIBERADA da ordem da PO, não um
 *  bug, mas o próprio limiar de 7 dias ainda é um número TÉCNICO
 *  provisório, pendente de validação pedagógica da Andréia (ver
 *  docs/METRICAS_MAPA_ENEM.md). */
export function deriveProvisionalState(input: StateInput): ProvisionalState {
  if (input.confirmedAttempts === 0) return "sem_evidencias";
  if (input.hasOverdueActiveReview) return "revisao_pendente";
  if (input.confirmedAttempts < MIN_CONFIRMED_FOR_DEVELOPMENT) return "evidencias_iniciais";

  const correctRate = input.correctCount / input.confirmedAttempts;
  const helpDependencyRatio = input.confirmedAttempts > 0 ? input.attemptsWithHelp / input.confirmedAttempts : 0;

  const hasEnoughDistinctQuestions = input.distinctQuestionsUsed >= MIN_DISTINCT_QUESTIONS_FOR_CONSISTENT;
  const hasEnoughDistinctSessions = input.distinctSessionDates >= MIN_DISTINCT_SESSIONS_FOR_CONSISTENT;
  const hasEnoughCorrectRate = correctRate >= MIN_CORRECT_RATE_FOR_CONSISTENT;
  const hasLowHelpDependency = helpDependencyRatio <= MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT;

  // v1.2 (correção PO, seção 1 da ordem desta rodada): intervalo real, em
  // dias corridos, entre a PRIMEIRA e a ÚLTIMA tentativa confirmada — só
  // aritmética sobre os dois valores de DADO recebidos (nunca um relógio
  // interno). `sustainedEvidenceWithoutReview` verifica SÓ este intervalo —
  // os outros quatro critérios (a, b, c, e) já são garantidos pelo `&&` do
  // `if` final abaixo, então nunca são reavaliados aqui de novo (ver o
  // comentário completo da função acima sobre por que isto não é lógica
  // duplicada).
  const maintenanceWindowDays =
    input.firstConfirmedAt && input.lastConfirmedAt
      ? (new Date(input.lastConfirmedAt).getTime() - new Date(input.firstConfirmedAt).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
  const sustainedEvidenceWithoutReview = maintenanceWindowDays >= MIN_MAINTENANCE_WINDOW_DAYS;
  const hasMaintenanceEvidence = input.hasCorrectReview || sustainedEvidenceWithoutReview;

  if (hasEnoughDistinctQuestions && hasEnoughDistinctSessions && hasEnoughCorrectRate && hasMaintenanceEvidence && hasLowHelpDependency) {
    return "consistente_no_recorte";
  }
  return "em_desenvolvimento";
}
