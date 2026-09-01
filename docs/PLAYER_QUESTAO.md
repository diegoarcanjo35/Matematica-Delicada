# Player de Questão, Reconhecimento e Correção em Camadas — Sprint 8 v1.1

## Escopo e não escopo

Esta sprint entrega o fluxo real do aluno para abrir uma questão publicada,
opcionalmente reconhecer o padrão antes de ver as alternativas, responder,
usar ajuda progressiva em quatro camadas, confirmar a resposta e receber
feedback imediato com o DNA completo da questão — sobre a fundação do Banco
de Questões (Sprint 7, migrations 0008-0012) e do catálogo de padrões
(Sprint 6).

Não escopo (adiado): simulado/prova com várias questões e feedback adiado;
treino diário adaptativo definitivo; fórmulas dos três índices
(Reconhecimento/Resolução/Domínio); Caderno de Erros completo (só a
evidência bruta é persistida — nenhuma classificação pedagógica definitiva
do erro); recomendação automática; questões oficiais reais; produção, D1
remoto ou deploy.

## Schema — migration 0013

`migrations/0013_question_player_attempts.sql` é puramente aditiva (só
`CREATE TABLE/INDEX IF NOT EXISTS`) sobre o schema das Sprints 1-7
(0001-0012). Nenhuma tabela existente é alterada, nenhum conteúdo é
inserido pela migration.

### `question_attempts`

Uma linha por tentativa (aluno+questão+modo). Campos principais: `id`,
`user_id`, `question_id`, `question_version` (congelado no início — a
questão publicada é imutável, então isto é só um registro técnico),
`mode`, `status`, `selected_alternative`, `is_correct` (anulável, só
preenchido na confirmação), `recognition_pattern_id`/`recognition_clue`/
`recognition_strategy`, `highest_help_layer` (0-4), `started_at`/
`answered_at`/`completed_at`/`last_activity_at`, `version` (concorrência
otimista — mesma convenção do resto do projeto desde a Sprint 5) e
`last_mutation_id` (identidade da última mutação bem-sucedida — ver
"Atomicidade e idempotência" abaixo).

**Invariante de banco**: `idx_question_attempts_one_active`, um índice
único PARCIAL em `(user_id, question_id, mode) WHERE status = 'in_progress'`
— mesmo padrão comprovado em `migrations/0005_diagnostic_invariants.sql`
desde a Sprint 4. Só uma tentativa `in_progress` por usuário+questão+modo
pode existir a qualquer momento; tentativas `completed`/`abandoned` (qualquer
quantidade) nunca são restringidas.

### Tabelas de evento (todas append-only)

- `question_answer_events` — `selected`/`changed`/`confirmed`, nunca
  armazena o gabarito antes da confirmação.
- `question_recognition_events` — um evento por SALVAMENTO REAL (mudança de
  conteúdo) do reconhecimento; carrega `attempt_version`.
- `question_help_events` — um evento por camada aberta; índice único
  `(attempt_id, layer)` impõe no BANCO que a mesma camada da mesma
  tentativa nunca tem mais de uma linha.

### Revisão e denúncia

- `question_review_bookmarks` — único por `(user_id, question_id)`,
  imposto por índice único.
- `question_problem_reports` — `category` é um enum FECHADO (CHECK):
  `statement_problem`, `alternative_problem`, `answer_key_problem`,
  `image_problem`, `accessibility_problem`, `other`. `comment` é curto e
  opcional.

## Modos e status

Modos permitidos nesta sprint: `learning`, `practice`, `recognition`
(`test`/prova fica para quando existir sessão avaliativa com feedback
adiado). Status: `in_progress` → `completed` (confirmação) ou `abandoned`.
**Decisão de projeto**: não existe um status intermediário `answered`
distinto de `completed` neste desenho — a confirmação already muda o
estado para `completed` diretamente, já que não há nenhuma etapa adicional
descrita na ordem entre "confirmar" e "ver feedback" (o próprio feedback é
servido pela mesma consulta da tentativa). O campo `answered_at` continua
existindo e é preenchido no mesmo instante de `completed_at` — mantido por
completude de schema/telemetria futura, não por um estado de negócio
adicional hoje.

## Início e retomada

`POST /api/player/attempts` — sessão obrigatória; questão precisa estar
`published`; tentativa ativa existente do mesmo usuário+questão+modo é
devolvida sem duplicar (200, não 201); modo `recognition` começa na etapa
de reconhecimento (o cliente decide a UI a partir de `mode` — o servidor
não força uma ordem de etapa além de exigir reconhecimento salvo antes de
confirmar, nesse modo). Nenhuma resposta correta é revelada no payload.

`GET /api/player/attempts/:id` — somente leitura, nunca cria tentativa;
preserva resposta ainda não confirmada e camadas de ajuda já abertas; nunca
revela camadas ainda bloqueadas (`helpContent` só contém as camadas
`openedLayers` inclui); uma tentativa de outro aluno responde 404 (nunca
403 — não confirma a existência da tentativa alheia).

**Nota de desenho** (seção 12 da ordem, tela "antes/início"): a lista de 9
endpoints da seção 11 não inclui um GET de detalhe de questão fora de uma
tentativa. A tela `/questoes/:questionId` ("antes/início") é
deliberadamente genérica (seletor de modo, objetivo, estimativa, botão
iniciar) — o conteúdo real da questão (enunciado, alternativas, imagens)
só é revelado depois do `POST /api/player/attempts`, ao navegar para
`/tentativas/:attemptId` e consultar o `GET` da tentativa. Isto respeita
literalmente a lista de 9 endpoints sem inventar um 10º.

## Frontend

Duas telas, seguindo o mesmo padrão de fase-derivada-do-servidor usado em
`DiagnosticPage.tsx`/`PatternDetailPage.tsx`/`SchedulePage.tsx`:

- **`/questoes/:questionId`** (`src/pages/player/QuestionStartPage.tsx`) —
  tela "antes/início" genérica (seletor de modo, objetivo, estimativa,
  botão "Iniciar"). Chama `POST /api/player/attempts` e navega para
  `/tentativas/:attemptId`.
- **`/tentativas/:attemptId`** (`src/pages/player/AttemptPage.tsx`) — uma
  única página cuja fase é sempre derivada do estado real da tentativa
  devolvido pelo servidor (nunca um estado local que possa divergir):
  reconhecimento (modo `recognition`, ainda não salvo) → questão em
  andamento (alternativas, ajuda progressiva em 4 camadas, salvar para
  revisão, denunciar problema) → feedback (depois de `POST .../confirm`,
  banner de acerto/erro, distratores, DNA completo). Retomada após refresh
  é o MESMO carregamento inicial — nenhum estado adicional no cliente.

Cliente HTTP tipado: `src/api/playerClient.ts` (`startAttempt`,
`fetchAttempt`, `saveRecognition`, `saveAnswer`, `confirmAnswer`,
`openHelpLayer`, `saveBookmark`/`removeBookmark`, `reportProblem`,
`PlayerApiError`). Mesma convenção do resto do projeto: sucesso NUNCA
inclui `available` no corpo — só o gate fechado devolve `available: false`
explicitamente; o front checa `=== false`, nunca `!valor`.

Integração com o catálogo de padrões (seção 13 da ordem): a ficha do
padrão (`PatternDetailPage.tsx`) mostra "Treinar este padrão" como link
habilitado quando `pattern.trainableQuestionId` existe (selecionado por
`findTrainableQuestionForPattern`, seleção DETERMINÍSTICA — menor `code`
entre as questões publicadas com aquele padrão como principal — nunca um
algoritmo pedagógico ou adaptação; a copy é explícita: "seleção técnica
inicial"). O dashboard (`DashboardPage.tsx`) mostra o convite "Resolver uma
questão" (link para `/padroes-enem`, sem inventar métrica) quando
`patternsSummary.hasAnyTrainableQuestion` é verdadeiro.

## Reconhecimento

`PATCH /api/player/attempts/:id/recognition` — exige `version` e
`patternSlug` (nunca o id interno do padrão — mesma convenção do catálogo
de padrões desde a Sprint 6, que nunca expõe `id` ao cliente; o id real é
resolvido só no servidor, via `findPublishedPatternBySlug`,
`worker/src/repositories/patternsRepository.ts`); o padrão precisa estar
`published`; pista/estratégia são
texto livre, normalizado (trim + colapso de espaços) e limitado (300
caracteres cada) por `worker/src/lib/playerValidation.ts`, tratado sempre
como DADO (nunca executado — React escapa no front, SQL sempre
parametrizado); uma repetição com valores IDÊNTICOS é idempotente (sucesso
sem gravar evento nem avançar `version`); salvar libera a etapa das
alternativas no cliente (o servidor não bloqueia a resposta antes do
reconhecimento — só a CONFIRMAÇÃO exige reconhecimento salvo, no modo
`recognition`); nunca classifica automaticamente certo/errado nem calcula
índice.

## Resposta e confirmação

`PATCH /api/player/attempts/:id/answer` — só A-E; exige `version`; pode ser
alterada antes de confirmar; gera evento `selected` (primeira escolha) ou
`changed` (troca); repetição idêntica é idempotente; nunca retorna o
gabarito.

`POST /api/player/attempts/:id/confirm` — exige alternativa já selecionada;
no modo `recognition`, exige reconhecimento salvo; `is_correct` é
calculado NO WORKER a partir de `question_alternatives.is_correct` — o
corpo da requisição nunca é lido para decidir corretude (mesmo se o
cliente enviar `isCorrect`, é ignorado); `answered_at`/`completed_at` são
sempre `datetime('now')` do servidor, nunca um valor do corpo; versão
desatualizada → 409; depois de confirmada, a resposta é imutável
(`PATCH .../answer` numa tentativa `completed` é rejeitado com 400).

## Ajuda em quatro camadas

`POST /api/player/attempts/:id/help/:layer` — 1=pista, 2=padrão/frase de
reconhecimento, 3=estratégia, 4=resolução comentada (exige
`confirmViewResolution: true` explícito no corpo antes de abrir). Ordem
1→2→3→4 imposta no Worker (`playerService.ts:openHelpLayer`): pular uma
camada é rejeitado (400); reabrir uma já aberta é idempotente; a resposta
da API só devolve conteúdo das camadas já abertas
(`AttemptStateDto.helpContent`); ajuda de outra tentativa → 404.

## Feedback e DNA da Questão

Depois da confirmação, `GET`/o próprio `POST /confirm` devolvem: resposta
escolhida, resposta correta, acerto/erro, explicação da correta
(reaproveita `distractor_explanation` da alternativa correta), explicações
de distratores quando existentes, padrão principal, e o DNA completo
(pista, estratégia, pegadinha, conteúdo de apoio, resolução, atalho quando
houver, aprendizado do erro). Nenhum índice/domínio é apresentado. Em caso
de erro, a evidência bruta (`is_correct = 0`, `question_answer_events`)
já fica persistida para a Sprint 9 (Caderno de Erros) — nenhuma regra de
classificação definitiva é criada nesta sprint.

## Bookmark e denúncia

`PUT`/`DELETE /api/player/questions/:id/review-bookmark` — os dois
idempotentes (índice único no banco garante isso, nunca só uma checagem em
JS). `POST /api/player/questions/:id/problem-reports` — categoria
obrigatória do enum fechado; comentário curto opcional, NUNCA gravado
integralmente em `audit_log` (só id/categoria/metadados técnicos); isolado
por usuário (todo SQL de leitura/escrita escopado por `user_id`).

## Endpoints (lista real — 9, seção 11 da ordem)

| Método | Caminho | Leitura/Escrita |
|---|---|---|
| POST | `/api/player/attempts` | escrita (cria/retoma) |
| GET | `/api/player/attempts/:id` | somente leitura |
| PATCH | `/api/player/attempts/:id/recognition` | escrita |
| PATCH | `/api/player/attempts/:id/answer` | escrita |
| POST | `/api/player/attempts/:id/confirm` | escrita |
| POST | `/api/player/attempts/:id/help/:layer` | escrita |
| PUT | `/api/player/questions/:id/review-bookmark` | escrita |
| DELETE | `/api/player/questions/:id/review-bookmark` | escrita |
| POST | `/api/player/questions/:id/problem-reports` | escrita |

Método não coberto por nenhuma destas combinações → 405
(`worker/src/routes/player.ts`). Nenhum endpoint editorial é exposto sob
`/api/player/*` — os dois espaços de rota são completamente separados.

## Autorização

Sessão obrigatória em toda requisição (401 sem sessão). Toda consulta de
tentativa/bookmark/denúncia escopa por `user_id` diretamente no SQL
(`worker/src/repositories/playerRepository.ts`) — nunca só na camada de
aplicação. Uma tentativa/ajuda/reconhecimento de outro aluno sempre
responde 404, nunca 403 (não confirma a existência do recurso alheio —
mesmo padrão de rascunho-vs-inexistente já usado pelo catálogo de padrões
desde a Sprint 6).

## Gate e fixtures

Reaproveita EXATAMENTE `isLocalEditorialFixturesAllowed`
(`worker/src/env.ts`), o mesmo gate que já protege o conteúdo de
`questions`/`question_dna`/etc. desde a Sprint 7 — nenhum gate novo foi
criado. Toda a rota `/api/player/*` fica atrás dele: fora das três
condições simultâneas (ambiente local + flag exclusiva de
`wrangler.local.jsonc` + hostname local reconhecido), a API responde
`{ ok: true, available: false }` sem tocar em nenhuma tabela do player —
mesma forma acolhedora de diagnóstico/cronograma/padrões. **Decisão de
projeto**: como só existe conteúdo técnico de fixture nesta sprint (nenhuma
questão oficial real), gatear a rota INTEIRA (em vez de só as partes que
tocam fixture) é a escolha mais simples e segura hoje; quando conteúdo
oficial real existir (fora do escopo desta sprint), este gate precisará ser
revisitado para distinguir os dois casos.

A fixture `fixture-q-04` (Sprint 7,
`scripts/fixtures/questions-fixtures.local.sql`) já é elevada a
`published` pelo próprio seed, com DNA completo, 5 alternativas e um
padrão principal (`fixture-pat-04`) — pronta para o player sem nenhuma
mudança adicional no seed. Seed só por comando explícito
(`npm run db:seed:questions:local`), nunca por GET/POST do player.

## Eventos e auditoria

Registrados em `audit_log` (`worker/src/routes/player.ts`), só na mutação
REAL (nunca em repetição idempotente): `question_viewed`,
`question_attempt_started`, `question_pattern_selected`,
`question_help_opened`, `question_answer_selected`,
`question_answer_changed`, `question_answer_confirmed`,
`question_attempt_completed`, `question_saved_for_review`,
`question_problem_reported`.

NUNCA registrados em `audit_log`: texto livre de reconhecimento
(pista/estratégia), comentário de denúncia, enunciado, resolução,
alternativa completa, gabarito. Esse conteúdo vive só nas tabelas técnicas
próprias (`question_recognition_events`, `question_problem_reports`).

## Atomicidade e idempotência

`question_attempts` é uma entidade de UMA linha por tentativa — nunca o
problema multi-coleção que forçou a Sprint 7 (migrations 0009-0012) a
escalar para triggers de banco. Cada mutação de conteúdo (reconhecimento,
resposta, confirmação, ajuda) roda num único `db.batch()` com DOIS
statements: um `UPDATE` guardado por identidade+versão+status
(`id = ? AND user_id = ? AND version = ? AND status = 'in_progress'`,
`worker/src/repositories/playerRepository.ts:attemptGuard`) e um `INSERT`
de evento guardado por `EXISTS (... WHERE last_mutation_id = ?)`
(`eventGuardCondition`).

**Por que o guard do evento é por IDENTIDADE (`last_mutation_id`), não por
versão resultante**: uma primeira versão desta implementação guardava o
INSERT de evento comparando a versão RESULTANTE (`expectedVersion + 1`).
Um teste de corrida real
(`worker/testing/playerAttempts.test.ts`, "CORRIDA na confirmação")
provou que isso é insuficiente — exatamente a lição da Sprint 7 v1.6
(`migrations/0012_editorial_mutation_identity.sql`): duas chamadas
CONCORRENTES com o MESMO `expectedVersion` calculam o MESMO
`version + 1` aritmético; a vencedora da corrida grava a versão N, mas a
PERDEDORA (cujo `UPDATE` afetou 0 linhas, guard falhou) ainda via "a versão
N existe" — só que por causa da vencedora — e inseria um evento que não era
seu, produzindo 2 eventos `confirmed` para 1 confirmação real. A correção:
`question_attempts.last_mutation_id` (nova coluna) é setada pelo MESMO
`UPDATE` guardado para um id único gerado por CADA chamada; o `INSERT` de
evento pareado só é aceito se aquele id específico está gravado na linha —
nunca "existe uma versão", sempre "fui EU quem gravou". Reconfirmado pelo
mesmo teste, agora passando de forma determinística.

Idempotência de conteúdo: toda mutação compara o valor ATUAL com o
ENVIADO antes de montar qualquer statement — valores idênticos retornam
sucesso sem tocar o banco (`changed:false`), nunca gravam evento nem
avançam `version`. Concorrência real (duas chamadas com o MESMO
`expectedVersion`) faz o guard de uma delas falhar; a perdedora relê o
estado e devolve 409 (versão genuinamente desatualizada) ou trata como
sucesso idempotente quando o resultado já reflete exatamente o que ela
pediria (mesma corrida, resultado coerente).

**Início de tentativa**: garantia de banco (índice único parcial), não uma
checagem em JS — mesmo padrão de `diagnosticService.ts`/Sprint 4 desde
2025. Duas criações simultâneas: a segunda `INSERT` viola o índice único;
o serviço (`playerService.ts:startOrResumeAttempt`) captura a violação
(`isUniqueActiveAttemptViolation`) e relê a tentativa vencedora, devolvendo
exatamente a mesma tentativa para as duas chamadas — provado por teste
direto de corrida (`worker/testing/playerAttempts.test.ts`, "CORRIDA:
duas criações simultâneas").

## Acessibilidade

Mesmo padrão de toda a interface do projeto desde a Sprint 3: nenhum
`dangerouslySetInnerHTML`; teclado completo; foco movido ao mudar de
etapa; `aria-live` para salvamento/feedback; `fieldset`/`legend` nas
alternativas; alt-text de imagens; contraste; mobile 360/390 sem rolagem
horizontal; o tempo decorrido é sempre apresentado como informação
aproximada, nunca como cronômetro avaliativo que pressiona o aluno.

## Limitações conhecidas

- A tela "antes/início" (`/questoes/:questionId`) é genérica antes do
  início da tentativa (ver "Nota de desenho" acima) — não há um 10º
  endpoint para pré-visualizar conteúdo fora de uma tentativa criada.
- Sem cálculo dos três índices, sem Caderno de Erros completo, sem
  recomendação automática — só evidência bruta persistida.
- "Treinar este padrão" (seção 13) usa seleção DETERMINÍSTICA (menor
  `code`), nunca um algoritmo pedagógico — `findTrainableQuestionForPattern`
  (`worker/src/repositories/questionRepository.ts`).
- Arquivar/apagar uma questão com tentativa ativa: **regra explícita
  decidida nesta sprint** — o Banco de Questões (Sprint 7) já bloqueia
  qualquer edição de questão `published` (imutabilidade), e arquivamento
  segue as transições normais do workflow editorial
  (`QUESTION_TRANSITIONS`); nenhuma checagem cruzada com
  `question_attempts` foi adicionada nesta sprint (fora do escopo do
  Player) — documentado aqui como uma lacuna conhecida, não uma omissão
  silenciosa: uma tentativa em andamento sobre uma questão arquivada
  continua funcionando normalmente pelo lado do Player (lê dados já
  carregados/publicados), mas o catálogo deixaria de oferecer a questão
  para NOVAS tentativas — comportamento aceitável para esta fundação,
  candidato a uma regra mais explícita (ex. bloquear arquivamento com
  tentativa `in_progress`) em sprint futura.
- Gate local cobre a rota inteira (ver "Gate e fixtures") — não distingue
  fixture de conteúdo oficial real, porque este último não existe ainda.
- A API (`PATCH .../recognition`) permite atualizar o reconhecimento
  quantas vezes o aluno quiser antes de confirmar a resposta — a interface
  (`src/pages/player/AttemptPage.tsx`) só oferece essa etapa UMA vez (some
  da tela assim que salva com sucesso, revelando as alternativas); reabrir o
  reconhecimento para editar fica para uma iteração futura de UI, não é uma
  limitação do Worker.
- O estado do bookmark ("salvo para revisão") não é lido de volta do
  servidor ao carregar `GET /api/player/attempts/:id` (não existe esse
  campo no DTO da tentativa) — o botão reflete só a última ação feita nesta
  sessão, começando sempre como "não salvo" a cada carregamento de página,
  mesmo que já exista um bookmark de uma sessão anterior.

## Testes automatizados

- `worker/testing/migration0013.test.ts` — schema/índices/constraints.
- `worker/testing/playerAttempts.test.ts` — serviço completo, incluindo os
  dois testes de corrida real (criação de tentativa, confirmação).
- `e2e/player.spec.ts` — fluxo completo em Chromium real: início, os três
  modos, ajuda em 4 camadas, troca de alternativa, acerto/erro, retomada
  após refresh, bookmark, denúncia, teclado/foco, 390px sem rolagem
  horizontal, isolamento entre alunos (404), integração com "Treinar este
  padrão" e o CTA do dashboard.
- `e2e/diagnostic-unavailable-gate.spec.ts` — reaproveita o servidor
  `wrangler.local.no-diagnostic.jsonc` (que também omite
  `ENABLE_LOCAL_EDITORIAL_FIXTURES`) para provar `available: false` no
  gate fechado, tanto na API quanto na UI de `/questoes/:id` e
  `/tentativas/:id`.
- `evidence/sprint-08-screenshots.spec.ts` — as 14 evidências visuais da
  seção 17 da ordem, em `evidence/screenshots/sprint-08/`.

## Próximos passos

Caderno de Erros (classificação pedagógica real do erro, a partir da
evidência bruta já persistida); treino diário adaptativo; fórmulas e
cálculo dos três índices (Reconhecimento/Resolução/Domínio); simulado com
feedback adiado.
