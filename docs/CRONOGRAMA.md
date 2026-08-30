# Cronograma Adaptativo — Sprint 5 v1.0

Motor técnico do cronograma adaptativo (Documento Mestre, seção 11). Esta
sprint entrega o **motor de agenda** — visualizações, tipos e estados de
atividade, capacidade e reagendamento, fuso horário determinístico — nunca a
priorização pedagógica definitiva. O banco de questões real, os três índices
pedagógicos e o plano adaptativo continuam pendentes.

## Separação entre motor técnico e priorização pedagógica

O planejador (`computePlan`/`computeRescheduleTarget` em
`worker/src/services/scheduleService.ts`) só enxerga três variáveis já
aprovadas no onboarding: dias disponíveis, minutos disponíveis por dia e a
lista de atividades pendentes (com sua estimativa de tempo). Ele **nunca**
decide *quais* atividades existem, nem sua ordem de importância pedagógica —
só *quando* uma atividade já definida cabe na agenda.

Para desenvolver e testar o motor, 12 atividades técnicas fictícias (uma por
tipo da seção 11.2) vivem em `scripts/fixtures/schedule-fixtures.local.sql`,
marcadas em código e na interface como `CONTEÚDO TÉCNICO PROVISÓRIO — NÃO
PUBLICAR`. Cada explicação (`explanation`) de fixture diz explicitamente que
é "demonstração técnica baseada somente na disponibilidade configurada" —
nunca menciona domínio, déficit, padrão prioritário ou qualquer inferência
pedagógica (seção 2 da ordem, testado em `worker/testing/schedule.test.ts`,
describe "ausência de regra pedagógica definitiva").

Diferente das questões do diagnóstico (globais, sem dono até o aluno clicar
"Começar"), uma atividade de cronograma só faz sentido já atribuída a um
aluno — mas, corrigido na v1.1, **nenhum `GET` cria essa atribuição**. A
definição global da fixture já existe (inserida só pelo script local
explícito); a atribuição concreta ao usuário só nasce quando ele mesmo
aciona `POST /plan/preview` seguido de `POST /plan/apply` — nunca como
efeito colateral de abrir uma página ou chamar o resumo. `previewPlan()`
(`worker/src/services/scheduleService.ts:listUnassignedFixtureActivities`)
descobre, só por leitura, quais fixtures este usuário ainda não tem em
nenhuma atribuição; `applyPlan()` é o único lugar do código que efetivamente
insere essas linhas. Um usuário novo, sem plano aplicado, vê resumo e agenda
genuinamente vazios — testado explicitamente que `GET` repetido nunca altera
contagem de linhas nem gera auditoria (`worker/testing/schedule.test.ts`,
describe "GET é somente leitura").

## Schema — migration 0006

Aditiva (`CREATE TABLE/INDEX IF NOT EXISTS`), sem alterar nenhuma tabela das
Sprints 1–4.

| Tabela | Papel |
| --- | --- |
| `schedule_activities` | definição de uma atividade (tipo, título, objetivo, estimativa, critério de conclusão, explicação, modo de conclusão, origem, se é dispensável, se é fixture local) |
| `schedule_activity_assignments` | atribuição concreta a um aluno numa data planejada (ou `NULL` = pendente/sem data); `status` é o estado **persistido**; controle de concorrência via `version` |
| `schedule_activity_events` | histórico imutável (append-only) de transições |
| `schedule_preferences` | fuso horário (IANA) configurado pelo aluno |
| `schedule_plan_previews` | prévias de plano com prazo de validade, usadas por `POST /plan/preview` + `POST /plan/apply` |

Migration 0005 (Sprint 4) não foi tocada.

**Descrição precisa do índice de slot diário** (correção v1.1, seção 5 —
a v1.0 descrevia isso de forma imprecisa): `idx_schedule_assignments_user_date_position`,
em `(user_id, planned_date, position) WHERE planned_date IS NOT NULL`,
garante que **um slot/posição do dia** — a combinação (aluno, data, posição)
— nunca é ocupado por duas linhas ao mesmo tempo. **Não** é uma restrição
contra reutilizar a mesma *definição* de atividade (`activity_id`) em
posições/dias distintos — de propósito: uma definição (ex.: "revisão
espaçada") poderá gerar várias atribuições recorrentes no futuro, e nenhuma
constraint desta sprint proíbe isso (`UNIQUE(user_id, activity_id,
planned_date)` seria excessiva e foi deliberadamente **não** adicionada).
Cada atribuição individual (linha) sempre tem, se tiver data, exatamente uma
`planned_date`/`position` — nunca duas, porque são colunas da própria linha,
não uma relação separada. Pendentes (`planned_date IS NULL`) nunca colidem
entre si nem com atribuições datadas (SQLite trata `NULL` como distinto em
índices únicos) — testado em `worker/testing/migration0006.test.ts`, e a
idempotência de `applyPlan()` (reaplicar a mesma prévia não duplica) garante
que o próprio fluxo de aplicação nunca tenta criar dois slots iguais.

**O que o schema garante sozinho** (via CHECK/UNIQUE) versus **o que só o
algoritmo garante**: o schema impede dois assignments no mesmo slot do
mesmo aluno/dia e valores de `type`/`completion_mode`/`origin`/`status` fora
do vocabulário fechado. A soma diária nunca ultrapassar a capacidade
configurada **não** é um invariante de banco (SQLite não expressa CHECK
entre linhas) — é garantido só pelo algoritmo do planejador, testado
exaustivamente em `worker/testing/schedule.test.ts`.

## Tipos, estados e matriz de transição

Os 12 tipos da seção 11.2 são um `CHECK` fechado em `schedule_activities.type`
(`diagnostico`, `reconhecimento`, `estudo_de_padrao`, `conteudo_de_base`,
`aula_video`, `treino_de_questoes`, `correcao_de_erro`, `revisao_espacada`,
`lista_do_professor`, `simulado`, `live`, `leitura_de_resumo`).

### Estado persistido × estado efetivo

Os 7 estados do Documento Mestre (`not_started`, `in_progress`, `completed`,
`overdue`, `rescheduled`, `dismissed`, `blocked`) são todos valores legais no
`CHECK` de `schedule_activity_assignments.status`, mas **`overdue` nunca é
escrito por nenhum caminho de código desta sprint**. Uma atribuição
`not_started`/`in_progress` cuja `planned_date` já passou é tratada como
efetivamente atrasada só na **leitura** (`effectiveStatus()` em
`scheduleService.ts`, comparando com "hoje" no fuso do aluno) — o estado
persistido continua `not_started`/`in_progress` até uma ação explícita
(reagendar, concluir, dispensar) mudá-lo de verdade. Isso significa:

- uma leitura `GET` nunca muta nada (testado explicitamente, seção "GET é
  somente leitura" abaixo);
- atrasos **não são empilhados automaticamente** — nenhum processo em
  background move uma atividade atrasada; só o reagendamento explícito o faz.

### Bloqueio (`blocked`) — correção v1.1

`blocked` é alcançável em runtime por uma transição real:
`POST /api/schedule/activities/:id/block` (serviço `blockAssignment()` em
`scheduleService.ts`), sob o mesmo gate local das demais rotas. Como não
existe perfil de professor/admin nesta sprint, o motivo é restrito a um
enum técnico fechado — nunca texto livre, nunca uma razão pedagógica:

- `dependency_unavailable` — pré-requisito técnico indisponível;
- `content_unavailable` — conteúdo ainda não disponível;
- `technical_unavailable` — recurso técnico indisponível no momento.

Regras: só atividade não final pode ser bloqueada; sessão e pertencimento
obrigatórios (recurso de outro usuário → 404); transição condicionada à
versão atual (mesmo mecanismo de concorrência otimista das demais); evento
`schedule_activity_blocked` só após persistência real; repetição idempotente
não duplica evento; concorrência/versão desatualizada retorna conflito
controlado; estado final não pode ser bloqueado. **A interface não oferece
um botão genérico "Bloquear" ao aluno** — a rota existe como fundação
técnica, exercitável por API/testes locais; quando uma atividade já está
`blocked` (por qualquer via), a UI só renderiza o estado e o motivo técnico
(rotulado em `src/pages/schedule/scheduleOptions.ts:BLOCK_REASON_LABELS`).

### Transições permitidas

| De | Para | Ação |
| --- | --- | --- |
| `not_started` | `in_progress` | `POST .../start` |
| `not_started`/`in_progress` | `completed` | `POST .../complete`, só se `completion_mode = manual` |
| `not_started`/`in_progress` | `rescheduled` (+ nova `not_started`) | `POST .../reschedule` |
| `not_started`/`in_progress` | `dismissed` | `POST .../dismiss`, só se `dismissible = 1` |
| `not_started`/`in_progress` | `blocked` | `POST .../block`, motivo do enum fechado |

Estados finais (`completed`, `rescheduled`, `dismissed`, `blocked`) nunca são
reabertos por nenhuma dessas rotas — testado explicitamente ("completar uma
já dispensada falha", "estado final não pode ser bloqueado").

## Capacidade e reagendamento (algoritmo técnico)

`computePlan()` e `computeRescheduleTarget()` (funções puras, sem acesso a
banco/relógio real) percorrem os próximos dias dentro do **horizonte técnico
centralizado** (`SCHEDULE_HORIZON_DAYS = 60` dias, em
`worker/src/lib/scheduleValidation.ts` — constante técnica, nunca uma regra
pedagógica) filtrados pelos dias disponíveis do aluno, e encaixam cada
atividade pendente no primeiro dia com capacidade restante suficiente
(`carga já usada + estimativa <= minutos diários configurados`). Atividade
que não couber em nenhum dia do horizonte permanece pendente (sem data) —
nunca sobrecarrega um dia além da capacidade.

Reagendamento (`computeRescheduleTarget`) usa a mesma lógica, mas busca a
partir de **amanhã** (nunca hoje, nunca uma data anterior). Sem capacidade em
todo o horizonte → `no_capacity`, e a atribuição anterior permanece
totalmente intacta (nenhuma escrita é tentada nesse caso).

Mudança de disponibilidade no perfil (dias/minutos) não apaga agenda nem
histórico — o próximo `plan/preview` simplesmente calcula a partir do estado
atual. Como o volume de recálculo automático de atribuições já existentes
está fora do escopo desta sprint, isso fica registrado como pendência (ver
"Limitações atuais") em vez de mutação automática.

## Fuso horário e data civil

"Hoje" nunca depende do relógio/fuso da máquina do servidor:
`civilDateInTimezone(instant, timezone)` formata o instante recebido (sempre
via relógio **injetável** — `Clock` em `scheduleService.ts`, produção usa
`systemClock`, testes injetam um relógio fixo) no fuso IANA configurado do
aluno (`schedule_preferences.timezone`, padrão `America/Sao_Paulo`),
retornando uma data civil `YYYY-MM-DD`. O fuso é validado
(`isValidTimezone`, via `Intl.DateTimeFormat`) antes de ser aceito em
`PATCH /api/schedule/preferences` — nunca aceita um valor arbitrário sem
checar se o runtime o reconhece. Cabeçalhos HTTP nunca são usados como
autoridade de fuso.

Testado explicitamente: virada de dia entre fusos diferentes, fim de mês,
ano bissexto (2028) e mês não bissexto (2026), e rejeição de fuso inválido.

## Gate/seed local

Mesmo padrão de falha fechada das Sprints 2–4: `ENVIRONMENT` local/test **e**
`ENABLE_LOCAL_SCHEDULE_FIXTURES=true` (exclusiva de `wrangler.local.jsonc`)
**e** hostname reconhecido como local, simultaneamente
(`isLocalScheduleFixturesAllowed` em `worker/src/env.ts`). Fora disso,
`GET /api/schedule/summary` responde `available: false` e todo outro
endpoint responde o estado "em preparação" sem tocar nas tabelas
`schedule_*`. `scripts/check-deployable-d1-config.mjs` bloqueia a flag em
`wrangler.jsonc`.

## Endpoints e autorização

Todos exigem sessão válida (401 sem ela). `GET /summary` sempre responde
(com `available` refletindo o gate); os demais respondem o estado "em
preparação" fora do gate.

**11 combinações método + caminho** (correção v1.1, seção 6 — a v1.0 chamou
essa mesma lista de "9 endpoints" de forma imprecisa: eram 9 operações de
cronograma listadas na ordem original *mais* `PATCH /preferences`, e agora
*mais* `POST /block`):

| # | Método + caminho | Papel |
| --- | --- | --- |
| 1 | `GET /api/schedule/summary` | disponibilidade, "hoje", capacidade do dia, pendências |
| 2 | `GET /api/schedule/activities?view=...` | lista por visão (`today`, `week`, `month`, `pending`, `reviews`, `assigned`, `history`) |
| 3 | `GET /api/schedule/activities/:id` | detalhe de uma atribuição do próprio usuário |
| 4 | `POST /api/schedule/activities/:id/start` | inicia (exige `version`) |
| 5 | `POST /api/schedule/activities/:id/complete` | conclui manualmente (exige `version`, só `completion_mode=manual`) |
| 6 | `POST /api/schedule/activities/:id/dismiss` | dispensa (exige `version`, só `dismissible=1`) |
| 7 | `POST /api/schedule/activities/:id/reschedule` | reagenda (exige `version`) |
| 8 | `POST /api/schedule/activities/:id/block` | bloqueia (exige `version` + motivo do enum fechado) |
| 9 | `POST /api/schedule/plan/preview` | gera prévia do plano a partir das fixtures ainda não atribuídas |
| 10 | `POST /api/schedule/plan/apply` | aplica uma prévia (`previewId`) — único ponto que cria atribuições |
| 11 | `PATCH /api/schedule/preferences` | atualiza o fuso horário |

`user_id` sempre deriva da sessão; recurso de outro usuário responde 404 sem
revelar existência (testado). Nenhum endpoint confia em duração, estado,
origem ou motivo enviados pelo cliente — tudo recalculado/validado no Worker.

## Atomicidade, idempotência, concorrência e rollbacks

Toda mutação usa `db.batch()`. Concorrência otimista via coluna `version`:
cada transição exige a versão atual esperada; o `UPDATE` é condicionado
(`WHERE ... AND version = ? AND status IN (...)`) dentro do próprio
statement — nunca uma leitura seguida de escrita separada. Depois do batch:

- `meta.changes = 1` → transição real, gera evento;
- `meta.changes = 0` e o estado já é o alvo (mesma versão+1) → repetição
  idempotente da mesma requisição, sem novo evento;
- `meta.changes = 0` e a versão não bate → **conflito** (409), nunca
  sobrescreve;
- `meta.changes = 0` e nem isso → transição inválida (400).

**Uma única tentativa ativa não se aplica ao cronograma** (isso é invariante
do diagnóstico, migration 0005) — o invariante equivalente aqui é a posição
única por dia (acima). Corrida de criação/reinício não existe no cronograma
da mesma forma que no diagnóstico, porque não há um conceito de "tentativa
ativa única"; a corrida real é **duas conclusões concorrentes da mesma
atribuição**, testada explicitamente (exatamente um evento `completed`
sobrevive) e **reagendamentos concorrentes**, onde uma violação de
constraint (posição única do dia) é capturada e tratada como conflito
controlado — nunca 500, e o lote inteiro reverte (nenhum vínculo parcial).

Testes de rollback: falha forçada no meio da criação da nova atribuição de
um reagendamento reverte também o `UPDATE` da atribuição antiga (mesmo
lote); falha forçada no meio da aplicação de um plano com múltiplas
atividades não deixa nenhuma parcialmente atualizada, nem a prévia marcada
como aplicada.

## Frontend e integração com dashboard/onboarding

`src/pages/schedule/SchedulePage.tsx` (rota `/cronograma`, item de menu
"Cronograma") — abas Hoje/Semana/Mês/Pendências/Revisões/Atribuídas/
Histórico (estado da aba — e do ano/mês da grade — na URL via
`?view=&year=&month=`, nunca dado sensível), cartões com tipo, objetivo,
duração, estado (com rótulo textual, nunca só cor) e "Por que esta
atividade?", indicador de capacidade diária, ações condicionadas às
permissões (iniciar/concluir/dispensar/reagendar), modal de confirmação de
reagendamento, prévia/aplicação de plano na aba Pendências, aviso de
conteúdo técnico provisório por atividade, `aria-live` no indicador de
salvamento. Responsivo (grid `auto-fill`, sem rolagem horizontal em
360–1440px).

### Calendário mensal real (correção v1.1)

`src/pages/schedule/MonthCalendarGrid.tsx` + `monthCalendar.ts` (função pura
`buildMonthGrid`, testada em `monthCalendar.test.ts`) substituem a lista
filtrada da v1.0 por uma grade de verdade: cabeçalho com mês/ano e navegação
anterior/seguinte, 7 colunas de dia da semana, células para todos os dias do
mês mais preenchimento de alinhamento com **dias reais** do mês
anterior/seguinte (nunca células vazias), indicação de hoje via
`aria-current="date"` **mais** texto visualmente oculto (nunca só borda/cor),
contagem de atividades por dia, seleção de um dia (célula é um `<button>`,
acessível por teclado nativamente) abrindo a lista/detalhe daquele dia
abaixo da grade, dias fora do mês distinguidos por opacidade **e** texto
visualmente oculto ("fora do mês atual").

**Convenção de interface**: a semana começa na **segunda-feira**
(`WEEK_START = "monday"` em `monthCalendar.ts`) — consistente com a ordem
seg/ter/qua/qui/sex/sab/dom já usada no onboarding. Isso é uma decisão de
interface, não uma regra pedagógica.

`buildMonthGrid`/`addMonths` são funções puras que só recebem ano/mês/dia já
resolvidos — nunca reconstroem `new Date(plannedDate)` a partir das strings
`YYYY-MM-DD` da API, então o fuso do navegador nunca desloca a data civil
planejada (a própria comparação de datas na grade é sempre por string).
Testado: fevereiro comum (2026) e bissexto (2028), mês começando numa
segunda e num domingo, virada dezembro→janeiro e janeiro→dezembro.

**Dashboard**: o card antes chamado "Treino de Hoje" (100% mock) foi
substituído por um resumo real do cronograma (minutos planejados/capacidade
do dia, contagem de pendências, link para `/cronograma`) — os demais cards
(Mapa ENEM, Maior Gargalo, Evolução da Semana) continuam mock, claramente
sinalizados no aviso do topo.

**Onboarding**: disponibilidade (`available_days`, `daily_minutes`) e
preferência de horário alimentam o planejador; nenhum outro dado do
onboarding é usado.

**Diagnóstico**: a fixture `fixture-sched-01` (tipo `diagnostico`) só existe
como atividade técnica local que aponta para o diagnóstico já
concluído/pendente — nunca usa o *resultado* do diagnóstico para priorizar
nada (proibido pela seção 2 da ordem).

**Configurações**: novo card de fuso horário (`PATCH /preferences`),
independente do formulário de onboarding.

## Eventos de auditoria

`schedule_plan_previewed`, `schedule_plan_applied`, `schedule_activity_started`,
`schedule_activity_completed`, `schedule_activity_rescheduled`,
`schedule_activity_dismissed`, `schedule_activity_blocked`,
`schedule_conflict_detected` (este último quando um reagendamento esbarra em
`no_capacity`). Metadados só com IDs internos, contagens, o estado
anterior/novo e — para bloqueio — o motivo do enum fechado quando aplicável
— nunca título, objetivo, texto de explicação ou fuso horário. Repetição
idempotente de uma transição não duplica evento (testado).

## Limitações atuais

- Conteúdo real (banco de questões, vídeos, listas do professor) ainda não
  existe — todas as atividades desta sprint são fixtures técnicas locais.
- Mudança de disponibilidade não recalcula automaticamente atribuições já
  existentes — só novo `plan/preview` considera o estado atual; detecção de
  conflito entre disponibilidade antiga/nova fica para uma sprint futura.
- Retenção/exclusão de eventos de auditoria e política de dados do
  cronograma seguem como decisões pendentes.
- Não há papel de professor/admin nesta sprint — motivos de bloqueio ficam
  restritos ao enum técnico fechado; nenhuma UI oferece bloqueio manual ao
  aluno.

## Contratos futuros

- Diagnóstico: quando os três índices pedagógicos existirem, poderão
  alimentar a priorização de atividades — não usado nesta sprint.
- Banco de questões real: quando existir, `resource_ref` poderá apontar
  para IDs reais (hoje é texto livre, sem FK, propositalmente).
- Professor/admin: `origin = 'teacher'` já existe no schema para quando a
  atribuição por professor for implementada.
- Vídeo/live: `completion_mode = 'automatic'`/`external_evidence'` já
  reservam o modelo de dados para evidência futura de conclusão.

## Decisões pedagógicas pendentes

Taxonomia de prioridade entre atividades, fórmula dos três índices,
conteúdo pedagógico real, e regras de revisão espaçada baseadas em
desempenho seguem pendentes — nada disso foi inventado nesta sprint.
