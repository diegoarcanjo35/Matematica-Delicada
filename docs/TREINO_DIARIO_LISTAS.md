# Treino Diário Real e Listas Adaptativas — Sprint 11 v1.0

## Escopo desta entrega

Substitui o placeholder de `/treino-diario` por uma experiência real,
montada exclusivamente a partir de dados já existentes: cronograma e
disponibilidade do aluno (Sprint 5), questões publicadas e padrões (Sprints
6-7), Player de Questão (Sprint 8), Caderno de Erros e revisão espaçada
(Sprint 9), e o Mapa ENEM/regras de estado provisório por padrão (Sprint
10). Este documento cobre: migration `0016`, o algoritmo adaptativo
provisório, preview × apply, capacidade, integração com o Player, estados/
transições, atomicidade/idempotência, os 9 endpoints, auditoria,
privacidade, limitações, decisões pendentes da Andréia/PO e a política de
testes usada nesta rodada.

Esta sprint **não** implementa simulados, TRI, professor, turmas, ranking,
notas ou fórmulas definitivas de domínio — nem aqui, nem em nenhum módulo
reaproveitado.

## Arquitetura

Camada de **orquestração** sobre tabelas já existentes — nenhuma questão,
padrão, tentativa ou entrada do Caderno é copiada ou duplicada:

- `worker/src/lib/dailyTrainingRules.ts` — algoritmo puro de seleção
  (`selectDailyTrainingItems`), constantes provisórias e mapa
  razão→origem. Nenhum acesso a banco/relógio real.
- `worker/src/repositories/dailyTrainingRepository.ts` — leitura/escrita
  parametrizada das três tabelas novas + consultas de candidatos (revisão
  vencida via `error_notebook_entries`, compromisso do dia via
  `schedule_activity_assignments`, questão treinável via `questions`/
  `question_patterns`).
- `worker/src/services/dailyTrainingService.ts` — orquestra: monta os
  candidatos (`buildCandidates`, reaproveitada por `preview` e `applyList`,
  nunca duas implementações), aplica o algoritmo, persiste atomicamente,
  integra com o Player (`playerService.ts`, sem duplicar), calcula o
  resumo factual.
- `worker/src/routes/dailyTraining.ts` — os 9 endpoints, sessão/ownership/
  auditoria.
- `src/pages/dailyTraining/DailyTrainingPage.tsx` — a tela `/treino-diario`
  real, com os 11 estados mínimos.
- `src/api/dailyTrainingClient.ts` — cliente tipado, mesmo padrão de
  `errorNotebookClient.ts`.

## Schema (`migrations/0016_daily_training_lists.sql`)

Puramente aditiva sobre 0001-0015 — nenhuma migration anterior é editada.

### `daily_training_lists`

Uma linha por (aluno, data local) efetivamente **aplicada** (nunca uma
prévia — não existe tabela de prévia nesta sprint, diferente do
cronograma/Sprint 5; ver "Preview × apply" abaixo). `training_date` é a
data civil (YYYY-MM-DD) no fuso do aluno no momento do apply, carimbada
junto com `timezone` — uma lista já aplicada nunca muda de "dia"
retroativamente se o aluno trocar de fuso depois.

Índice único **parcial** `idx_daily_training_lists_one_active_per_day` em
`(user_id, training_date) WHERE status = 'active'` — garante no banco, não
só em JS, no máximo uma lista `active` por aluno e dia.

### `daily_training_items`

Um item por questão selecionada. `origin` (5 valores, seção 5 da ordem) e
`reason` (6 valores, um por camada de prioridade da seção 7) são campos
**separados**: `reason` é a explicação técnica granular mostrada ao aluno
("Por que este item?"); `origin` é a categoria ampla exigida pela ordem.
Mapa fixo `REASON_TO_ORIGIN` centralizado em `dailyTrainingRules.ts`.

`scheduled_review` é um valor **legal** do CHECK de `origin` (fidelidade à
seção 5 da ordem), mas nenhum caminho de código desta sprint o escreve —
mesmo precedente já documentado para `'overdue'` em
`migrations/0006_adaptive_schedule_foundation.sql` (ver
`scheduleValidation.ts`): reservado para uma futura extensão (revisão
ainda não vencida, incorporada preventivamente), sem fechar a porta a essa
evolução com uma migration nova.

Índices únicos: `(list_id, question_id)` (nenhuma questão repetida na
lista — seção 7), `(list_id, position)` (ordem determinística), e
`question_attempt_id WHERE NOT NULL` (no máximo um item associado à mesma
tentativa do Player).

Duas colunas **além do mínimo** da seção 5, deliberadamente:
- `error_entry_id` — liga um item `overdue_review` à entrada real do
  Caderno de Erros, permitindo reaproveitar
  `startOrResumeReviewAttempt`/`selectSimilarQuestion` (Sprint 9) sem
  duplicar lógica de seleção de questão semelhante.
- `source_schedule_assignment_id` — liga um item `schedule_commitment` à
  atribuição real do cronograma, usado pelo touch-point da seção 13.

### `daily_training_events`

Histórico append-only de mutações **reais**. Nunca armazena texto livre
pedagógico nem resposta do aluno. `item_id` é nulo para os três eventos de
nível de lista e obrigatório para os quatro de nível de item — reforçado
por um trigger, nunca só por convenção.

### Atomicidade por identidade (trigger consolidado)

Mesma classe de mecanismo "marcador incondicional + `RAISE(ABORT)` por
identidade, antes do commit" já comprovada nas migrations 0009-0014 (Banco
de Questões, Player, Caderno de Erros). Um único trigger,
`trg_daily_training_events_require_identity`, cobre três exigências:

1. eventos de lista exigem `daily_training_lists.last_mutation_id = NEW.id`;
2. `list_created` exige **adicionalmente** que `item_count` já bata com a
   contagem real de linhas em `daily_training_items` para aquela lista —
   prova, antes do commit, que "a lista existe" e "todos os itens foram
   persistidos" são sempre o mesmo fato;
3. eventos de item exigem `daily_training_items.last_mutation_id = NEW.id`,
   **e** que o item pertença à mesma lista/usuário do evento (nunca só a
   mesma identidade de mutação por coincidência).

Provado diretamente contra o SQL real em `worker/testing/migration0016.test.ts`
e contra falhas forçadas/corridas em `worker/testing/dailyTrainingAtomicity.test.ts`.

## Preview × apply

`GET /api/daily-training/preview` é **100% somente leitura** —
`dailyTrainingService.preview()` nunca chama `db.batch()`, nunca grava
nada. Diferente do cronograma (Sprint 5), esta sprint **não** persiste
nenhuma tabela de prévia: o cálculo (`buildCandidates` + `selectDailyTrainingItems`)
é barato e 100% determinístico para o mesmo estado do banco e o mesmo
relógio, então `POST /apply` simplesmente **recomputa o mesmo cálculo**
antes de persistir — nunca reaproveita um token de prévia armazenado. Isso
elimina uma classe inteira de bugs de "prévia desatualizada" (que o
cronograma precisa tratar via `input_snapshot`) às custas de uma leitura
extra a cada apply — aceitável no volume desta fase do projeto.

`POST /apply`:
- exige `mutationId`;
- se já existe uma lista `active` para hoje (desta chamada ou de uma
  corrida concorrente), devolve ela — nunca cria uma segunda;
- se a seleção resultar em zero itens, devolve `{ok:true, empty:true}` e
  **não escreve nada** (seção 8: "nenhuma lista vazia é persistida");
- senão, persiste lista + itens + evento `list_created` num único
  `db.batch()`.

## Algoritmo adaptativo provisório (`worker/src/lib/dailyTrainingRules.ts`)

**Nada aqui é uma fórmula pedagógica definitiva** — pesos, limites e a
ordem de prioridade são técnicos e provisórios, pendentes de validação
pedagógica da Andréia, exatamente como `spacedReview.ts` (Sprint 9) e
`studentMetricsRules.ts` (Sprint 10).

### Ordem de prioridade (seção 7 da ordem)

1. `overdue_review` — revisões vencidas ativas (`error_notebook_entries`,
   `status='scheduled' AND next_review_at <= agora`); questão escolhida
   por `selectSimilarQuestion` (Sprint 9), reaproveitada, nunca duplicada;
2. `schedule_commitment` — compromisso de "treino de questões" do
   cronograma para hoje; como `schedule_activities` não referencia uma
   questão/padrão específico (Sprint 5, "sem FK inventada"), o item
   concreto vem do mesmo pool das camadas 3-6 (nesta ordem interna), só
   com `reason`/`origin` diferentes;
3. `pattern_in_development` — padrões no estado `em_desenvolvimento`
   (Sprint 10, `deriveProvisionalState`);
4. `pattern_initial_evidence` — padrões em `evidencias_iniciais`;
5. `pattern_maintenance` — padrões `consistente_no_recorte`;
6. `pattern_exploration` — padrões `sem_evidencias`, só se houver
   capacidade restante.

Padrões no estado `revisao_pendente` (Sprint 10) ficam de fora das camadas
3-6 — já cobertos diretamente pela camada 1, via `error_notebook_entries`
(evita contar a mesma revisão duas vezes).

### Constantes centralizadas

| Constante | Valor | Papel |
|---|---:|---|
| `FALLBACK_ITEM_MINUTES` | 4 | duração quando `tempo_estimado_segundos` é nulo/inválido |
| `MAX_DAILY_TRAINING_ITEMS` | 10 | limite absoluto de itens, mesmo com capacidade sobrando |
| `MAX_SAME_PATTERN_RATIO` | 0.4 | proporção máxima de itens do mesmo padrão |

### Restrições, em ordem de avaliação (`selectDailyTrainingItems`)

1. nenhuma questão repetida (garantia adicional em JS — o banco também
   garante via índice único);
2. a lista nunca excede `availableMinutes` — item que não cabe fica de
   fora **inteiramente**, nunca parcial;
3. nunca mais que `maxItems`;
4. concentração por padrão limitada a `MAX_SAME_PATTERN_RATIO` do total —
   **relaxada automaticamente** só quando existe um único padrão distinto
   em toda a base de candidatos (não há o que diversificar). Importante:
   um candidato barrado pelo cap é descartado **definitivamente** — nunca
   existe uma segunda passagem que o readiciona depois; isso foi
   corrigido durante o desenvolvimento desta sprint depois de um teste
   direcionado (`selectDailyTrainingItems`, "concentração por padrão")
   pegar exatamente essa regressão (ver `worker/testing/dailyTrainingAlgorithm.test.ts`).

`availableMinutes <= 0` devolve lista vazia sem examinar nada — preview
vazio honesto.

### Reoferecer questão recém-concluída

`listRecentlyCompletedQuestionIds` (3 dias) é consultada antes de escolher
a questão de cada padrão candidato; `pickQuestion` prefere uma questão NÃO
recém-concluída, mas cai para a única disponível se não houver
alternativa — nunca deixa o padrão sem candidata só por causa disso.

## Capacidade e timezone

- minutos disponíveis vêm do onboarding (`student_profiles.daily_minutes`)
  **e** exigem que o dia da semana de hoje esteja em `available_days` —
  caso contrário, `availableMinutes = 0` (indisponibilidade honesta, nunca
  um erro);
- duração de cada item = `Math.ceil(tempo_estimado_segundos / 60)`, mínimo
  1 min, fallback `FALLBACK_ITEM_MINUTES` quando ausente;
- data civil calculada com `civilDateInTimezone` (Sprint 5,
  `scheduleValidation.ts`) sobre um relógio **injetável**
  (`Clock`/`systemClock`, reaproveitado de `scheduleService.ts` — nenhum
  novo tipo de relógio) — nunca `new Date()` direto;
- duração é sempre apresentada como "aproximadamente" (seção 8), nunca uma
  medição exata.

## Integração com o Player

**Nenhum segundo Player** — `dailyTrainingService.startItem` chama
diretamente `playerService.startOrResumeAttempt`
(itens `development`/`consistency`/`schedule_commitment`, camada 2-6) ou
`playerService.startOrResumeReviewAttempt` (itens `overdue_review`, camada
1) — os MESMOS serviços já usados pelo Player (Sprint 8) e pelo Caderno de
Erros (Sprint 9). A associação `question_attempt_id` ao item acontece num
UPDATE guardado por identidade+versão+`status='pending'`: se ele afetar 0
linhas, nada foi escrito — "reverter" é trivial por construção (seção 15).

`syncItem` lê a tentativa REAL (`playerRepository.findAttemptByIdForUser`)
— só uma tentativa `completed` conclui o item; resposta não confirmada
devolve `changed:false` honestamente, nunca um erro. Erro confirmado
continua alimentando o Caderno de Erros pela regra já existente
(`playerService.confirmAnswer`, Sprint 9) — o treino diário não interfere
nesse caminho, só lê o resultado depois.

Quando a questão/entrada de revisão de um item deixa de estar disponível
no momento do `start` (edge case — apply já filtra por publicado, mas o
estado pode mudar entre apply e start), o item transiciona para `blocked`
(guardado, com evento `item_blocked`) em vez de falhar sem explicação —
prova direta de "falha ao associar tentativa reverte o estado do item"
(seção 15), já que o núcleo nunca fica `in_progress` sem uma tentativa
real associada.

## Estados e transições

### Lista

`active` → `completed` (todos os itens terminais) | `abandoned` (a
qualquer momento enquanto `active`). Terminais, nunca voltam.

### Item

`pending` → `in_progress` (start) → `completed` (sync com tentativa
`completed`) | `skipped` (skip) | `blocked` (questão/revisão indisponível
no start). `pending` → `skipped` também é permitido (pular sem nunca ter
começado). Terminais: `completed`, `skipped`, `blocked`.

### Frontend (`DailyTrainingPage.tsx`), 11 estados mínimos

`loading` → (`unavailable` | `no_availability` | `empty` | `preview`) →
`applying` → `active` (com sub-estados por item: pendente/em andamento/
progresso salvo) → `completed` | `abandoned`, mais `error` (recuperável,
com botão "Tentar novamente") em qualquer ponto de falha de rede.

## Atomicidade, idempotência e concorrência (seção 15 da ordem)

Provado diretamente no banco em `worker/testing/dailyTrainingAtomicity.test.ts`
e `worker/testing/migration0016.test.ts`:

- **apply falha integralmente se qualquer item falhar** — um único
  `db.batch()` (lista + todos os itens + evento); qualquer erro (ex.:
  violação de índice único de questão duplicada) reverte a transação
  inteira;
- **retry do mesmo mutationId não duplica** — apply: lista já `active`
  para o dia é devolvida, nunca recriada; item: guard de identidade
  (`last_mutation_id`) mais o guard de status evita reprocessar;
- **colisão de mutationId retorna conflito controlado** — reaproveitar um
  mutationId já usado para outra mutação real (nunca um retry legítimo do
  mesmo resultado) é detectado e devolve 409, provado em teste direto;
- **dois applies simultâneos criam exatamente uma lista ativa** — índice
  único parcial + `catch` que relê e devolve a vencedora;
- **start simultâneo cria/associa exatamente uma tentativa** — idempotência
  de `startOrResumeAttempt` (Sprint 8) + guard de identidade do item;
- **falha ao associar tentativa reverte o estado do item** — guard de
  status `'pending'` no UPDATE: 0 linhas afetadas nunca deixa estado
  parcial;
- **sync concorrente conclui item/evento/auditoria uma vez** — mesmo
  mecanismo de identidade;
- **complete não conclui lista com item não terminal** — a própria
  condição `NOT EXISTS (... status NOT IN (terminal))` vive no `WHERE` do
  UPDATE guardado (`buildCompleteListStatement`) — aborta antes do commit
  por construção, nunca uma checagem em JS separada da escrita real;
- **falha de histórico obrigatório reverte a mutação correspondente** —
  `db.failNextMatching(/INSERT INTO daily_training_events/)` provado
  revertendo tanto o `apply` quanto o `start`;
- **nenhum sucesso HTTP é devolvido após persistência parcial** — toda
  rota só responde `ok:true` depois que `db.batch()` retornou com sucesso.

## Endpoints (seção 9 da ordem)

| Método | Rota | Mutação | Auditoria |
|---|---|:-:|---|
| GET | `/api/daily-training/preview` | não | nunca |
| POST | `/api/daily-training/apply` | sim | `daily_training_applied` |
| GET | `/api/daily-training/current` | não | nunca |
| GET | `/api/daily-training/:listId` | não | nunca |
| POST | `/api/daily-training/:listId/items/:itemId/start` | sim | `daily_training_item_started` |
| POST | `/api/daily-training/:listId/items/:itemId/sync` | condicional | `daily_training_item_completed` (só quando conclui) |
| POST | `/api/daily-training/:listId/items/:itemId/skip` | sim | `daily_training_item_skipped` |
| POST | `/api/daily-training/:listId/complete` | sim | `daily_training_completed` |
| POST | `/api/daily-training/:listId/abandon` | sim | `daily_training_abandoned` |

Sessão obrigatória (401 sem sessão); `user_id` sempre derivado da sessão;
recurso de outro aluno (lista OU item) sempre 404, nunca 403; métodos
inválidos 405; toda mutação exige `mutationId`; auditoria só quando
`changed === true`.

## Segurança, privacidade e auditoria

- isolamento completo por aluno em todo SQL (`user_id = ?` sempre no
  `WHERE`, nunca só na aplicação);
- nenhum `user_id` externo aceito — sempre derivado da sessão;
- nenhum texto livre em URL, log, evento ou auditoria — `skip_reason` é um
  enum técnico fechado (`not_now`, `too_hard`, `already_know`,
  `out_of_time`), nunca texto livre;
- nenhum token, resposta marcada ou comentário no histórico do treino —
  `daily_training_events` só guarda tipo/lista/item/quando;
- gate de disponibilidade reaproveita `isLocalEditorialFixturesAllowed`
  (mesmo gate do Player/Caderno de Erros/Mapa ENEM — o treino diário
  depende do mesmo conteúdo técnico de questões/padrões publicados, nunca
  um gate novo).

## Touch-points mínimos (seção 13 da ordem)

- **Dashboard** (`DashboardPage.tsx`) — novo card "Treino Diário": mostra
  a lista ativa (progresso `X de Y`) ou o preview disponível
  (`itemCount`/`estimatedMinutes`), com CTA para `/treino-diario`. Duas
  leituras GET puras (`fetchCurrent`, `fetchPreview`) — nenhuma cria nada.
- **Cronograma** (`SchedulePage.tsx`) — atribuições da visão "hoje" ganham
  `inDailyTraining: boolean` (só calculado nessa visão); quando `true`, o
  card mostra "Já está no treino de hoje". Implementado via
  `listScheduleAssignmentIdsInActiveTraining` (repositório do treino
  diário, importado diretamente por `scheduleService.ts` — nunca via
  `dailyTrainingService.ts`, para evitar um import circular entre os dois
  serviços, já que `dailyTrainingService.ts` também importa de
  `scheduleService.ts`).

## Limitações conhecidas e decisões pendentes da Andréia/PO

- **Pesos e limiares são 100% provisórios** — `MAX_DAILY_TRAINING_ITEMS`,
  `MAX_SAME_PATTERN_RATIO`, `FALLBACK_ITEM_MINUTES`,
  `RECENT_COMPLETION_EXCLUSION_DAYS` (3 dias) são números técnicos
  razoáveis, nunca validados pedagogicamente.
- **`schedule_commitment` sem FK para questão/padrão específico** — decisão
  herdada da Sprint 5 ("sem FK inventada para entidade inexistente"); o
  item concreto de um compromisso do dia vem do mesmo pool geral de
  padrões, nunca de uma questão pré-atribuída à atividade do cronograma.
  Se o cronograma um dia ganhar essa granularidade, este algoritmo pode
  passar a usá-la diretamente.
- **`scheduled_review` nunca é escrito** — valor legal do CHECK reservado
  para uma futura extensão (revisão ainda não vencida, incorporada
  preventivamente), sem migration nova.
- **`blocked` só é alcançado por um caminho defensivo** (questão/entrada
  indisponível entre apply e start) — não existe endpoint dedicado para
  bloquear um item manualmente nesta sprint.
- **Sem projeção persistida de resumo** — o resumo factual da conclusão é
  sempre recalculado por consulta derivada sobre `daily_training_items` +
  `question_attempts`, mesmo padrão de simplicidade já adotado pelo Mapa
  ENEM (Sprint 10) — nunca "dessincroniza", mas reprocessa a cada leitura.

## Política de testes desta sprint

Seguindo a seção 2 da ordem: durante o desenvolvimento e as correções
desta rodada, só os arquivos/fluxos diretamente impactados foram
executados —

- `worker/testing/dailyTrainingAlgorithm.test.ts` (algoritmo puro);
- `worker/testing/migration0016.test.ts` (SQL real da migration);
- `worker/testing/dailyTraining.test.ts` (serviço, contra `FakeD1Database`);
- `worker/testing/dailyTrainingAtomicity.test.ts` (concorrência, falhas
  forçadas, auditoria só em mutação real);
- `worker/testing/schedule.test.ts`, `errorNotebook.test.ts`,
  `studentMetrics.test.ts`, `playerAttempts.test.ts`,
  `playerAtomicity.test.ts` (impactados indiretamente por mudanças em
  `scheduleService.ts`/reaproveitamento do Player — reexecutados para
  confirmar ausência de regressão);
- `e2e/dailyTraining.spec.ts` e `evidence/sprint-11-screenshots.spec.ts`
  (Playwright, rodada única cada).

Nenhum `npx tsc -b`, `npx eslint .`, `npx vitest run` completo,
`npm run test:e2e` completo ou `npm run build` foi executado nesta rodada
— reservados para a rodada única de fechamento definitivo, exatamente como
as Sprints anteriores.
