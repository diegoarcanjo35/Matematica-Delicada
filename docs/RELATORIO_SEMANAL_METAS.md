# Relatório Semanal e Metas Realistas — Sprint 13 v1.0

## Escopo e linguagem correta

Consolida evidências REAIS já produzidas pelas Sprints 3-12 (Cronograma,
Diagnóstico, Padrões ENEM, Banco de Questões, Player, Caderno de Erros/
revisão espaçada, Mapa ENEM, Treino Diário, Simulados em Blocos) numa leitura
semanal factual, mais um sub-recurso real de **metas semanais editáveis**.

Esta sprint **nunca** cria nota, TRI, ranking, pontuação de domínio,
medalhas, streaks, competição, previsão de aprovação ou qualquer fórmula
pedagógica definitiva. Toda comunicação ao aluno explica que os números são
**factuais** — contagens reais do que já foi praticado — nunca uma avaliação
do aluno. Linguagem avaliativa absoluta ("fraco", "excelente", "atrasado",
"dominado") nunca aparece; comparações usam só diferenças numéricas
("2 questões a mais", "1 dia adicional com atividade").

## Arquitetura

Duas metades, mesma separação em toda a base de código:

- **Relatório** — 100% derivado em leitura sobre as tabelas de evidência já
  existentes (`question_attempts`, `error_notebook_entries`,
  `error_review_events`, `daily_training_events`, `simulation_block_events`,
  `schedule_activity_events`). Nenhuma tabela nova de relatório/snapshot é
  criada — recalculado a cada leitura.
- **Metas** — três tabelas novas (`weekly_study_goals`,
  `weekly_goal_patterns`, `weekly_goal_events`), com o mesmo mecanismo de
  atomicidade/idempotência por identidade de `mutationId` já comprovado nas
  Sprints 11/12 (Treino Diário, Simulados em Blocos).

Arquivos principais:

- `worker/src/lib/scheduleValidation.ts` — estendido com
  `mondayOfCivilWeek`, `civilMidnightInstant`, `toSqliteInstant`,
  `parseSqliteInstant` (semântica temporal da semana civil, seção
  "Semântica temporal" abaixo). Reaproveitado, nunca duplicado, por
  qualquer outro serviço que precise de fronteira de semana no futuro.
- `worker/src/lib/weeklyGoalRules.ts` — algoritmo puro da sugestão de meta
  (`suggestWeeklyMinutes`/`suggestWeeklyQuestions`/`selectSuggestedPatterns`),
  limites técnicos centralizados, cálculo de progresso
  (`computeGoalProgressPercents`) e validação de entrada. Nenhum acesso a
  banco/relógio real.
- `worker/src/repositories/weeklyReviewRepository.ts` — leitura factual do
  relatório (uma função por fonte de evidência) + escrita parametrizada das
  três tabelas de meta.
- `worker/src/services/weeklyReviewService.ts` — orquestra: agregação por
  semana (`computeWeekAggregate`, reaproveitada para a semana selecionada E
  a anterior, nunca duas implementações), comparação responsável, preview
  da meta, apply/patch/complete/abandon atômicos e idempotentes.
- `worker/src/routes/weeklyReview.ts` — os 8 endpoints, sessão/ownership/
  auditoria.
- `src/pages/weeklyReview/WeeklyReviewPage.tsx` — a tela
  `/relatorio-semanal` (relatório, comparação, meta em todos os estados).
- `src/api/weeklyReviewClient.ts` — cliente tipado, mesmo padrão de
  `simulationsClient.ts`.
- Card **"Sua semana"** em `src/pages/DashboardPage.tsx` — resumo factual +
  link, nunca cria nada.

## Schema (`migrations/0018_weekly_reviews_goals.sql`)

Puramente aditiva sobre 0001-0017 — nenhuma migration anterior é editada.
A Sprint 14 deve começar sua própria migration em `0019`.

### `weekly_study_goals`

Uma linha por meta semanal EXPLICITAMENTE aplicada (nunca uma prévia — não
existe tabela de prévia; o preview é 100% recomputado em leitura, mesma
decisão do Treino Diário/Sprint 11). `week_start` é a segunda-feira civil da
semana-alvo, no fuso do aluno NO MOMENTO DO APPLY; `timezone` e
`available_days` (coluna adicional além do mínimo da ordem, mesmo precedente
de campos extras já usado em sprints anteriores) são carimbados pelo mesmo
motivo que `simulation_blocks.timezone`/`block_date`: uma meta já aplicada
nunca muda de semana/disponibilidade retroativamente se o aluno trocar de
fuso ou editar o onboarding depois. `status` fechado
(`active`/`completed`/`abandoned`); índice único PARCIAL
`(user_id, week_start) WHERE status = 'active'` garante no banco no máximo
uma meta ativa por aluno e semana — um aluno PODE ter metas ativas para
semanas diferentes ao mesmo tempo, nunca duas para a mesma semana.

### `weekly_goal_patterns`

Até 3 padrões prioritários por meta. `priority_position` restrito a `1..3`
pelo CHECK; índices únicos `(goal_id, pattern_id)` e
`(goal_id, priority_position)` impedem padrão duplicado e posição
duplicada — o limite de 3 padrões por meta é garantido por CONSTRUÇÃO do
índice de posição (só existem 3 valores válidos), sem precisar de uma
coluna de contagem redundante.

### `weekly_goal_events`

Append-only; `event_type` fechado em `goal_created`, `goal_updated`,
`goal_completed`, `goal_abandoned`. Nunca grava resposta livre, nota do
aluno ou conteúdo sensível — só fatos técnicos (tipo, semana, versão,
grupos alterados).

### Atomicidade real

Mesmo mecanismo "marcador incondicional + `RAISE(ABORT)` por identidade,
ANTES do commit" já comprovado nas migrations 0009-0017: cada `INSERT` em
`weekly_goal_events` usa como seu próprio `id` o `mutationId` já gravado em
`weekly_study_goals.last_mutation_id` pelo `UPDATE`/`INSERT` pareado no
MESMO lote; um trigger `AFTER INSERT` exige que a meta esteja, NAQUELE
INSTANTE, com essa identidade E a versão resultante correta — se o núcleo
não mudou de verdade (ex.: guard de versão falhou), a identidade não bate e
a transação INTEIRA reverte, incluindo qualquer troca de padrões já
executada antes do evento no mesmo lote (prova direta em
`worker/testing/weeklyReviewAtomicity.test.ts`).

## Semântica temporal

- Semana civil segunda-feira a domingo (`mondayOfCivilWeek`).
- Sempre o fuso SALVO do aluno (`schedule_preferences.timezone`,
  reaproveitado de `scheduleService.getTimezone` — nunca uma segunda leitura
  de fuso).
- Relógio SEMPRE injetável (`Clock`/`systemClock`, mesmo de
  `scheduleService.ts`) — nenhuma regra chama `new Date()`/`Date.now()`
  diretamente.
- `civilMidnightInstant(civilDate, timezone)` resolve o instante UTC real da
  meia-noite local de uma data civil, com DUAS passadas de correção de
  offset (mesma técnica de bibliotecas como `date-fns-tz`) — cobre fuso
  positivo, negativo e transição de horário de verão.
- As janelas de agregação usam `toSqliteInstant`/`parseSqliteInstant`
  (formato textual IDÊNTICO ao `datetime('now')` do SQLite/D1 —
  `YYYY-MM-DD HH:MM:SS`, nunca ISO 8601 puro com `T`/`Z`, cuja comparação
  lexicográfica quebraria fronteiras exatas de data).
- Testado explicitamente: fronteira domingo→segunda, timestamp a poucos
  segundos da meia-noite, fuso positivo (`Asia/Tokyo`) e negativo
  (`America/Sao_Paulo`), transição de horário de verão
  (`America/New_York`), e relógio sintético independente da data real da
  máquina — ver `worker/testing/weeklyReviewRules.test.ts`.

## Fontes factuais de cada métrica

| Métrica | Fonte real | Observação |
|---|---|---|
| Minutos aproximados | `question_attempts.completed_at - started_at` (prática comum + revisão, somados) | Relógio de parede, não tempo focado — mesma limitação de `studentMetricsRepository.ts` |
| Questões confirmadas / distintas | `question_attempts` confirmadas (`status='completed'`) | Prática comum e revisão contadas separadamente na maioria dos números, somadas só em "questões confirmadas" total (base da meta) |
| Acertos / erros (prática comum) | `question_attempts.is_correct`, excluindo revisão (`error_entry_id IS NULL`) | Nunca inclui revisão — seção 12.1: "revisão separada de erro comum" |
| Revisões concluídas / corretas / incorretas | `error_review_events` | Sempre separado da prática comum |
| Padrões praticados | `question_patterns` (papel `principal` **e** `secundario`) das tentativas confirmadas | Comum + revisão combinados (é "o que foi praticado", não um contador de acerto). PO v1.1 (correção B): inclui padrões secundários, diferente da convenção só-principal do Mapa ENEM (Sprint 10) — este relatório responde "o que o aluno tocou", não "de qual padrão há evidência de domínio pedagógico"; nunca infla `confirmedQuestionsCount`/`correctCount`/etc., que nunca fazem JOIN com `question_patterns` |
| Camadas de ajuda abertas | `question_help_events` | Contagem bruta de eventos |
| Itens do Treino Diário concluídos | `daily_training_events` (`item_completed`) | Evento, não status atual — histórico estável |
| Blocos de Simulado concluídos | `simulation_block_events` (`block_completed`) | Idem |
| Cronograma concluído/reagendado | `schedule_activity_events` (`to_status IN ('completed','rescheduled')`) | Idem |
| Entradas criadas no Caderno de Erros | `error_notebook_entries.created_at` | Só criação, não reativação |
| Revisões vencidas ao fim da semana | `error_notebook_entries` (`status='scheduled' AND next_review_at <= agora`) | Ver limitação abaixo — só disponível para a semana corrente |
| Dias com evidência real | União de 5 fontes de instante, convertida para data civil no fuso do aluno | Nunca um proxy de "dia de calendário do servidor" |

### Ausência de evidência ≠ zero

`approxMinutes` é `null` (nunca `0`) quando não há nenhuma tentativa
confirmada na semana. Todas as demais contagens (questões, revisões, itens
etc.) são honestamente `0` quando não há evidência real — `0` é o valor
FACTUAL correto para uma contagem sem ocorrências, nunca uma nota ou
julgamento. Quando `hasAnyEvidence` é `false`, a tela mostra explicitamente
"Ainda não há evidências suficientes nesta semana", nunca uma tabela de
zeros sem contexto.

### Tempos aproximados

Todo tempo é rotulado "aproximadamente" na interface — é sempre derivado de
`completed_at - started_at` de tentativas reais, nunca uma medição de foco
real (uma aba deixada aberta infla o número, mesma ressalva documentada em
`docs/METRICAS_MAPA_ENEM.md`).

## Comparação responsável

`comparison.available` só é `true` quando AMBAS as semanas (selecionada e
anterior) têm `hasAnyEvidence = true`. Quando disponível, `deltas` traz só
diferenças numéricas assinadas (questões confirmadas, acertos, erros, dias
com evidência, minutos) — a interface renderiza frases como "2 questões a
mais"/"1 dia a menos", nunca "melhor"/"pior". `overdueReviewsAtWeekEnd`
está **deliberadamente fora** da comparação — ver limitação abaixo.

## Algoritmo provisório do preview (seção 8 da ordem)

Centralizado em `worker/src/lib/weeklyGoalRules.ts`, todos os limites
documentados como técnicos/provisórios, nunca pedagógicos definitivos:

- **Minutos sugeridos**: capacidade semanal declarada no onboarding
  (`dailyMinutes × quantidade de dias disponíveis`) quando existir, sempre
  respeitando o teto — nunca sugere mais que a capacidade real. Sem
  disponibilidade declarada, usa um fallback conservador
  (`CONSERVATIVE_DEFAULT_WEEKLY_MINUTES = 150`), sempre editável.
- **Questões sugeridas**: minutos sugeridos ÷ uma estimativa técnica de
  minutos por questão (`AVG_MINUTES_PER_QUESTION = 3`).
- **Padrões sugeridos** (até `MAX_GOAL_PATTERNS = 3`): três níveis de
  urgência, nesta ordem — (1) revisão vencida ativa no Caderno de Erros,
  (2) pendência ativa no Caderno de Erros ainda não vencida, (3) padrão em
  "em desenvolvimento" (reaproveita `deriveProvisionalState`,
  `studentMetricsRules.ts`, Sprint 10 — nunca uma segunda fórmula).
  Desempate determinístico: urgência → atividade mais recente → código do
  padrão. Nunca `ORDER BY RANDOM()`.
- Limites técnicos: `MIN/MAX_WEEKLY_TARGET_MINUTES` (30–1500),
  `MIN/MAX_WEEKLY_TARGET_QUESTIONS` (1–500) — cobertos por teste de
  fronteira em `worker/testing/weeklyReviewRules.test.ts`.
- O preview NUNCA escreve (GET puro, recomputado a cada chamada) e nunca
  cria cronograma, lista diária ou simulado automaticamente.

## Progresso factual da meta (seção 4.4 da ordem)

Calculado por LEITURA das evidências reais da semana da própria meta —
nunca persistido (`computeGoalProgressPercents`, recalculado a cada
resposta). `minutesDone`/`questionsDone` são `null` quando não há evidência
confirmada nessa semana — o percentual correspondente também fica `null`
(nunca `0%` fabricado). Como `target_minutes`/`target_questions` são sempre
`> 0` por CHECK do banco, o único caso de denominador problemático é
evidência ausente, nunca divisão por zero. Nenhum progresso vira nota, nível
ou julgamento — só minutos/questões/padrões/dias, lado a lado com o
pretendido.

## Endpoints e autorização

8 endpoints (seção 7 da ordem), todos exigindo sessão válida,
`user_id` sempre derivado da sessão e escopado no SQL, 404 idêntico para
recurso inexistente/de outro aluno, 405 para método inválido:

| Método | Rota | Efeito |
|---|---|---|
| GET | `/api/weekly-review/current` | Relatório da semana corrente |
| GET | `/api/weekly-review/history` | Semanas disponíveis para seleção |
| GET | `/api/weekly-review/:weekStart` | Relatório de uma semana específica |
| GET | `/api/weekly-goals/preview?weekStart=` | Sugestão de meta (leitura pura) |
| POST | `/api/weekly-goals/apply` | Cria a meta explicitamente |
| PATCH | `/api/weekly-goals/:goalId` | Atualização parcial |
| POST | `/api/weekly-goals/:goalId/complete` | Conclui |
| POST | `/api/weekly-goals/:goalId/abandon` | Abandona |

## Atomicidade, idempotência e concorrência (seção 9 da ordem)

Mesmo padrão comprovado em `simulationsService.ts`/`dailyTrainingService.ts`
(Sprints 11/12) — `mutationId` explícito é a ÚNICA identidade que decide
retry vs. conflito, NUNCA igualdade de conteúdo:

- mesma identidade + mesmo conteúdo → idempotente, `changed: false`, sem
  nova escrita;
- mesma identidade + conteúdo diferente → 409 controlado (essa identidade
  já significa outra coisa);
- identidade diferente enquanto já existe meta ativa/versão obsoleta →
  conflito de domínio explícito (`activeElsewhere`/`conflict`), nunca
  disfarçado de sucesso;
- núcleo + padrões + evento sempre no MESMO `db.batch()`; uma falha forçada
  em QUALQUER statement reverte tudo (provado com `FakeD1Database` real,
  nunca só `meta.changes` checado em JS depois do commit);
- TOCTOU real de `mutationId` (duas mutações verdadeiramente concorrentes)
  é arbitrado pela PK global de `weekly_goal_events.id`, capturada em
  `catch`, nunca só pelo pre-check em JS (`weeklyGoalEventIdInUse`, que só
  cobre a corrida sequencial) — prova com a "porta" determinística
  `pauseReadsMatching` do `FakeD1Database`.
- PATCH parcial troca a coleção de padrões com limpeza EXPLÍCITA
  (`DELETE` incondicional + `INSERT`s incondicionais) protegida pelo mesmo
  trigger de identidade — se o `UPDATE` do núcleo não aplicar de verdade
  (versão obsoleta), a identidade do evento não bate e a transação inteira
  reverte, incluindo a troca de padrões.

## Privacidade e auditoria (seção 10 da ordem)

`audit_log` só recebe `weekly_goal_created`, `weekly_goal_updated`,
`weekly_goal_completed`, `weekly_goal_abandoned` — só quando `changed ===
true` (retry idempotente nunca duplica auditoria). Metadados só técnicos
(`goalId`) — nunca minutos/questões/padrões escolhidos, nunca conteúdo do
relatório. Leitura do relatório e do preview NUNCA audita. Nenhuma tabela
nova grava resposta livre, anotação ou token.

## Limitações e decisões pendentes da Andreia/PO

1. **`overdueReviewsAtWeekEnd` só existe para a semana corrente.** O schema
   não tem uma tabela de histórico do campo `next_review_at` — reconstruir
   com exatidão "quantas revisões estavam vencidas no FIM de uma semana já
   encerrada" não é possível sem inventar uma tabela de snapshot, que a
   ordem explicitamente não pede (seção 6: "o relatório permanece derivado
   em leitura"). Decisão desta rodada: expor esse número só quando a semana
   contém "hoje" (rotulado "até o momento", nunca uma fronteira exata de
   semana), `null` para semanas passadas, e EXCLUÍDO da comparação
   semana-a-semana por esse motivo — o exemplo "menos revisões vencidas" da
   seção 4.2 da ordem não pôde ser implementado com precisão histórica
   real; pendente de decisão da Andreia se vale a pena uma tabela de
   snapshot numa sprint futura.
2. **Estimativa de minutos por questão da sugestão de meta
   (`AVG_MINUTES_PER_QUESTION = 3`)** é um número técnico, não validado
   pedagogicamente.
3. **Limites técnicos de minutos/questões da meta** (30–1500 min,
   1–500 questões) são pisos/tetos de digitação razoáveis, não uma
   recomendação pedagógica.
4. **Sugestão de padrões prioritários** reaproveita o estado provisório do
   Mapa ENEM (Sprint 10) — herda as mesmas limitações já documentadas em
   `docs/METRICAS_MAPA_ENEM.md` (ex.: "dia de prática" é um proxy por
   data-calendário, não uma sessão real).
5. **Histórico de semanas selecionáveis** limitado a 12 semanas de
   retrocesso (`HISTORY_LOOKBACK_WEEKS`) — constante técnica, ajustável sem
   migration.

## Confirmações finais

- Nenhuma nota, TRI, ranking, pontuação de domínio, medalha, streak,
  competição, previsão de aprovação ou fórmula pedagógica definitiva é
  calculada nesta sprint — só contagens factuais e diferenças numéricas.
- A Sprint 14 deve começar sua própria migration em `migrations/0019` —
  `0018_weekly_reviews_goals.sql` é a última migration desta sprint, nunca
  editada por sprints futuras.
