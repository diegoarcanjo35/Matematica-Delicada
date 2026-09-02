# Simulados em Blocos e Análise Factual de Desempenho — Sprint 12 v1.0

## Escopo e linguagem correta

Implementa uma experiência real de **simulado em bloco**, usando
exclusivamente questões publicadas do Banco de Questões (Sprints 6-7) e
reutilizando o Player já existente (Sprint 8). O aluno escolhe um bloco
misto ou focado em um padrão, visualiza uma prévia, aplica explicitamente,
resolve as questões no Player real e recebe um resumo final factual.

Toda comunicação **sempre** chama a experiência de `simulado em bloco`,
`bloco de questões` ou `prática em formato de simulado`. **Nunca** afirma
que o resultado equivale à nota oficial do ENEM. Esta sprint **não**
implementa: prova oficial do ENEM, TRI, nota estimada, ranking, comparação
entre alunos, gamificação, antifraude, fiscalização de tela, professor/
turma, um segundo Player, fórmula definitiva de domínio, simulado completo
de 45 questões, ou qualquer conteúdo editorial novo.

## Diferença entre bloco e prova oficial

| | Bloco de simulado (esta sprint) | Prova oficial do ENEM |
|---|---|---|
| Tamanho | 5, 10 ou 15 questões (provisório, técnico) | 45 questões de Matemática |
| Fonte das questões | Banco de Questões publicado (fixtures locais/autorais) | Prova oficial licenciada |
| Resultado | Fatos: acertos, erros, tempo aproximado | Nota TRI oficial |
| Fiscalização | Nenhuma — cronômetro informativo | Fiscalização real |
| Comparação | Nenhuma — só o próprio histórico do aluno | Ranking nacional |

## Arquitetura

Camada de **orquestração** sobre tabelas já existentes — nenhuma questão,
padrão ou tentativa é copiada/duplicada:

- `worker/src/lib/simulationRules.ts` — algoritmo puro de seleção
  (`selectMixedBlock`/`selectPatternFocusedBlock`), tamanhos permitidos,
  fallback de duração (reaproveita `estimateItemMinutes`/
  `FALLBACK_ITEM_MINUTES` de `dailyTrainingRules.ts`, Sprint 11 — nunca um
  segundo número inventado para o mesmo conceito). Nenhum acesso a banco/
  relógio real.
- `worker/src/repositories/simulationsRepository.ts` — leitura/escrita
  parametrizada das três tabelas novas; reaproveita
  `listPublishedPatternIds`/`listTrainableQuestionsForPattern`/
  `listRecentlyCompletedQuestionIds` de `dailyTrainingRepository.ts` (Sprint
  11) para os candidatos, nunca duplica a consulta.
- `worker/src/services/simulationsService.ts` — orquestra: resolve o
  pedido (tipo/padrão/tamanho), monta candidatos (`computeSelection`,
  reaproveitada por `preview` e `applyBlock`, nunca duas implementações),
  persiste atomicamente, integra com o Player (`playerService.ts`, sem
  duplicar), calcula o resumo factual, expõe o histórico.
- `worker/src/routes/simulations.ts` — os 10 endpoints, sessão/ownership/
  auditoria.
- `src/pages/simulations/SimuladosPage.tsx` — a tela `/simulados`
  (configuração, prévia, histórico).
- `src/pages/simulations/SimuladoBlocoPage.tsx` — a tela
  `/simulados/:blockId` (bloco ativo, item em andamento, conclusão,
  abandono).
- `src/api/simulationsClient.ts` — cliente tipado, mesmo padrão de
  `dailyTrainingClient.ts`.

## Schema (`migrations/0017_simulation_blocks.sql`)

Puramente aditiva sobre 0001-0016 — nenhuma migration anterior é editada.

### `simulation_blocks`

Uma linha por bloco efetivamente **aplicado** (nunca uma prévia — não
existe tabela de prévia nesta sprint, mesma decisão do Treino Diário/Sprint
11). `block_type` fechado (`mixed`, `pattern_focused`); `primary_pattern_id`
é `NULL` no modo misto e obrigatório no modo focado — garantido por um
`CHECK` de tabela combinado (`(block_type = 'pattern_focused' AND
primary_pattern_id IS NOT NULL) OR (block_type = 'mixed' AND
primary_pattern_id IS NULL)`), posicionado ao final de todas as colunas
(exigência de sintaxe do motor SQLite embutido usado pelos testes locais,
`node:sqlite` — um `CHECK` de tabela no meio da lista de colunas é
rejeitado por esse motor especificamente, mesmo sendo SQL válido para D1/
SQLite em geral).

`planned_item_count` fechado em `{5, 10, 15}`; `actual_item_count` sempre
`> 0` e `<= planned_item_count` — nunca um bloco vazio, nunca mais itens do
que o pedido. `block_date`/`timezone` carimbados no momento do apply, mesma
razão de robustez de `daily_training_lists.training_date`.

Índice único **parcial** `idx_simulation_blocks_one_active_per_user` em
`(user_id) WHERE status = 'active'` — garante no banco, não só em JS, no
máximo um bloco `active` por aluno. Diferente do Treino Diário (uma lista
ativa **por dia**), aqui é "um bloco ativo por aluno", sem escopo de data —
seção 5 da ordem.

### `simulation_block_items`

Um item por questão selecionada, referenciando diretamente `questions`
(nunca uma cópia do conteúdo editorial). Índices únicos: `(block_id,
question_id)` (nenhuma questão repetida no bloco), `(block_id, position)`
(ordem determinística), e `question_attempt_id WHERE NOT NULL` (no máximo
um item associado à mesma tentativa do Player).

### `simulation_block_events`

Histórico append-only de mutações **reais**. Nunca armazena resposta,
texto livre ou conteúdo sensível. `item_id` é nulo para os três eventos de
nível de bloco (`block_applied`, `block_completed`, `block_abandoned`) e
obrigatório para os três de nível de item (`item_started`, `item_completed`,
`item_skipped`) — mais `item_blocked` (questão despublicada entre o apply e
o start), reforçado por um trigger, nunca só por convenção.

### Atomicidade por identidade (trigger consolidado)

Mesma classe de mecanismo "marcador incondicional + `RAISE(ABORT)` por
identidade, antes do commit" já comprovada nas migrations 0009-0014 e 0016.
Um único trigger, `trg_simulation_block_events_require_identity`, cobre:

1. eventos de bloco exigem `simulation_blocks.last_mutation_id = NEW.id`;
2. `block_applied` exige **adicionalmente** que `actual_item_count` já
   bata com a contagem real de linhas em `simulation_block_items` para
   aquele bloco;
3. eventos de item exigem `simulation_block_items.last_mutation_id =
   NEW.id`, **e** que o item pertença ao mesmo bloco/usuário do evento.

Provado diretamente contra o SQL real em `worker/testing/migration0017.test.ts`
e contra falhas forçadas/corridas em `worker/testing/simulationsAtomicity.test.ts`.

## Tipos e tamanhos de bloco

- **Misto** — questões distribuídas entre padrões publicados, priorizando
  diversidade (round-robin determinístico entre grupos de padrão);
- **Focado em um padrão** — exige `patternSlug` resolvido no servidor;
  somente questões cujo padrão **principal** seja o escolhido; padrão
  inexistente/rascunho responde 404, sem vazar conteúdo editorial;
- tamanhos técnicos provisórios: **5, 10 ou 15** questões — nunca 45,
  nunca chamado de "prova completa".

## Preview × apply

`GET /api/simulations/preview` é **100% somente leitura** —
`simulationsService.preview()` nunca chama `db.batch()`. Mesma decisão do
Treino Diário: nenhuma tabela de prévia persistida — o cálculo
(`resolveBlockRequest` + `computeSelection`) é barato e 100% determinístico
para o mesmo usuário/tipo/padrão/tamanho/estado do banco/relógio injetado,
então `POST /apply` **recomputa o mesmo cálculo** antes de persistir.

`POST /apply`:
- exige `mutationId`, `blockType` e `size`, mais `patternSlug` no modo
  focado;
- **PO v1.1 (correção) — a decisão de "isto é um retry idempotente?" usa
  SEMPRE a IDENTIDADE da mutação (`mutationId`), NUNCA a igualdade de
  conteúdo (tipo/padrão/tamanho) como proxy**: a versão v1.0 comparava só a
  configuração do bloco `active` já existente contra o pedido atual — um
  `mutationId` diferente com a mesma configuração era tratado como retry
  legítimo, o que confundia "duas requisições que pediram a mesma coisa"
  com "a mesma requisição enviada duas vezes" (ver seção "Correção PO v1.1"
  abaixo para o raciocínio completo e os cenários provados). Contrato
  atual, decidido por `classifyActiveBlockCollision` em
  `simulationsService.ts`:
  - já existe um bloco `active` deste aluno **e** o `mutationId` do pedido é
    o MESMO que criou aquele bloco **e** a configuração bate → retry
    idempotente real, devolve o bloco existente (`changed:false`);
  - já existe um bloco `active` **e** o `mutationId` é o MESMO, mas a
    configuração é DIFERENTE → essa identidade já foi consumida por outra
    mutação real — 409 controlado (`conflict:true`), nunca tratado como
    retry;
  - já existe um bloco `active` **e** o `mutationId` é DIFERENTE (mesmo com
    configuração idêntica) → conflito de domínio explícito
    (`activeElsewhere:true`) — igualdade de tipo/padrão/tamanho NUNCA prova
    que é a mesma mutação; nunca disfarçado de sucesso silencioso;
- se a seleção resultar em zero itens, devolve `{ok:true, empty:true}` e
  **não escreve nada**;
- senão, persiste bloco + itens + evento `block_applied` num único
  `db.batch()`;
- **nunca inicia automaticamente uma tentativa do Player** (seção 9);
- um `mutationId` já consumido por QUALQUER outra mutação real deste aluno
  (inclusive de um bloco já terminal, ou de um evento de item) — quando
  nenhum bloco `active` está presente para a checagem acima resolver o
  caso — também é rejeitado com 409 controlado (`simulationEventIdInUse`,
  mesma proteção de `startItem`/`syncItem`/`skipItem`), nunca uma exceção
  crua do INSERT do evento.

Verificado com contagens diretas de linhas em todas as tabelas relevantes,
antes/depois de chamadas repetidas de GET (`worker/testing/simulations.test.ts`,
descrição "preview — somente leitura").

## Algoritmo determinístico (`worker/src/lib/simulationRules.ts`)

**Nada aqui é uma fórmula pedagógica definitiva** — pesos, ordem e
desempates são técnicos e provisórios, pendentes de validação pedagógica
da Andréia, mesma disciplina de `dailyTrainingRules.ts` (Sprint 11).

### Critérios (seção 8 da ordem)

- somente questões `published` e treináveis (padrão principal resolvido
  via `question_patterns`, `role = 'principal'`);
- nenhuma questão duplicada no bloco (deduplicação defensiva na função
  pura + índice único no banco);
- usa padrão **principal**, nunca secundário, para composição;
- questões concluídas nos últimos 3 dias (mesma janela técnica de
  `dailyTrainingService.ts`, reaproveitada — nunca um segundo número para
  o mesmo conceito) são **deprioridadas**, nunca excluídas — entram como
  fallback honesto quando são a única alternativa;
- **misto**: candidatos agrupados por padrão, cada grupo ordenado por
  evidência do Mapa ENEM (`getPatternEvidence(...).lastPracticeAt` — padrão
  nunca praticado primeiro, depois o menos recentemente praticado) — a
  evidência só **ordena** os grupos, nunca **exclui** um padrão (seção 6 da
  ordem); dentro de cada grupo, seleção por round-robin entre grupos,
  priorizando diversidade (uma questão de cada padrão antes de repetir
  qualquer padrão);
- **focado**: respeita estritamente o único padrão escolhido;
- estabilidade de ordem: mesmos dados e mesmo relógio produzem sempre a
  mesma seleção (`worker/testing/simulationRules.test.ts`, teste de
  determinismo);
- fallback honesto: quando há menos questões publicadas do que o tamanho
  pedido, o bloco é criado com o que existe (`actual_item_count <
  planned_item_count`), nunca preenchido artificialmente;
- duração aproximada com fallback centralizado (`estimateItemMinutes`,
  reaproveitado de `dailyTrainingRules.ts`);
- nenhum sorteio não determinístico em lugar nenhum (`Math.random()`/
  `ORDER BY RANDOM()` nunca usados).

## Apply atômico e idempotente

Ver "Preview × apply" acima. Garantias adicionais (seção 9/19 da ordem,
provadas em `worker/testing/simulationsAtomicity.test.ts`):

- dois `applyBlock` simultâneos para o mesmo aluno criam exatamente **um**
  bloco ativo (índice único parcial + `catch` que relê e classifica a
  vencedora pela MESMA lógica de identidade de `mutationId` usada no
  caminho síncrono — PO v1.1: a perdedora nunca é tratada como retry só
  porque pediu a mesma configuração; recebe `activeElsewhere` (mutationId
  diferente) ou `conflict` (mesmo mutationId, configuração diferente));
- falha genuína no INSERT do evento obrigatório reverte bloco + itens
  inteiramente (nunca escrita parcial);
- retry com o mesmo `mutationId` (mesma operação) nunca duplica;
- colisão de `mutationId` (reaproveitado de outra mutação real — inclusive
  de item/bloco diferente, protegido pela PK global de
  `simulation_block_events`) retorna 409 controlado em `applyBlock`,
  `syncItem`, `skipItem`, `completeBlock` e `abandonBlock`, nunca uma
  exceção crua (PO v1.1: `completeBlock`/`abandonBlock` não tinham
  `try/catch` ao redor do `db.batch()` nesse cenário — corrigido).

## Integração com o Player

**Nenhum segundo Player.** `simulationsService.startItem` reutiliza
`playerService.planStartOrResumeAttempt` (o **mesmo** plano transacional
extraído na Sprint 11 para o Treino Diário) — os statements de criação/
retomada da tentativa entram no **mesmo** `db.batch()` que associa
`question_attempt_id` ao item e grava o evento `item_started`. Nunca duas
transações separadas; nunca uma tentativa criada sem o item associado
(provado por falha forçada em `simulationsAtomicity.test.ts`).

Diferente do Treino Diário, o simulado **nunca** cria tentativa de revisão
(`planStartOrResumeReviewAttempt`) — os itens do bloco vêm exclusivamente
do Banco de Questões publicado, sempre em modo `practice` (seção 1 da
ordem: "usando exclusivamente questões publicadas do Banco de Questões").

`syncItem` lê a tentativa REAL — só `completed` conclui o item; resposta
salva mas não confirmada devolve `changed:false` honestamente. Acerto/erro
confirmados continuam alimentando o Caderno de Erros pela regra já
existente (`playerService.confirmAnswer`, Sprint 9) — o simulado não
interfere nesse caminho, só lê o resultado depois (provado em
`simulations.test.ts`, "acerto e erro do simulado alimentam o Caderno de
Erros... sem duplicar").

Questão despublicada entre o apply e o start transiciona o item para
`blocked` (guardado, evento `item_blocked`) em vez de falhar sem
explicação — nunca deixa o núcleo `in_progress` sem tentativa real
associada.

## Tempo e retomada

O cronômetro é **informativo, nunca antifraude** (seção 11 da ordem):

- timestamps do servidor (`question_attempts.started_at`/`completed_at`)
  são a fonte de verdade; o frontend nunca calcula tempo por si só;
- refresh e reabertura de `/simulados/:blockId` retomam o mesmo bloco —
  `GET /api/simulations/current` devolve o bloco `active` (mesma
  identidade, nunca um segundo bloco), e qualquer item `in_progress` é
  sincronizado com a tentativa real ao carregar a tela (mesmo padrão de
  `DailyTrainingPage.tsx`);
- tempo de aba fechada nunca é contabilizado como medição pedagógica
  exata — limitação conhecida e documentada, nunca escondida;

### Sync automático ao carregar a tela — efeito colateral documentado (PO v1.1)

**`SimuladoBlocoPage.tsx` NÃO é 100% somente leitura.** Ao carregar (ou
recarregar) a tela com o bloco `active`, um `useEffect` guardado por um
`ref` (`syncedOnLoad`, dispara no máximo uma vez por `block.id` carregado)
chama `POST .../items/:itemId/sync` para cada item `in_progress` — isto é
**intencional e permanece assim após a correção v1.1**, mas precisa ser
declarado honestamente como o que é: uma chamada de MUTAÇÃO disparada
automaticamente pelo carregamento da página, não uma leitura passiva. A
correção v1.1 auditou este comportamento (em vez de reescrevê-lo numa nova
UX, seção 2 da ordem de correção) e confirmou, com prova direta de rede e
banco (`e2e/simulations.spec.ts`, descrição "sincronização automática ao
carregar a tela"), que ele já satisfaz o padrão exigido para permanecer:

- **idempotente por nunca escrever quando não há nada genuíno a
  sincronizar** — `syncItem` só grava (UPDATE do item + evento
  `item_completed`) quando a tentativa REAL do Player já está `completed`;
  se a resposta foi salva mas não confirmada (tentativa ainda
  `in_progress`), a chamada devolve `changed:false` sem tocar o banco —
  provado com `version`/`status` idênticos antes/depois de cada
  recarregamento, mesmo repetido;
- **nunca cria uma tentativa nem conclui um item ainda genuinamente em
  andamento** — a fonte de verdade é sempre `question_attempts.status`,
  nunca inferida no frontend;
- **nunca duplica evento/auditoria** — `simulation_block_events.id` é a PK
  global da mutação; um item já `completed` responde `changed:false` sem
  reexecutar o `db.batch()` (mesma idempotência de `syncItem` provada em
  `simulations.test.ts`/`simulationsAtomicity.test.ts`);
- prova end-to-end dedicada (rede + efeito real no banco, via
  `GET /api/simulations/:blockId` antes/depois): `e2e/simulations.spec.ts`,
  descrição "Simulados — sincronização automática ao carregar a tela
  (correção PO v1.1, seção 2 da ordem)" — dois cenários, tentativa ainda em
  andamento (POST dispara, zero efeito) e tentativa genuinamente concluída
  (POST dispara, conclui uma única vez, idempotente em recarregamentos
  seguintes).

**Não é o ideal absoluto** (a ordem de correção prefere, quando possível,
que o carregamento da tela seja 100% leitura e a sincronização aconteça só
como consequência explícita de "voltar do Player") — mas, como não há hoje
um sinal natural e confiável de "acabou de voltar do Player" distinto de
"a tela carregou", e o comportamento atual já é seguro pelas garantias
acima, a correção v1.1 optou por auditar e documentar honestamente em vez
de inventar um novo fluxo de UX só para esta rodada (fora de escopo
cirúrgico).
- toda apresentação de duração usa "aproximadamente";
- conclusão nunca é bloqueada por tempo excedido;
- **nenhuma fiscalização** — sem tela cheia obrigatória, sem detecção de
  troca de aba, em lugar nenhum do código.

## Estados e transições

### Bloco

`active` → `completed` (todos os itens terminais) | `abandoned` (a
qualquer momento enquanto `active`). Terminais, nunca voltam.

### Item

`pending` → `in_progress` (start) → `completed` (sync com tentativa
`completed`) | `skipped` (skip) | `blocked` (questão indisponível no
start). `pending` → `skipped` também é permitido. Terminais: `completed`,
`skipped`, `blocked`.

### Frontend

`/simulados` (`SimuladosPage.tsx`): `loading` → (`unavailable` | `config`)
→ `preview` (com quantidade insuficiente sinalizada dentro do próprio
preview) → `applying` → redireciona para `/simulados/:blockId`, mais
`error` recuperável e a seção de histórico (`vazio`/`com dados`) sempre
visível abaixo da configuração. Um bloco ativo encontrado ao carregar a
tela redireciona automaticamente para `/simulados/:blockId` — a tela de
configuração nunca duplica a interface do bloco.

`/simulados/:blockId` (`SimuladoBlocoPage.tsx`): `loading` → `notFound` |
`active` (com sub-estados por item: pendente/em andamento/progresso
salvo/retomada) → `completed` | `abandoned`, mais `error` recuperável.

## Resultado factual

O resumo (`CompletionSummaryDto`) mostra **apenas fatos**: questões
concluídas, acertos/erros confirmados, puladas/bloqueadas, percentual
bruto rotulado explicitamente **"acerto neste bloco"** (`accuracyPercent`,
`null` honesto quando nenhuma questão foi confirmada — nunca 0%
fabricado), tempo total aproximado, média aproximada por questão, padrões
praticados, quantidade de ajudas utilizadas. **Nunca** inclui nota ENEM,
TRI, projeção de aprovação, classificação definitiva de domínio,
comparação entre alunos, ranking, medalhas, XP ou qualquer recompensa
fabricada — testado explicitamente em `simulations.test.ts` (as chaves do
objeto de resumo são comparadas contra a lista fechada exigida) e exibido
com um aviso explícito na tela (`SimuladoBlocoPage.tsx`, `SummaryCard`).

## Histórico

`GET /api/simulations/history` é **100% somente leitura**, paginado por
keyset (`created_at`, `id` — nunca `OFFSET` puro), mostrando só blocos
`completed`/`abandoned` do próprio aluno: data, tipo, padrão focado (quando
houver), questões concluídas, acertos/erros brutos, duração aproximada.
**Nunca** agrega em nota, ranking ou tendência definitiva.

## Concorrência e falhas forçadas (seção 19 da ordem)

Provado diretamente no banco em `worker/testing/simulationsAtomicity.test.ts`
e `worker/testing/migration0017.test.ts`, mesmo padrão do Treino Diário:

- apply reverte bloco/itens/evento integralmente se qualquer statement
  falhar;
- retry idempotente não duplica dados;
- colisão de `mutationId` retorna 409, corrida real de TOCTOU (duas
  operações **diferentes**, mesmo `mutationId`, usando a "porta"
  determinística `pauseReadsMatching` de `worker/testing/fakeD1.ts` para
  provar a corrida sem depender de sorte de scheduler) é arbitrada pela
  PRIMARY KEY real de `simulation_block_events`, nunca por uma checagem em
  JS que poderia perder a corrida;
- dois applies simultâneos criam exatamente um bloco ativo;
- start cria/retoma e associa exatamente uma tentativa, mesmo sob corrida;
- falha no evento de start não deixa tentativa órfã (prova direta contra
  `question_attempts`, não só contra `simulation_block_items`);
- tentativa preexistente (aberta fora do simulado) não é apagada por um
  rollback;
- complete com item não terminal falha antes do commit (a própria condição
  vive no `WHERE` do UPDATE guardado — `buildCompleteBlockStatement`);
- nenhuma operação retorna sucesso HTTP após persistência parcial.

## Isolamento e privacidade (seção 17 da ordem)

- `user_id` sempre no `WHERE` do SQL, nunca só na aplicação;
- nenhuma identidade externa aceita pelo corpo/query — sempre derivada da
  sessão;
- tentativa, item ou bloco de outro aluno sempre 404, nunca 403 (provado em
  `simulations.test.ts` e `e2e/simulations.spec.ts`);
- nenhum texto livre em URL, evento ou auditoria;
- resposta marcada permanece nas tabelas próprias do Player
  (`question_attempts`/`question_answer_events`) — nunca copiada para
  `simulation_block_events`;
- dados fictícios em fixtures e screenshots (`evidence/screenshots/sprint-12/`).

## Endpoints (seção 13 da ordem)

| Método | Rota | Mutação | Auditoria |
|---|---|:-:|---|
| GET | `/api/simulations/preview` | não | nunca |
| POST | `/api/simulations/apply` | sim | `simulation_block_applied` |
| GET | `/api/simulations/current` | não | nunca |
| GET | `/api/simulations/:blockId` | não | nunca |
| POST | `/api/simulations/:blockId/items/:itemId/start` | sim | `simulation_item_started` |
| POST | `/api/simulations/:blockId/items/:itemId/sync` | condicional | `simulation_item_completed` (só quando conclui) |
| POST | `/api/simulations/:blockId/items/:itemId/skip` | sim | `simulation_item_skipped` |
| POST | `/api/simulations/:blockId/complete` | sim | `simulation_block_completed` |
| POST | `/api/simulations/:blockId/abandon` | sim | `simulation_block_abandoned` |
| GET | `/api/simulations/history` | não | nunca |

Sessão obrigatória (401 sem sessão); métodos inválidos 405; toda mutação
exige `mutationId`; auditoria só quando `changed === true`; histórico
paginado com limite fechado (20 por página).

## Limitações conhecidas e decisões pendentes da Andréia/PO

- **Pesos e regras de diversidade são 100% provisórios** — o round-robin
  entre grupos de padrão, a janela de 3 dias para deprioridade de questão
  recente, e o uso de `lastPracticeAt` para ordenar grupos no modo misto
  são decisões técnicas razoáveis, nunca validadas pedagogicamente.
- **Seed local tem só um padrão publicado com questões publicadas**
  (`fixture-pat-04`, duas questões) — todo bloco pedido nos tamanhos 5/10/
  15 contra o seed de desenvolvimento cai honestamente em "quantidade
  insuficiente"; isto é uma limitação do **conteúdo de desenvolvimento
  local**, não do algoritmo (o mesmo já valia para o Treino Diário, Sprint
  11).
  - Um único padrão publicado com questões (`fixture-pat-04`) fez a maior
    parte da demonstração local de "misto" e "focado" convergirem para o
    mesmo conjunto de questões, um efeito exclusivo do volume atual de
    fixtures — sem impacto na correção do algoritmo (comprovado com
    múltiplos padrões em `worker/testing/simulations.test.ts` e
    `simulationRules.test.ts`, via fixtures dedicados).
- **`accuracyPercent`/`approxMinutesPerQuestion` usam divisão inteira
  arredondada** — nunca uma fórmula estatística mais sofisticada; percentual
  bruto simples, sempre rotulado "acerto neste bloco".
- **Sem projeção persistida de resumo** — recalculado por consulta
  derivada a cada leitura, mesma decisão de simplicidade do Treino Diário/
  Mapa ENEM.
- **Sem endpoint dedicado para bloquear um item manualmente** — `blocked`
  só é alcançado pelo caminho defensivo do `start` (questão despublicada
  entre apply e start).

## Política de testes desta sprint

Seguindo a seção 2 da ordem: durante o desenvolvimento e as correções
desta rodada, só os arquivos/fluxos diretamente impactados foram
executados —

- `worker/testing/simulationRules.test.ts` (algoritmo puro);
- `worker/testing/migration0017.test.ts` (SQL real da migration);
- `worker/testing/simulations.test.ts` (serviço/rota, contra
  `FakeD1Database`);
- `worker/testing/simulationsAtomicity.test.ts` (concorrência, falhas
  forçadas, auditoria só em mutação real);
- `e2e/simulations.spec.ts` e `e2e/dailyTraining.spec.ts` (esta última
  reexecutada por completo pois `DashboardPage.tsx`/`App.tsx`, arquivos
  compartilhados, foram tocados — confirma ausência de regressão), mais
  `evidence/sprint-12-screenshots.spec.ts` (Playwright, rodadas únicas).

`npm run build` (que inclui `tsc -b`) foi executado como efeito colateral
necessário para levantar o servidor local do Playwright (`webServer` do
`playwright.config.ts`) — não como uma rodada de regressão independente —
e não reportou nenhum erro de tipo. Nenhum `npx tsc -b`/`npm run
worker:check` isolado, `npx eslint .`, `npx vitest run` completo ou `npm
run test:e2e` completo foi executado nesta rodada — reservados para a
rodada única de fechamento definitivo, exatamente como as Sprints
anteriores.

## Correção PO v1.1

Ordem de correção sobre o v1.0 acima, com dois achados confirmados por
leitura direta do código e corrigidos:

**1) `applyBlock` usava igualdade de CONTEÚDO como heurística de retry, não
identidade de mutação.** A checagem original comparava só
`block_type`/`primary_pattern_id`/`planned_item_count` do bloco `active`
já existente contra o pedido atual — nunca referenciava `input.mutationId`.
Duas requisições genuinamente diferentes que pedissem, por coincidência, o
mesmo tipo/padrão/tamanho eram indistinguíveis de um retry legítimo da
MESMA requisição. Corrigido em `classifyActiveBlockCollision`
(`worker/src/services/simulationsService.ts`): a identidade
(`existingActive.last_mutation_id === input.mutationId`) decide primeiro;
só então a configuração desempata entre "retry idempotente real" e "409 por
identidade reaproveitada para outra operação" — ver "Preview × apply"
acima para o contrato completo. Mesma correção aplicada ao caminho de
corrida (`catch` do `db.batch()`).

**2) `syncItem`/`skipItem` não tratavam a colisão da PK global de
`simulation_block_events` como um 409 controlado (faltava o `if` que
`startItem` já tinha); `completeBlock`/`abandonBlock` nem tinham
`try/catch` ao redor do `db.batch()`.** Em ambos os casos, reaproveitar um
`mutationId` já consumido por uma mutação de OUTRO item/bloco deste aluno
(fora do escopo que a checagem proativa de cada função já cobria)
resultava numa exceção crua escapando para o chamador em vez de um 409
controlado. Corrigido nas quatro funções, mesmo padrão de
`handleAssociationFailure` de `startItem`. Provado diretamente contra o
banco em `worker/testing/simulationsAtomicity.test.ts`, descrição
"reaproveitar mutationId de OUTRA operação real".

**3) Sync automático ao carregar a tela** — auditado, não reescrito (ver
seção "Sync automático ao carregar a tela" acima). Comportamento já seguro
(idempotente, nunca conclui uma tentativa que não está genuinamente
`completed`), agora documentado honestamente como mutação e coberto por
prova de rede+banco dedicada.

**4) `GET /current`** — as cinco propriedades exigidas (só devolve o bloco
`active`; um bloco `completed`/`abandoned` nunca reaparece; histórico é
responsável pelos terminais; refresh durante um bloco ativo retoma o
MESMO bloco; a tela de resultado é alcançada via `blockId` direto sem criar
nada novo) já valiam na v1.0 e foram reconfirmadas com testes dedicados —
nenhuma mudança de comportamento necessária, `getCurrent` sempre consultou
só `status = 'active'`.

### Testes desta rodada de correção

- `worker/testing/simulations.test.ts` — testes NOVOS: identidade de
  `mutationId` em `applyBlock` (retry real vs. `activeElsewhere` vs. 409),
  significado de `current` (5 propriedades), GET somente leitura por
  endpoint com contagem de linhas por tabela (preview/current/:blockId/
  history); um teste PRÉ-EXISTENTE corrigido (encodava a heurística de
  conteúdo como comportamento esperado).
- `worker/testing/simulationsAtomicity.test.ts` — testes NOVOS: as 3
  corridas de `applyBlock` por identidade de mutação (mutationIds
  diferentes/iguais-mesma-operação/iguais-operação-diferente), colisão de
  `mutationId` entre operações diferentes em `syncItem`/`skipItem`/
  `completeBlock`/`abandonBlock`; um teste PRÉ-EXISTENTE corrigido (mesma
  razão).
- `e2e/simulations.spec.ts` — 2 cenários NOVOS (sync automático,
  inspeção de rede + efeito no banco), executados isoladamente via
  `--grep`, nunca a suíte completa.
- `npm run worker:check` — limpo (revelou e corrigiu, de passagem, um erro
  de tipo pré-existente em `startItem`: `item` perdia o estreitamento de
  fluxo dentro das funções aninhadas `buildAssociationStatements`/
  `handleAssociationFailure`; capturado num `const` com tipo declarado
  não-nulo).
- `npx eslint` nos arquivos alterados — limpo.
- `git diff --check` — sem conflitos de whitespace.

Full Vitest, full Playwright, `npm ci` e telas/capturas não foram
executados nesta rodada (reservados para o fechamento definitivo), por
instrução explícita da ordem de correção v1.1.
