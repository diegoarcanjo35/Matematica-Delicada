# Métricas Centrais e Mapa ENEM do Aluno — Sprint 10 v1.2

## Escopo desta entrega

Primeira versão técnica do Mapa ENEM do Aluno: um painel que agrega, POR
PADRÃO ENEM, toda a evidência real já registrada nas Sprints 6-9 (Player,
Reconheça o Padrão, Caderno de Erros e Revisão Espaçada) em rótulos
descritivos e provisórios — nunca uma nota, nunca uma fórmula de domínio.
Este documento cobre backend e frontend: migration 0015, a decisão de não
persistir nenhuma projeção, as regras de rótulo provisório, o repositório de
evidência, o serviço e os 4 endpoints, autorização/privacidade, as telas
`/mapa-enem` (lista) e `/mapa-enem/:slug` (detalhe), a integração com o
Dashboard, `worker/testing/studentMetrics.test.ts`,
`e2e/studentMetrics.spec.ts` e `evidence/sprint-10-screenshots.spec.ts`.

**v1.1 (esta revisão) — correção de auditoria da PO em cima da v1.0.** A PO
rejeitou a v1.0 por três motivos principais: (1) `consistente_no_recorte`
dependia só de taxa de acerto bruta + diversidade de questão, ignorando
repetição em momentos diferentes, dependência de ajuda e revisão espaçada;
(2) o isolamento padrão principal × secundário estava correto no código mas
não estava testado/documentado como REGRA explícita e permanente; (3) o
recorte de 14 dias no frontend usava `Date.now()` direto, sem relógio
injetável, e portanto não era testável de forma determinística. As três
seções abaixo ("Os cinco estados provisórios", "Padrão PRINCIPAL x
SECUNDÁRIO" e "O recorte de prática recente (14 dias)") documentam a
correção de cada um. Nenhuma migration foi alterada ou criada nesta rodada
— só código (regra, repositório, serviço, frontend) e testes.

**v1.2 (esta revisão) — segunda correção de auditoria da PO, agora em cima
da v1.1.** A v1.1 exigia `hasCorrectReview` como critério ISOLADO e
obrigatório para `consistente_no_recorte` — mas revisão espaçada só nasce
do Caderno de Erros, que só nasce de um erro confirmado. Um aluno que
NUNCA erra, por mais prática distinta e multi-sessão que acumule, nunca
gera revisão nenhuma e ficava PRESO para sempre em `em_desenvolvimento`. A
v1.1 documentou isso como "limitação conhecida", mas a PO pediu correção
ESTRUTURAL desta vez, não só o registro do limite. Ver a seção
"`deriveProvisionalState` — ordem de avaliação" abaixo para o novo critério
`hasMaintenanceEvidence`. Nenhuma migration foi alterada ou criada nesta
rodada — só `worker/src/lib/studentMetricsRules.ts`,
`worker/src/repositories/studentMetricsRepository.ts` (um novo campo
`firstConfirmedAt`, mesma consulta de agregação já existente, nenhuma
consulta nova), `worker/src/services/studentMetricsService.ts` (repassa o
novo campo) e testes.

## Por que não existe uma tabela de projeção persistida

`migrations/0015_student_metrics_map.sql` é puramente aditiva sobre o schema
das Sprints 1-9 (0001-0014) e **não cria nenhuma tabela nova**. O Mapa ENEM e
o resumo do Dashboard são calculados por CONSULTAS DERIVADAS, em tempo de
leitura, diretamente sobre `question_attempts`, `question_recognition_events`,
`question_help_events`, `error_notebook_entries`, `error_review_events` e
`question_patterns` — todas já existentes desde as Sprints 6-9.

Uma tabela de projeção persistida exigiria toda a disciplina de
atomicidade/idempotência/rebuild já usada pelo Caderno de Erros (triggers,
identidade de mutação, reconstrução determinística — ver
`docs/CADERNO_ERROS_REVISAO.md`) para um ganho de performance que, no volume
de dados desta fase do projeto (fixtures locais, poucas dezenas de linhas por
tabela), não se justifica. Ler direto das tabelas de evidência é, por
construção, sempre exatamente consistente com a fonte de verdade — nunca
"dessincroniza" de um jeito que uma projeção perene poderia. Se o volume real
de produção um dia exigir cache, isso fica documentado aqui como decisão
pendente futura, não como algo já necessário agora.

Consequência direta: **não existe endpoint `POST /rebuild`**. Dos 5 endpoints
possíveis descritos na ordem, só os 4 GET foram implementados — não há
projeção persistida para reconstruir.

Migration 0015 só adiciona dois índices que as consultas de agregação
realmente exercitam e que ainda não existiam:

- `idx_question_attempts_user_status` em `question_attempts (user_id,
  status)` — toda consulta de métricas filtra por aluno e por tentativas
  `completed` (as únicas que podem contar como acerto/erro confirmado).
- `idx_error_notebook_entries_user_status_review` em
  `error_notebook_entries (user_id, status, next_review_at)` — a consulta de
  "revisão pendente" filtra e ordena pelas três colunas juntas.

## Regras técnicas provisórias (`worker/src/lib/studentMetricsRules.ts`)

Centralizadas num único módulo, exatamente como `spacedReview.ts` fez para a
revisão espaçada — nada aqui é fórmula pedagógica definitiva de
reconhecimento, resolução ou domínio, nem validada pela Andréia. São rótulos
DESCRITIVOS derivados de contadores brutos reais, ajustáveis no futuro sem
qualquer migration destrutiva (recalculados sempre na leitura, nunca
gravados com o rótulo).

### Os cinco estados provisórios

| Estado | Rótulo exibido |
|---|---|
| `sem_evidencias` | Ainda sem evidências suficientes |
| `evidencias_iniciais` | Evidências iniciais |
| `em_desenvolvimento` | Em desenvolvimento |
| `consistente_no_recorte` | Consistente neste recorte |
| `revisao_pendente` | Revisão pendente |

Nenhum rótulo usa a palavra "dominado" como conclusão — verificado
diretamente por teste (`worker/testing/studentMetrics.test.ts`, "rótulos
provisórios").

### `deriveProvisionalState` — ordem de avaliação (mutuamente exclusiva)

**v1.1 — por que a regra da v1.0 foi rejeitada.** A v1.0 usava só "≥3
questões distintas E ≥70% de acerto" — taxa de acerto bruta como base
praticamente única do estado mais forte. A PO apontou que isso ignora:
repetição em momentos/sessões diferentes (3 tentativas na mesma tarde não
provam nada sobre retenção), dependência de ajuda (acertar com a camada 4
de ajuda aberta não é o mesmo que acertar sozinho), revisão espaçada
(nenhuma prova de que o aluno ainda lembra dias depois) e resultado
sustentado ao longo do tempo. A taxa de acerto CONTINUA sendo o dado
descritivo exibido na tela (seção 1 da ordem: "pode continuar como dado
descritivo") — só deixou de ser a ÚNICA base do estado mais forte.

1. Zero tentativas confirmadas → `sem_evidencias` (ausência de evidência
   nunca vira nota zero — é sobre AUSÊNCIA, nunca sobre fracasso).
2. Existe revisão ativa vencida no Caderno de Erros → `revisao_pendente`
   (prioridade MÁXIMA sobre TODOS os demais critérios, inclusive os cinco
   novos abaixo — ação mais imediata e acionável, independente de quanta
   consistência já existe).
3. Menos de `MIN_CONFIRMED_FOR_DEVELOPMENT` (3) tentativas confirmadas →
   `evidencias_iniciais`.
4. TODOS os cinco critérios abaixo precisam valer AO MESMO TEMPO (E, nunca
   OU) → `consistente_no_recorte` — sempre "neste recorte" explicitamente,
   nunca "dominado":
   - **Diversidade real**: questões distintas usadas (`COUNT(DISTINCT
     question_id)`) ≥ `MIN_DISTINCT_QUESTIONS_FOR_CONSISTENT` (3).
     Responder a MESMA questão três vezes conta como 1, nunca como 3 — já
     garantido pela consulta SQL do repositório, nunca recalculado na
     regra. *Por que*: sem isto, repetir a mesma questão até acertar
     inflava a "diversidade" artificialmente.
   - **Multi-sessão**: dias-calendário distintos de prática confirmada
     (`distinctPracticeDays`) ≥ `MIN_DISTINCT_SESSIONS_FOR_CONSISTENT` (2).
     *Por que*: 3 questões distintas todas resolvidas no mesmo dia ainda é
     UM único recorte de tempo — nada prova que o aluno reteve o padrão
     além daquele momento.
   - **Taxa de acerto**: `correctCount / confirmedAttempts` ≥
     `MIN_CORRECT_RATE_FOR_CONSISTENT` (70%). *Por que*: mantido como um
     dos cinco sinais, nunca mais como base isolada.
   - **Evidência de manutenção** (`hasMaintenanceEvidence`) — v1.2:
     `hasCorrectReview OR sustainedEvidenceWithoutReview`, dois caminhos
     equivalentes:
     - `hasCorrectReview` (caminho v1.1, inalterado): existe pelo menos
       uma revisão CORRETA (`error_review_events.result = 'correct'`) já
       registrada para este padrão. *Por que*: revisão espaçada é uma
       prova de retenção ao longo do tempo (nunca só o primeiro acerto).
       Uma revisão só existe depois de uma entrada do Caderno de Erros,
       que só existe depois de um erro confirmado — logo toda revisão
       correta já é necessariamente POSTERIOR à prática inicial por
       construção; nenhuma checagem de data adicional é necessária.
     - `sustainedEvidenceWithoutReview` (NOVO na v1.2): para um aluno que
       NUNCA errou este padrão (e portanto nunca tem `hasCorrectReview`),
       manutenção é provada por desempenho sustentado ao longo de pelo
       menos `MIN_MAINTENANCE_WINDOW_DAYS` (7) dias corridos de intervalo
       real entre a PRIMEIRA e a ÚLTIMA tentativa CONFIRMADA deste
       padrão — nunca pela contagem de dias-calendário distintos sozinha
       (esse já é o critério "Multi-sessão" acima); é o INTERVALO entre o
       primeiro e o último registro que importa aqui. `7` é um limiar
       TÉCNICO PROVISÓRIO, pendente de validação pedagógica da Andréia
       (mesma classe de ressalva de todos os outros limiares deste
       arquivo) — não é uma decisão pedagógica definitiva dela.
   - **Baixa dependência de ajuda**: proporção de tentativas confirmadas
     que abriram ajuda ≤ `MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT` (50%).
     *Por que*: acertar COM apoio pesado da ajuda não pode ser confundido
     com consistência independente.
5. Caso contrário (evidência passou de `evidencias_iniciais` mas algum dos
   cinco critérios de (4) ainda não vale — por exemplo "acerto consistente
   mas ainda sem revisão", ou "acerto consistente mas só num único dia") →
   `em_desenvolvimento`.

Os seis limiares acima (incluindo `MIN_MAINTENANCE_WINDOW_DAYS`, novo na
v1.2) são PROVISÓRIOS, centralizados num único lugar
(`worker/src/lib/studentMetricsRules.ts`), ajustáveis sem tocar em nenhuma
tabela nem em nenhum outro arquivo.

**Limitação conhecida, revista na v1.2**: a v1.1 deixava um padrão em que
o aluno NUNCA errou preso para sempre em `em_desenvolvimento`, por mais
prática distinta e multi-sessão que acumulasse — corrigido estruturalmente
nesta rodada com `sustainedEvidenceWithoutReview` (ver acima). A limitação
que PERMANECE, agora mais estreita: evidência concentrada em menos de
`MIN_MAINTENANCE_WINDOW_DAYS` (7) dias de intervalo real entre a primeira
e a última tentativa confirmada continua insuficiente nos dois caminhos
(com ou sem revisão) — consequência DELIBERADA da ordem da PO, não um
bug. O próprio limiar de 7 dias, porém, é só um número TÉCNICO razoável
escolhido para ser simples e explicável — ainda pendente de validação
pedagógica da Andréia, não uma decisão dela.

## Padrão PRINCIPAL x SECUNDÁRIO — regra permanente (correção PO v1.1)

**Regra, obrigatória a partir de agora**: desempenho, acerto/erro,
reconhecimento, revisão e estado provisório pertencem SOMENTE ao padrão
PRINCIPAL de uma questão. Padrões secundários podem registrar
exposição/contexto (a questão TOCOU aquele padrão) — nunca contadores
pedagógicos. Exposição secundária nunca altera contagem de acerto/erro,
estado provisório ou consistência daquele padrão secundário. Uma única
tentativa nunca incrementa contadores pedagógicos de mais de um padrão.

**Como é imposto em código (não só por convenção)**:

1. **No banco**: `migrations/0008_question_bank_editorial.sql` já cria
   `idx_question_patterns_one_principal`, um índice único PARCIAL em
   `question_patterns (question_id) WHERE role = 'principal'` — uma
   questão fisicamente NÃO PODE ter dois padrões principais ao mesmo
   tempo; a exclusividade é uma garantia de banco, nunca só uma checagem
   em JS que poderia ser burlada.
2. **No repositório**: TODA consulta de agregação em
   `worker/src/repositories/studentMetricsRepository.ts` faz `JOIN
   question_patterns qp ON qp.question_id = a.question_id AND qp.role =
   'principal'` — um vínculo `secundario` nunca aparece em nenhum `JOIN`
   de nenhuma função deste repositório. Isso não é um filtro best-effort:
   é estrutural — não existe nenhuma consulta neste arquivo que agregue
   por `role = 'secundario'` ou que omita a condição `role = 'principal'`.
3. **Nesta sprint, secundário não expõe NADA**: a API v1.0/v1.1 do Mapa
   ENEM não tem nenhum conceito de "exposição secundária" no contrato —
   `PatternMetricSummaryDTO`/`PatternMetricDetailDTO` só descrevem o
   padrão principal de cada questão. Não existe, portanto, nenhum campo
   `secondaryExposure` a distinguir de `primaryEvidence` nesta versão —
   se uma versão futura decidir expor exposição secundária, ela precisará
   vir como um campo claramente separado (`secondaryExposure`), nunca
   misturado aos contadores pedagógicos existentes (`primaryEvidence`
   implícito hoje).

Consequência direta: cada questão contribui para, no máximo, UM padrão nas
métricas do Mapa ENEM — nunca conta duas vezes (uma vez como principal, de
novo como secundário de outro padrão). Coberto por teste dedicado
("padrão principal x secundário", `worker/testing/studentMetrics.test.ts`)
com o cenário completo pedido pela PO: uma questão com um padrão principal
e DOIS padrões secundários, exatamente um registro de evidência pedagógica
atribuído ao principal, zero impacto pedagógico nos dois secundários, sem
contagem dupla no resumo agregado, isolamento preservado em novas
tentativas (retry).

## Convenções herdadas do repositório de evidência

`worker/src/repositories/studentMetricsRepository.ts` é 100% SOMENTE
LEITURA — nenhuma função grava linha nenhuma, nenhum `db.batch()`. Cada
consulta é derivada direta sobre as tabelas de evidência já existentes desde
as Sprints 6-9.

- **Modo x apresentação**: uma tentativa com `error_entry_id IS NOT NULL` é
  sempre contada como "revisão", nunca como "prática", mesmo que `mode`
  tecnicamente continue `practice` no banco — mesma convenção do Caderno de
  Erros.
- **Tentativa incompleta nunca vira acerto/erro confirmado**: `in_progress`
  ou `abandoned` só entram em `questionsStarted` — nunca em
  `confirmedAttempts`/`correctCount`/`incorrectCount`. Coberto por teste.
- **Escopo por usuário sempre no SQL**: todo `WHERE` inclui `user_id = ?` —
  nunca só na camada de aplicação. Coberto por dois testes de isolamento
  entre alunos (via rota HTTP e via consulta direta ao repositório).
- **Tempo aproximado**: soma de `completed_at - started_at` em segundos, só
  de tentativas confirmadas — mesma limitação já documentada no
  Diagnóstico/Player: é relógio de parede, não tempo focado (uma aba deixada
  aberta infla o número). Exposto ao aluno via `limitationsNote` no detalhe
  do padrão, nunca escondido.

## Serviço (`worker/src/services/studentMetricsService.ts`)

100% somente leitura. `userId` chega SEMPRE da sessão — as rotas nunca
aceitam `userId` como parâmetro de entrada externo.

- `listPatternMetrics` — todos os padrões publicados com sua métrica
  agregada. Filtros de estado/busca/recorte (seção 9) são aplicados no
  FRONTEND sobre esta lista completa, nunca reduzindo o que o backend
  calcula — trocar de filtro nunca dispara nova requisição.
- `getStudentMetricsSummary` — `totalPublishedPatterns`, `hasAnyEvidence`,
  `patternsByState`, `pendingReviewCount`, `lastPracticeAt`. Com zero
  tentativas em todos os padrões, `hasAnyEvidence` é `false` e tanto o
  Dashboard quanto a lista do Mapa ENEM mostram o estado vazio honesto,
  nunca um "0%" fabricado (ver "Estado vazio honesto" abaixo).
- `getPatternMetricDetail` — evidência completa de um padrão por slug, mais
  `nextStepRecommendation` (regra técnica simples e transparente derivada só
  do estado provisório, nunca uma pontuação nova) e `limitationsNote`. `null`
  quando o slug não existe OU não está publicado — nunca revela a diferença
  entre os dois casos (mesmo 404 do catálogo de padrões desde a Sprint 6).
- `getRecentActivity` — até 50 itens (`answer`/`recognition`/`help`/
  `review`), só metadados técnicos, nunca texto livre.

## Endpoints (seção 8)

| Método | Caminho | Leitura/Escrita |
|---|---|---|
| GET | `/api/student-metrics/summary` | somente leitura |
| GET | `/api/student-metrics/patterns` | somente leitura |
| GET | `/api/student-metrics/patterns/:slug` | somente leitura |
| GET | `/api/student-metrics/activity` | somente leitura |

Todas as rotas em `worker/src/routes/studentMetrics.ts` seguem a mesma ordem
obrigatória de checagens do resto do namespace do aluno (Player, Caderno de
Erros): 1) sessão válida (401); 2) gate local de fixtures — reaproveita
EXATAMENTE `isLocalEditorialFixturesAllowed`, nenhum gate novo; 3) validação
de parâmetros; 4) só então o serviço consulta o banco. Nenhuma rota grava
nada nem audita nada ("GET nunca audita" — não há mutação real aqui).
Verificado por teste dedicado ("GET nunca escreve": chamar os 4 endpoints
não altera nenhuma linha em nenhuma tabela de evidência).

## Autorização e privacidade

`user_id` vem SEMPRE da sessão — nunca de query/body/path. Um padrão de
outro aluno nunca é exposto porque toda consulta já é escopada por `user_id`
no repositório — um slug inexistente/não publicado responde 404 igual ao
catálogo de padrões (Sprint 6), nunca 403. Um padrão publicado existe para
qualquer aluno autenticado (não há "dono" de padrão) — é a EVIDÊNCIA que
muda por aluno, nunca a existência do padrão em si. A atividade recente nunca
inclui resposta livre do aluno, token, id interno ou dado de auditoria — só
contadores/metadados técnicos.

## Frontend

### Estado vazio honesto — `/mapa-enem`

O catálogo publicado normalmente não está vazio, então "aluno sem nenhuma
tentativa" não é o mesmo que "lista de padrões vazia": um aluno recém-
cadastrado ainda vê todos os padrões publicados, só que todos agrupados em
"sem_evidencias". Por isso o estado vazio honesto de
`src/pages/studentMetrics/MapaEnemListPage.tsx` usa o sinal
`summary.hasAnyEvidence` (o mesmo já usado por `DashboardPage.tsx` para a
mesma distinção), com um cálculo local de fallback a partir de `patterns`
caso o resumo ainda não tenha chegado — nunca depende só de
`filtered.length === 0`, que só cobriria o caso (raro) de zero padrões
publicados.

### Filtros e busca

Vivem na URL (`useSearchParams`, mesmo padrão de `ErrorNotebookListPage.tsx`
e `PatternsPage.tsx`), mas são aplicados no CLIENTE sobre a lista completa já
carregada — nunca disparam nova requisição. Filtros disponíveis: busca por
nome/código, estado, "só prática recente" (recorte provisório de 14 dias,
ver seção dedicada abaixo), "só revisão pendente", "só com entrada ativa
no Caderno de Erros".

### O recorte de "prática recente" (14 dias) — correção PO v1.1

A v1.0 tinha `RECENT_PRACTICE_WINDOW_DAYS = 14` e uma função
`isRecentPractice(lastPracticeAt)` que chamava `Date.now()` DIRETAMENTE —
um limiar provisório real (mesma classe dos limiares de
`studentMetricsRules.ts`), mas impossível de testar de forma determinística
sem depender do relógio real da máquina rodando o teste.

**v1.1**: a constante e a função puras foram extraídas para
`src/pages/studentMetrics/recentPractice.ts` — um módulo dedicado, único
lugar no repositório frontend onde o número `14` aparece (auditado por
`grep -rn "RECENT_PRACTICE_WINDOW_DAYS"` — só a declaração e o import em
`MapaEnemListPage.tsx`). A função `isRecentPractice(lastPracticeAt, now)`
passou a aceitar um segundo parâmetro `now: Date` **injetável**, com
`new Date()` só como valor padrão — o mesmo princípio de `Clock`/
`systemClock` já usado no worker (`worker/src/services/scheduleService.ts`),
mantido como um par PRÓPRIO no frontend em vez de um import cross-pacote:
este projeto já separa deliberadamente as constantes espelhadas entre
frontend e worker (mesma convenção de `src/pages/onboarding/
onboardingOptions.ts` vs. `worker/src/lib/onboardingValidation.ts` — "mantidas
separadas de propósito"), porque frontend e worker são dois bundles
publicáveis independentes sem import cruzado em nenhum lugar do código-fonte
hoje.

Testado em `src/pages/studentMetrics/recentPractice.test.ts` (Vitest,
ambiente jsdom padrão do projeto) com relógio injetado, nunca o relógio real
da máquina:

- exatamente dentro da janela (13 dias atrás);
- exatamente na fronteira (14 dias atrás, ao segundo — inclusivo, `<=`);
- imediatamente fora da janela (14 dias e 1 segundo atrás);
- independência de fuso horário / data real da máquina: o mesmo teste passa
  injetando um `now` fixo em um fuso e data completamente arbitrários (ano
  2030, meados de dezembro) — a função só faz aritmética de milissegundos
  entre duas instâncias de `Date`, nunca lê `Date.now()`/`Intl` diretamente,
  então o resultado não depende do relógio real nem do fuso do executor do
  teste.

### Detalhe do padrão — `/mapa-enem/:slug`

`src/pages/studentMetrics/MapaEnemDetailPage.tsx` mostra evidência geral,
evidência por modo, revisões do Caderno de Erros, evolução cronológica e o
próximo passo recomendado — nunca resposta livre, token, id interno ou dado
de auditoria. O CTA "Treinar este padrão" reaproveita EXATAMENTE
`fetchPatternDetail` (`src/api/patternsClient.ts`, Sprint 6) para obter
`trainableQuestionId` — a MESMA fonte de verdade já usada em
`PatternDetailPage.tsx`, nunca uma seleção nova de questão calculada aqui. O
CTA "Ir para o Caderno de Erros" só aparece quando `hasActiveErrorEntry` é
verdadeiro, tanto na lista quanto no detalhe.

### Cliente da API (`src/api/studentMetricsClient.ts`)

Mesmo padrão de `errorNotebookClient.ts`/`playerClient.ts`: fetch tipado,
`credentials: "include"`, `available: false` sinaliza o gate local de
fixtures fechado (nunca um erro — um estado "em preparação"). Só espelha os
4 endpoints GET que existem.

### Integração com o Dashboard

O card "Seu Mapa ENEM" em `src/pages/DashboardPage.tsx` substitui o antigo
card mocado (`MOCK_ENEM_MAP`) por dados reais de
`GET /api/student-metrics/summary`. Três estados: `available: false` mostra
"em preparação" (mesmo tratamento do resto do namespace do aluno);
`hasAnyEvidence: false` mostra um convite honesto ("Ainda sem evidências
suficientes registradas em nenhum padrão"); com evidência, mostra
`X de Y padrões já têm alguma evidência registrada`, a contagem de revisões
pendentes quando > 0, e o disclaimer "Nenhuma nota estilo TRI ou domínio
definitivo é calculado". Nunca um "0%" ou percentual fabricado.

### Navegação

`/mapa-enem` foi adicionado a `STUDENT_NAV_ITEMS`
(`src/routes/studentNav.ts`) e a `IMPLEMENTED_NAV_PATHS`
(`src/App.tsx`), com as rotas `/mapa-enem` (lista) e `/mapa-enem/:slug`
(detalhe).

## Testes

### `worker/testing/studentMetrics.test.ts`

v1.0 tinha 13 testes ALVEJADOS. v1.1 ADICIONOU testes novos sobre a mesma
base, chegando a 46 — nenhum teste anterior foi removido. v1.2 (esta
correção) ADICIONA só os 6 testes ALVEJADOS pedidos pela ordem desta
rodada para o novo `hasMaintenanceEvidence`/`sustainedEvidenceWithoutReview`
(zero erros com evidência espalhada em menos de 7 dias →
`em_desenvolvimento`; zero erros com exatamente 7 dias de intervalo →
`consistente_no_recorte`, fronteira inclusiva; zero erros com intervalo
suficiente mas ajuda acima do limite → `em_desenvolvimento`; regressão do
caminho `hasCorrectReview` continuando a funcionar após o refactor;
regressão de `revisao_pendente` continuando com prioridade máxima mesmo
quando `sustainedEvidenceWithoutReview` qualificaria; e relógio/data
injetável, nunca `Date.now()`/`new Date()` interno, provado com datas
sintéticas fora do tempo real). Ver a contagem exata e por grupo no
relatório da rodada de correção (não duplicada aqui para evitar duas
fontes de verdade divergentes) — os grupos da v1.1 foram: 8 testes de
fronteira do `deriveProvisionalState` de então ("consistente_no_recorte"
v1.1, seção 1 da ordem), isolamento principal/secundário ampliado (padrão
com 1 principal + 2 secundários, seção 2 da ordem), contratos semânticos
(seção 4 da ordem: enum fechado, ausência de campos tipo
`tri`/`domainScore`, contadores batendo com linhas reais do banco), e
GET-somente-leitura provado em separado para cada um dos 4 endpoints com
contagem de `audit_log` incluída (seção 5 da ordem).

### `e2e/studentMetrics.spec.ts` (17 testes, sem alteração nesta rodada)

Nenhum teste E2E foi adicionado ou alterado nesta correção v1.1: a mudança
de regra em `deriveProvisionalState` não altera nenhum contrato de API nem
nenhum comportamento de componente visível nos cenários E2E existentes —
todos os cenários atuais usam no máximo 1-2 tentativas confirmadas com uma
única questão original, o que nunca chega perto do novo critério de
`consistente_no_recorte` (que já exigia, mesmo na v1.0, 3 questões distintas
+ 70% de acerto — nenhum teste E2E atual monta esse cenário). Por isso, pela
política de execução da seção 8 da ordem ("só rodar E2E se o contrato/
interface mudou"), o arquivo não foi executado nesta rodada.

Chromium real contra o servidor principal (porta 8793), conta própria por
teste, isolada do rate limit por cabeçalho. Cobre: mapa vazio (estado
honesto de ausência de evidência); mapa com evidências (agrupamento fora de
`sem_evidencias`); filtros e busca (4 cenários: busca por código, filtro por
estado, filtro por Caderno de Erros ativo, filtros sem resultado com botão
"Limpar filtros"); detalhe do padrão (todas as seções, sem dado sensível);
CTA para treino (leva à tela real de início da questão); CTA para Caderno de
Erros (2 cenários: aparece com pendência ativa, não aparece sem pendência);
Dashboard com dados reais (2 cenários: com evidência e vazio); mobile 390px
(lista e detalhe sem rolagem horizontal); teclado e foco (filtros operáveis
só pelo teclado); aluno não autenticado (2 cenários: redirecionamento da
tela, 401 das 4 APIs); tentativa de acesso cruzado (evidência de um aluno
nunca aparece na leitura de outro para o mesmo padrão).

### `evidence/sprint-10-screenshots.spec.ts` (9 evidências visuais)

Em `evidence/screenshots/sprint-10/`: `mapa-vazio.png`,
`mapa-com-evidencias.png`, `mapa-filtros-busca.png`,
`mapa-detalhe-padrao.png`, `mapa-cta-treino.png`, `mapa-cta-caderno.png`,
`dashboard-mapa-enem.png`, `mapa-mobile-390px.png`, `mapa-teclado-foco.png`.

## Bugs encontrados e corrigidos nesta rodada

- **Estado vazio nunca alcançável**: `MapaEnemListPage.tsx` decidia mostrar o
  `EmptyState` "Ainda sem evidências suficientes" só quando
  `filtered.length === 0 && !hasActiveFilters` — uma condição que, com o
  catálogo real de padrões publicados (sempre > 0), nunca é verdadeira para
  um aluno sem evidência: os padrões aparecem todos agrupados sob o título de
  grupo "Ainda sem evidências suficientes (N)" em vez do estado vazio
  dedicado. Corrigido computando `noEvidenceAtAll` a partir de
  `summary.hasAnyEvidence` (com fallback local sobre `patterns`), o mesmo
  sinal já usado por `DashboardPage.tsx` para a mesma distinção.
- **Colisão de texto "0%"**: a explicação recolhida ("Como ler esses dados")
  continha literalmente a frase "nunca como 0%" como exemplo ilustrativo,
  colidindo com a asserção de teste que verifica ausência de qualquer "0%"
  fabricado na tela. Reescrito para "nunca como uma nota zero", alinhado à
  frase já usada em `studentMetricsRules.ts` ("ausência de evidência não pode
  virar nota zero") — mesmo significado, sem a colisão literal com dados
  reais.

## Limitações conhecidas e decisões que dependem da Andreia

- **Os nove limiares provisórios** (`MIN_CONFIRMED_FOR_DEVELOPMENT`,
  `MIN_DISTINCT_QUESTIONS_FOR_CONSISTENT`, `MIN_CORRECT_RATE_FOR_CONSISTENT`,
  `MIN_DISTINCT_SESSIONS_FOR_CONSISTENT`,
  `MAX_HELP_DEPENDENCY_RATIO_FOR_CONSISTENT` (v1.1),
  `MIN_MAINTENANCE_WINDOW_DAYS` (novo na v1.2), a janela de "prática
  recente" de 14 dias no frontend) não são decisão pedagógica definitiva —
  todos centralizados para serem substituíveis sem tocar no resto do
  sistema.
- **v1.2 — padrão nunca errado agora PODE alcançar `consistente_no_recorte`**
  (correção estrutural desta rodada, ver "`deriveProvisionalState` — ordem
  de avaliação" acima): via `sustainedEvidenceWithoutReview`, desde que
  também acumule pelo menos `MIN_MAINTENANCE_WINDOW_DAYS` (7) dias de
  intervalo real entre a primeira e a última tentativa confirmada — esse
  limiar de 7 dias ainda é técnico e provisório, pendente de validação
  pedagógica pela Andréia (não é decisão dela).
- **"Dia de prática" é um proxy por data-calendário, não uma sessão real**:
  `distinctPracticeDays` conta dias-calendário distintos
  (`date(completed_at)`) com tentativa confirmada — duas práticas no MESMO
  dia, horas distantes, contam como um único "dia". Não há coluna de sessão
  de navegador real no schema para uma medida mais precisa.
- **Nenhum índice de reconhecimento/resolução/domínio foi calculado** —
  apenas os cinco rótulos descritivos provisórios; as fórmulas pedagógicas
  definitivas continuam pendentes de decisão, como já registrado em
  `docs/CADERNO_ERROS_REVISAO.md`.
- **Não há `POST /rebuild`** — decisão de projeto explícita (ver "Por que não
  existe uma tabela de projeção persistida" acima), não uma omissão.
- **Busca por texto** no filtro da lista é só sobre nome/código do padrão, no
  cliente, sobre a lista já carregada — não é uma busca no backend.
