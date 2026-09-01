# Caderno de Erros e Revisão Espaçada — Sprint 9 v1.0

## Escopo desta entrega

Esta é a primeira versão técnica do Caderno de Erros e da Revisão Espaçada,
descritos no Prompt_Sprint_9_Caderno_Erros_Revisao_Espacada_v1.0.md. Este
documento cobre backend E frontend: migration 0014, o mecanismo de
atomicidade (registro automático + conclusão de revisão), o algoritmo
provisório de revisão espaçada, a seleção determinística de questão
semelhante, os 6 endpoints, autorização/privacidade, eventos de auditoria,
a tela `/caderno-de-erros` (lista e detalhes), as integrações com
Player/Dashboard, `worker/testing/errorNotebook.test.ts`,
`e2e/errorNotebook.spec.ts` e `evidence/sprint-09-screenshots.spec.ts`.

**Histórico de entrega**: o backend (migration, atomicidade, serviço,
rotas, testes diretos) foi entregue numa primeira rodada; frontend,
integrações, E2E e evidências visuais foram completados numa rodada de
continuação — mesmo padrão em duas etapas já usado na Sprint 8.

## Schema — migration 0014

`migrations/0014_error_notebook_spaced_review.sql` é aditiva sobre o schema
das Sprints 1-8 (0001-0013): só `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`
mais um único `ALTER TABLE ADD COLUMN` (mesmo precedente de
`migrations/0012_editorial_mutation_identity.sql`, que adicionou
`questions.last_mutation_id` da mesma forma). Nenhuma migration anterior foi
editada.

### `error_notebook_entries`

Uma linha por `(user_id, original_question_id)` — imposto por índice único
(`idx_error_notebook_entries_user_question`). Como as duas colunas são
`NOT NULL` sempre, a unicidade é segura quanto a `NULL` por construção (nunca
há uma linha com `NULL` em nenhuma das duas para o SQLite tratar como
"distinta por acidente"). Campos: `id`, `user_id`, `original_question_id`,
`original_attempt_id`, `latest_attempt_id`, `primary_pattern_id` (nulável —
uma questão pode não ter padrão principal cadastrado), `error_type` (enum
fechado, default `unclassified`), `student_note` (texto livre opcional),
`status` (enum fechado), `error_count` (`CHECK >= 1`), `review_stage`
(`CHECK >= 0`), `distinct_review_questions_succeeded` (`CHECK >= 0`),
`first_error_at`/`last_error_at`/`last_reviewed_at`/`next_review_at`/
`corrected_at`, `version` (concorrência otimista), `last_mutation_id`
(identidade da mutação — ver "Atomicidade" abaixo), `created_at`/`updated_at`.

Índices: `user_id`, `status`, `next_review_at`, `primary_pattern_id` — todos
declarados para os filtros da seção 9.1 da ordem.

### Tipos de erro (`error_type`)

`unclassified` (default), `pattern_not_recognized`, `wrong_pattern`,
`inadequate_strategy`, `interpretation`, `content_or_base`, `calculation`,
`haste`, `time_shortage`, `marking_error`. O tipo personalizado por professor
fica fora desta sprint (não existe enum nem coluna para isso ainda).

### Status (`status`)

`pending_understanding`, `scheduled`, `due`, `in_review`, `corrected`,
`archived` — todos aceitos pelo `CHECK`. **Decisão de projeto importante**:
`due` nunca é *gravado* pelo código de produção — é sempre *derivado* em
tempo de leitura (`status = 'scheduled' AND next_review_at <= agora`, ver
`errorNotebookRepository.ts:listEntries`/`summaryForUser` e
`errorNotebookService.ts:effectiveStatus`). O `CHECK` aceita o valor
literal `'due'` só para o schema ficar coerente com a lista da ordem e para
não impedir uma futura escrita explícita se um job em segundo plano vier a
existir; hoje este projeto não tem nenhuma infraestrutura de cron/fila, então
gravar `due` de fato exigiria um mecanismo que não existe — calcular na
leitura é a opção correta e mais simples agora.

### `error_review_events`

Append-only, histórico pedagógico próprio (nunca substituído por
`audit_log`). `id` é a identidade da mutação (mesma convenção "NEW.id É o
mutationId" de `migrations/0012`/`0013`). Campos: `entry_id`, `user_id`,
`attempt_id`, `reviewed_question_id`, `result` (`correct`/`incorrect`),
`previous_stage`/`resulting_stage`, `previous_next_review_at`/
`resulting_next_review_at`, `used_different_question` (0/1), `created_at`.
Índice único `idx_error_review_events_attempt_unique` em `attempt_id` —
uma tentativa de revisão confirmada só pode gerar UM evento, para sempre.

### Ligação aditiva da tentativa (`question_attempts.error_entry_id`)

`ALTER TABLE question_attempts ADD COLUMN error_entry_id TEXT REFERENCES
error_notebook_entries (id)` — nulável, sem reescrever a tabela nem o `CHECK`
de `mode` (a ordem, seção 4.5, proíbe explicitamente essa reescrita). Índice
`idx_question_attempts_error_entry` e um índice único **parcial**
`idx_question_attempts_one_active_review_per_entry` em `error_entry_id`
`WHERE error_entry_id IS NOT NULL AND status = 'in_progress'` — garante no
banco que só existe UMA revisão em andamento por entrada.

#### Distinção técnica "modo x apresentação"

O Player **continua persistindo `mode = 'practice'`** tecnicamente em toda
tentativa de revisão — nenhum novo valor foi adicionado ao `CHECK` de
`question_attempts.mode`. É a presença de `error_entry_id` (não nulo) que diz
à interface para apresentar a tela como **"Revisão"** em vez de "Prática".
Backend e frontend nunca confundem os dois conceitos: `mode` é um detalhe de
persistência técnica; `error_entry_id` é o sinal semântico real de "esta
tentativa nasceu do Caderno de Erros". Um segundo campo de "contexto/origem"
não foi necessário — `error_entry_id` sozinho já é suficiente e inequívoco.

## Fonte transacional do erro — por que não existe endpoint de conclusão

A confirmação de resposta do Player (`POST /api/player/attempts/:id/confirm`,
`worker/src/services/playerService.ts:confirmAnswer`) é a ÚNICA fonte
transacional tanto para o registro automático do erro quanto para a
conclusão de revisão — nenhum endpoint separado de "concluir revisão" foi
criado (seção 9 da ordem: "não criar endpoint de conclusão separado se a
confirmação do Player já for a fonte transacional correta" — ela é).

## Atomicidade — o que aborta a transação antes do commit

Esta seção não faz alegação nenhuma sem apontar o mecanismo exato, por
instrução explícita da ordem.

### Mecanismo herdado (Sprint 8, já existente)

`migrations/0013` já garante, via `trg_question_answer_events_require_attempt_identity`,
que todo `INSERT` em `question_answer_events` só sobrevive se
`question_attempts.last_mutation_id = NEW.id` no MESMO instante — ou seja,
que o evento 'confirmed' e o UPDATE central da tentativa são sempre a MESMA
coisa. Esta sprint herda essa garantia sem alterá-la.

### Registro automático (seção 5.1) — `trg_question_answer_events_require_error_entry`

```sql
CREATE TRIGGER trg_question_answer_events_require_error_entry
AFTER INSERT ON question_answer_events
FOR EACH ROW
WHEN NEW.event_type = 'confirmed'
BEGIN
  SELECT CASE
    WHEN (
      EXISTS (SELECT 1 FROM question_attempts
              WHERE id = NEW.attempt_id AND last_mutation_id = NEW.id
                AND is_correct = 0 AND error_entry_id IS NULL)
    ) AND NOT EXISTS (SELECT 1 FROM error_notebook_entries WHERE last_mutation_id = NEW.id)
    THEN RAISE(ABORT, '...')
  END;
END;
```

Quando o Worker confirma uma resposta ERRADA numa tentativa que NÃO é uma
revisão, `playerService.ts:confirmAnswer` inclui, no MESMO array passado a
`db.batch()`, um `INSERT`/`UPDATE` incondicional em `error_notebook_entries`
(`buildCreateEntryStatement`/`buildIncrementEntryStatement`,
`errorNotebookRepository.ts`) carimbado com `last_mutation_id = mutationId`
— o MESMO id usado como `question_answer_events.id`. Ordem dos statements no
lote: UPDATE central de `question_attempts` **primeiro**, statement(s) do
Caderno **no meio**, `INSERT` do evento 'confirmed' **por último** — para
que, quando o trigger acima dispara (depois do `INSERT` do evento), tanto o
núcleo quanto a entrada do Caderno já reflitam o resultado real desta
mutação específica. Se a entrada não existir com essa identidade exata
— porque o `UPDATE`/`INSERT` do Caderno falhou (conflito de versão numa
entrada existente, ou qualquer outro motivo) — `RAISE(ABORT)` reverte a
transação INTEIRA: o evento que acabou de ser inserido, e também o `UPDATE`
central que "já tinha sucedido" segundos antes, dentro da MESMA transação
ainda não commitada.

### Conclusão de revisão (seção 8.3) — `trg_question_answer_events_require_review_completion`

Mesmo mecanismo, espelhado: quando a tentativa confirmada É uma revisão
(`error_entry_id IS NOT NULL` — correta ou incorreta, os dois casos exigem
registro), o lote inclui `buildCompleteReviewEntryStatement` (atualiza
estágio/status/próxima revisão da entrada) MAIS
`buildReviewEventInsertStatement` (grava o `error_review_events`, id =
mutationId). O trigger exige que AMBOS existam com a identidade exata antes
de aceitar o `INSERT` do evento 'confirmed'; se faltar qualquer um dos dois,
aborta tudo.

### Por que nenhum código de produção confia em `meta.changes` pós-`batch()`

`playerService.ts:confirmAnswer` chama `db.batch()` dentro de um
`try/catch`. Em operação normal (sem corrida, sem falha), o `batch()` nunca
lança — os dois triggers acima simplesmente não encontram divergência. O
`catch` só é alcançado quando ALGO divergiu (corrida real, falha genuína de
SQL, `RAISE(ABORT)`) — nesse ponto, o código relê o estado ATUAL do banco
(já garantidamente consistente, porque nada parcial foi commitado) e decide
entre três resultados: sucesso idempotente (o resultado já reflete o que
esta chamada pediria — corrida legítima, a vencedora já fez o trabalho),
conflito 409 retentável (versão desatualizada, ou uma corrida real na
CRIAÇÃO da entrada — ver `isUniqueErrorNotebookEntryViolation`), ou
relançamento do erro original quando NADA explica a divergência por corrida
(`after.version === expectedVersion` — ningum mais mexeu nesta tentativa
específica, então só pode ser uma falha genuína, nunca disfarçada de 409).

### Corrida na criação da entrada — um caso específico

Duas confirmações erradas concorrentes em tentativas DIFERENTES (ex.: dois
modos na mesma questão) podem ambas ler "a entrada ainda não existe" antes
de qualquer uma commitar. A perdedora do `INSERT` real bate no índice único
`(user_id, original_question_id)` — um erro SQL genuíno, mas que representa
uma corrida LEGÍTIMA entre duas confirmações reais, não uma corrupção.
`isUniqueErrorNotebookEntryViolation` (mesma técnica de
`isUniqueActiveAttemptViolation`, usada desde a Sprint 4 para criação de
tentativa) reconhece esse padrão específico e devolve conflito retentável em
vez de relançar — provado por
`worker/testing/errorNotebook.test.ts`, "corrida real: duas confirmações
erradas concorrentes".

### Provas diretas no banco (não só pela resposta HTTP)

`worker/testing/errorNotebook.test.ts` cobre, sempre consultando SQLite
diretamente depois de cada cenário: criação da primeira entrada; incremento
sem duplicar; confirmação correta comum não tocando o Caderno; falha SQL
forçada revertendo TANTO a confirmação quanto o evento do Player (nenhuma
entrada órfã); corrida real produzindo exatamente uma entrada consolidada;
retry sem duplicar; isolamento por usuário (404); auditoria só em mutação
real — e o espelho completo dessas mesmas provas para conclusão de revisão
(evento de revisão único, reversão completa em falha, corrida, retry).

## Algoritmo provisório de revisão espaçada (seção 6)

Centralizado em `worker/src/lib/spacedReview.ts` — **nada aqui é decisão
pedagógica definitiva**; é uma regra técnica provisória, isolada num único
módulo, fácil de substituir quando a Andreia validar os intervalos.

| Situação | Próxima revisão |
|---|---:|
| Erro original ou revisão incorreta | +1 dia |
| 1ª revisão correta | +3 dias |
| 2ª revisão correta | +7 dias |
| 3ª revisão correta | +14 dias |
| Confirmação posterior (estágio 4+) | +30 dias |

`computeNextReviewSchedule(previousStage, result, now)` calcula a partir do
timestamp EFETIVO do evento (`clock.now()`, nunca `new Date()` direto nem
qualquer valor do corpo da requisição/relógio do navegador) — reaproveita o
MESMO `Clock` injetável já adotado desde a Sprint 5
(`scheduleService.ts:Clock`/`systemClock`), nunca um novo tipo de relógio.
Resposta incorreta em revisão sempre volta o estágio para 0 e agenda +1 dia
— nunca decrementa gradualmente.

### Critério provisório de "outro contexto" (seção 6.1)

Também centralizado e provisório: `MIN_CORRECT_REVIEWS_FOR_CORRECTED = 2`,
`MIN_DISTINCT_QUESTIONS_FOR_CORRECTED = 2`,
`meetsCorrectionCriteria({ totalCorrectReviews, distinctQuestionsSucceeded,
hasSuccessOnDifferentQuestion })`. `status = 'corrected'` exige as TRÊS
condições simultaneamente: pelo menos 2 revisões corretas, pelo menos 2
questões distintas com sucesso, e pelo menos UMA dessas distintas diferente
da questão original. Nunca considera corrigido por acertar a mesma questão
uma única vez, nem por repetir só a mesma questão semelhante indefinidamente.

Se não houver questão diferente disponível, a entrada permanece ativa
(`status` nunca vira `corrected` só por decreto) e a leitura expõe
honestamente `stillNeedsDifferentContext: true`
(`errorNotebookService.ts:getEntryDetail`) — nunca finge uma correção que
não foi comprovada em outro contexto.

## Seleção determinística de questão semelhante (seção 7)

`errorNotebookRepository.ts:selectSimilarQuestion` — nunca `ORDER BY
RANDOM()`, sempre `ORDER BY q.code ASC` (mesmo critério de
`questionRepository.ts:findTrainableQuestionForPattern`). Quatro camadas, na
ordem, cada uma retornando um `reason` explicando a escolha:

1. `same_pattern_excluding_used` — mesmo padrão principal, publicada,
   excluindo a original E as questões já usadas COM SUCESSO nesta entrada —
   uma questão semelhante genuinamente nova.
2. `original_not_yet_succeeded` — se a camada 1 não encontrar nada, e a
   questão ORIGINAL em si ainda não tiver sido usada com sucesso nesta
   entrada, ela é oferecida diretamente. Existe especificamente para que o
   critério de "2 questões distintas" (seção 6.1) consiga avançar mesmo
   quando só existe UMA questão semelhante publicada — sem esta camada, o
   aluno ficaria preso revisando repetidamente a mesma questão semelhante
   para sempre, sem nunca conseguir uma segunda questão distinta bem-sucedida.
3. `same_pattern_including_used` — mesmo padrão, publicada, excluindo só a
   original (reaproveitar uma semelhante já resolvida corretamente é melhor
   que só sobrar a original de novo).
4. `original_fallback_no_alternative` (ou `original_fallback_no_pattern`,
   quando a entrada nem tem padrão principal cadastrado) — fallback final,
   sempre existe.

Nunca revela rascunho nem questão de outro contexto editorial — todo filtro
exige `editorial_status = 'published'`.

## Endpoints (seção 9)

| Método | Caminho | Leitura/Escrita |
|---|---|---|
| GET | `/api/error-notebook` | somente leitura |
| GET | `/api/error-notebook/summary` | somente leitura |
| GET | `/api/error-notebook/:id` | somente leitura |
| PATCH | `/api/error-notebook/:id` | escrita |
| POST | `/api/error-notebook/:id/start-review` | escrita |
| POST | `/api/error-notebook/:id/archive` | escrita |

Exatamente os 6 listados — nenhum endpoint de conclusão separado (ver acima).

### GET da lista

Filtros combinados por AND: `patternId`, `errorType`, `status`, `overdue`
(vencida, derivado em tempo de consulta), intervalo de datas
(`from`/`to` sobre `next_review_at`), `includeArchived`. Paginação
determinística (`limit`/`offset`, ordenação `next_review_at ASC, id ASC`).
Busca por texto **não foi implementada** nesta versão — a ordem permite isso
explicitamente ("texto somente se puder ser implementado sem vazar conteúdo
e sem busca insegura"); implementar buscando dentro de `student_note` (dado
pessoal) ou do enunciado da questão original exigiria decisões de segurança
e indexação fora do escopo desta rodada, então foi conscientemente adiada.

### PATCH

Só `errorType`, `studentNote`, `expectedVersion`, `mutationId`. PATCH parcial
real (`errorNotebookService.ts:patchEntry`): corpo vazio → 400; `null` em
`studentNote` limpa; `null` em `errorType` → 400 (não pode ser removido, só
trocado); no-op (mesmo conteúdo) → `changed:false`, zero escrita; retry do
MESMO `mutationId` → idempotente; reusar o mesmo `mutationId` para conteúdo
DIFERENTE → 409 (colisão); versão obsoleta → 409.

### Archive

Idempotente, exige `expectedVersion`/`mutationId`, nunca apaga histórico (só
muda `status` para `archived`), some da listagem por padrão, aparece com
`includeArchived=true`.

## Autorização e privacidade (seção 10)

Toda consulta/mutação do `errorNotebookRepository.ts`/`errorNotebookService.ts`
recebe `userId` e escopa no SQL (`WHERE user_id = ?`) — nunca só na camada
de aplicação. Sem sessão → 401. Entrada inexistente OU de outro aluno → 404
IDÊNTICO (nunca 403 — mesmo padrão do Player desde a Sprint 8, não confirma
a existência do recurso alheio). `user_id`/papel/propriedade NUNCA aceitos
do cliente — sempre derivados da sessão validada no Worker.

A anotação do aluno (`student_note`) é texto livre, opcional, pode conter
dado pessoal. Nunca aparece em URL/query string (só vai no corpo do PATCH,
nunca em `GET` nem em parâmetro de rota), nunca em `audit_log`
(auditoria só grava `entryId`/`attemptId`, nunca o conteúdo do PATCH — ver
`routes/errorNotebook.ts`), nunca em logs/mensagens de erro, e nunca é usada
como chave de idempotência (essa chave é sempre `mutationId`, uma coluna
técnica separada — comparações de PATCH usam o TEXTO atual vs pedido, nunca
o `mutationId` para decidir se o conteúdo é igual). Texto hostil (HTML,
script, SQL literal) é tratado sempre como DADO — nunca rejeitado por
conteúdo, só truncado por tamanho (`errorNotebookValidation.ts`); nenhum
`dangerouslySetInnerHTML` é usado (a validar quando o frontend for
construído).

**Aviso obrigatório** (a ser exibido junto ao campo de anotação no
frontend, ainda não construído nesta rodada):

> Opcional. Registre somente o necessário para lembrar o que aprendeu. Sua
> anotação não aparece em URL, logs ou auditoria.

## Eventos de auditoria (seção 11)

`error_notebook_entry_created`, `error_notebook_entry_updated`,
`error_notebook_review_started`, `error_notebook_review_completed`,
`error_notebook_entry_corrected`, `error_notebook_entry_archived` — os 6
adicionados a `worker/src/repositories/auditRepository.ts:AuditEventType`.
Gravados só em mutação REAL (nunca retry/no-op): a rota
(`worker/src/routes/player.ts`, bloco de confirmação) só audita os eventos
do Caderno quando `confirmAnswer` devolve `notebookOutcome` preenchido, o
que só acontece quando o `db.batch()` da confirmação de fato escreveu algo
novo nesta chamada. Metadata mínima: IDs técnicos (`entryId`, `attemptId`,
`reviewedQuestionId`), nunca nota/resposta marcada/texto de
reconhecimento/comentário livre.

## Testes (seção 15)

`worker/testing/errorNotebook.test.ts` — 36 testes, cobrindo:

- **Schema** (7 testes): unicidade por usuário+questão, `CHECK`s de
  `error_count`/`error_type`/`status`/`result`, índice único de
  `error_review_events.attempt_id`, coluna aditiva `error_entry_id`, índice
  único parcial de uma revisão ativa por entrada.
- **Registro automático e atomicidade** (9 testes — seção 15.2 completa):
  criação, incremento sem duplicar, correta comum não altera, falha SQL
  reverte tudo, tentativa inexistente não cria nada, corrida produz uma
  entrada consolidada, retry idempotente, isolamento 404, auditoria só em
  mutação real.
- **Classificação/anotação** (9 testes): PATCH parcial, corpo vazio, `null`
  em nota vs `errorType`, no-op, versão obsoleta, retry/colisão de
  `mutationId`, texto hostil como dado, nota ausente de auditoria.
- **Revisão** (10 testes): seleção determinística, fallback em duas
  variantes (original ainda não sucedida vs sem alternativa nenhuma), início
  idempotente, revisão correta avança estágio, incorreta reseta, duas
  corretas em questões distintas permitem `corrected`, repetir a mesma
  questão não basta, falha reverte tudo, corrida produz um evento, retry não
  duplica.
- **Arquivamento** (1 teste): idempotente, preserva histórico, filtro
  `includeArchived`.

Todos os cenários exigidos pela seção 15.2 da ordem (os nove itens
explicitamente listados) têm um teste correspondente e nomeado com o número
do item.

## Limitações conhecidas e decisões que dependem da Andreia

- **Os intervalos de revisão (+1/+3/+7/+14/+30 dias) não são uma decisão
  pedagógica definitiva** — são uma regra técnica provisória, centralizada
  em `worker/src/lib/spacedReview.ts` especificamente para ser substituível
  sem tocar no resto do sistema quando a Andreia validar os intervalos reais.
- **O critério técnico de "corrected" (2 revisões corretas, 2 questões
  distintas, 1 diferente da original) poderá mudar** após validação
  pedagógica — também centralizado, mesma razão.
- **Os três índices pedagógicos (reconhecimento/resolução/domínio) não foram
  calculados nesta sprint** — nenhuma fórmula definitiva foi implementada;
  esta sprint só persiste evidência bruta (contadores técnicos, histórico
  append-only).
- **Uma questão revista não equivale automaticamente a padrão dominado** —
  `status = 'corrected'` é um estado técnico do CADERNO DE ERROS
  especificamente (evidência de que aquele erro específico foi corrigido em
  mais de um contexto), nunca uma afirmação sobre o padrão como um todo.
- **Frontend `/caderno-de-erros`**: `src/pages/errorNotebook/ErrorNotebookListPage.tsx`
  (lista — filtros por padrão/tipo/status/data/vencida, cards, paginação,
  resumo real) e `ErrorNotebookDetailPage.tsx` (detalhes — questão original
  reaproveitando `GET /api/player/attempts/:id`, classificação editável,
  anotação com o aviso de privacidade exato da seção 10, histórico de
  revisões, "Corrigir meu erro"/"Arquivar" com modal de confirmação).
  `src/api/errorNotebookClient.ts` espelha os 6 endpoints. Estado 360px não
  foi verificado manualmente (só 390/768/1280/1440, via viewport do
  Playwright e smoke test ao vivo) — CSS fluido sem largura fixa, mesmo
  padrão de `PatternsPage.css`, então o risco é baixo, mas não foi provado
  por captura própria.
- **Integrações**: Player (`AttemptPage.tsx`) mostra "Revisão" em vez de
  "Prática" quando `attempt.errorEntryId` está presente
  (`modeLabel()`) e oferece "Voltar ao Caderno de Erros" após confirmar,
  em vez de "Voltar ao início". Dashboard (`DashboardPage.tsx`) ganhou um
  novo card real "Caderno de Erros" (erros ativos, revisões vencidas,
  corrigidos, CTA) — nenhum card mockado de erros existia antes desta
  sprint para "substituir"; este é aditivo. Nav: `/caderno-de-erros` movido
  de `PLACEHOLDER_ITEMS` para `IMPLEMENTED_NAV_PATHS` em `App.tsx` — o
  item já existia em `studentNav.ts` desde antes desta sprint, só apontava
  para um placeholder. Cronograma: nenhuma integração nova foi adicionada
  (seção 13.4 permite pular se não houver algo simples já previsto — não
  havia).
- **Evidências visuais**: as 12 screenshots existem em
  `evidence/screenshots/sprint-09/`, geradas por
  `evidence/sprint-09-screenshots.spec.ts`. `revisao-vencida.png`
  documenta a INTERAÇÃO do filtro "Só revisões vencidas" (checkbox
  marcado), não uma entrada genuinamente vencida — uma entrada recém-criada
  é sempre agendada para +1 dia (nunca vencida no instante da criação), e
  os testes não têm acesso direto ao banco para forçar uma data passada.
- **E2E**: `e2e/errorNotebook.spec.ts` (19 testes) cobre os itens da seção
  15.5: erro aparece automaticamente, filtros, classificação/nota, nunca a
  anotação na URL/requisições, iniciar revisão, resumo após refresh,
  revisão correta/incorreta, "outro contexto" (usando `fixture-q-06`),
  teclado/foco, mobile 390px, estados vazio/erro, isolamento entre alunos,
  Dashboard com resumo real.
- **Fixtures locais**: `scripts/fixtures/questions-fixtures.local.sql` ganhou
  uma sexta questão (`fixture-q-06`, publicada, mesmo padrão principal de
  `fixture-q-04`) especificamente para permitir demonstrar/testar a seleção
  de questão semelhante e o critério de "outro contexto" de ponta a ponta.
  Os demais cenários pedidos pela seção 14 (erro vencido, erro futuro,
  entrada corrigida) são produzidos naturalmente pelo uso normal do sistema
  com as fixtures existentes — nenhum dado adicional foi necessário para
  esses.
- **Busca por texto no filtro da lista** não foi implementada (ver seção
  "Endpoints" acima) — decisão consciente, não uma omissão.
- **Reativação automática de entrada `corrected`/`archived`**: um novo erro
  na mesma questão original reativa a entrada (`status` volta para
  `scheduled`, `review_stage` reseta para 0, `corrected_at` é limpo) — uma
  nova ocorrência independente do mesmo erro é tratada como evidência que
  sobrepõe tanto uma correção quanto um arquivamento anteriores. Esta é uma
  decisão de projeto explícita desta implementação, documentada aqui para
  auditoria — não estava especificada literalmente na ordem.
