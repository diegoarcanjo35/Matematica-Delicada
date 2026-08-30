# Diagnóstico Inicial — Sprint 4 v1.0

Motor técnico do diagnóstico inicial (Documento Mestre, seções 3, 4, 5, 12, 15
e 28). Esta sprint entrega apenas a **fundação técnica**: sessão de 12 a 20
questões, registro de reconhecimento/resolução/tempo/tentativas/ajuda,
salvamento e retomada, e um resultado provisório estritamente factual. Os três
índices pedagógicos, a fórmula TRI e o plano de estudo adaptativo **não**
fazem parte desta entrega — dependem de metodologia e banco de questões ainda
não aprovados pela Andreia.

## Separação entre motor e conteúdo

O motor (schema, API, frontend) é genérico: não assume nenhum banco de
questões específico. Para desenvolvê-lo e testá-lo, usamos 12 questões
autorais fictícias e simples, que:

- nunca são apresentadas como diagnóstico pedagógico aprovado nem como
  oficiais do ENEM;
- nunca geram nota TRI, nível, domínio ou plano real;
- aparecem marcadas em código e na interface como `CONTEÚDO TÉCNICO
  PROVISÓRIO — NÃO PUBLICAR` (`ProvisionalContentNotice` em
  `src/pages/diagnostic/DiagnosticPage.tsx`);
- vivem só em `scripts/fixtures/diagnostic-fixtures.local.sql`, aplicado
  manualmente via `npm run db:seed:diagnostic:local` — nunca em uma migration,
  nunca no D1 remoto.

Fora do ambiente local/teste autorizado, `/diagnostico` mostra um estado
"em preparação pedagógica" acolhedor e nenhuma tabela `diagnostic_*` é
tocada além de `diagnostic_attempts`/`status`, que respondem sempre
`available: false`.

## Schema — migration 0004

Aditiva (`CREATE TABLE IF NOT EXISTS`), sem alterar nenhuma tabela das
Sprints 1–3. Nenhuma tabela/campo para fórmula TRI, domínio definitivo ou
cronograma adaptativo.

| Tabela | Papel |
| --- | --- |
| `diagnostic_questions` | catálogo de questões (prompt, posição de apresentação) |
| `diagnostic_question_options` | alternativas de cada questão |
| `diagnostic_question_recognition_options` | pergunta de reconhecimento **opcional** — ausência de linhas = questão sem essa pergunta |
| `diagnostic_question_help_layers` | conteúdo das 4 camadas de ajuda (`layer` 1–4) |
| `diagnostic_attempts` | uma tentativa por linha, `status` em `not_started / in_progress / completed / abandoned` |
| `diagnostic_attempt_questions` | conjunto/ordem de questões **daquela** tentativa (questões futuras não invalidam tentativas já criadas) |
| `diagnostic_responses` | uma resposta por questão por tentativa (PK composta); `is_correct` e `recognition_is_correct` são sempre calculados pelo Worker |
| `diagnostic_help_opens` | camadas de ajuda abertas por tentativa/questão (PK composta evita duplicidade) |

## Schema — migration 0005 (correção v1.2)

Aditiva, sem reescrever a 0004: só um índice único parcial —
`idx_diagnostic_attempts_one_active_per_user`, em `diagnostic_attempts
(user_id) WHERE status = 'in_progress'` — garantindo no banco que nenhum
usuário tem mais de uma tentativa `in_progress` ao mesmo tempo, sem limitar
a quantidade de tentativas `completed`/`abandoned` (histórico nunca é
afetado). Ver `worker/testing/migration0005.test.ts`.

Eventos da tentativa reaproveitam a tabela `audit_log` já existente (Sprint 2)
com novos tipos de evento, em vez de uma tabela paralela.

## Conteúdo local de desenvolvimento — matriz do gate

`worker/src/env.ts:isLocalDiagnosticFixturesAllowed` exige as três condições
**simultaneamente**:

| Ambiente (`ENVIRONMENT`) | Flag `ENABLE_LOCAL_DIAGNOSTIC_FIXTURES=true` | Hostname reconhecido como local | Resultado |
| --- | --- | --- | --- |
| `development`/`test` | sim | sim | habilitado |
| `development`/`test` | sim | não (`*.workers.dev`, domínio custom, `X-Forwarded-Host`) | bloqueado |
| `development`/`test` | não | sim | bloqueado |
| produção (qualquer outro valor) | sim | sim | bloqueado |

A flag só pode existir em `wrangler.local.jsonc`. `scripts/check-deployable-d1-config.mjs`
(`npm run check:deploy-config`, roda em `predeploy`) falha o build de deploy
se ela aparecer em `wrangler.jsonc`. `wrangler.local.no-diagnostic.jsonc`
sobe um segundo ambiente local (porta 8790, banco SQLite separado) sem a
flag, usado só para provar o estado "indisponível" no gate diretamente
(`e2e/diagnostic-unavailable-gate.spec.ts`) sem desligar a flag no servidor
principal.

## Estados e fluxo

`src/pages/diagnostic/DiagnosticPage.tsx` modela a tela como uma máquina de
estados: `loading → unavailable | empty | intro | resume_prompt |
completed_prompt | question → result | error`.

- **Sem tentativa**: `intro` → "Começar diagnóstico".
- **Tentativa em andamento**: `resume_prompt` — "Continuar diagnóstico" retoma
  na primeira questão sem resposta; "Reiniciar" exige confirmação explícita
  (modal) e preserva a tentativa anterior no histórico.
- **Tentativa concluída**: `completed_prompt` — mostra resumo factual ou
  permite refazer (nova tentativa, histórico preservado).
- **Questão**: uma por vez, com pergunta de reconhecimento opcional, alternativas
  por teclado, opção "Não sei por onde começar" (desmarca a alternativa
  selecionada e vice-versa), painel progressivo das 4 camadas de ajuda (camada
  N só habilita depois que a N-1 foi aberta), indicador de salvamento
  (`idle/saving/saved/error`) e confirmação antes de sair.
- **Resultado**: só métricas factuais (ver seção abaixo) e aviso literal do
  item 5.3 da ordem.

## Segurança e autorização

- `user_id` sempre derivado da sessão (cookie `md_session` via
  `checkSession`) — nunca do corpo da requisição.
- Tentativa de outro usuário responde 404 (recurso inexistente), nunca 403 —
  não revela existência.
- IDs, estado da tentativa, pertencimento da alternativa à questão e camada
  (1–4) são validados no Worker antes de qualquer mutação.
- Acerto e pontuação nunca são aceitos do cliente — sempre recalculados em
  `worker/src/services/diagnosticService.ts`. Tempo total/médio do resultado
  também nunca vêm de um valor agregado enviado pelo cliente — são somados
  no Worker a partir do tempo *por questão* persistido (ver "Origem e
  limites do tempo registrado" abaixo para a limitação real desse tempo).
- O endpoint de detalhe da tentativa (`GET /api/diagnostic/attempts/:id`)
  nunca inclui a alternativa correta antes da conclusão.
- Tentativa `completed` rejeita novas respostas/ajudas com 404.
- Mensagens de erro nunca revelam gabarito.

## Endpoints

Todos exigem sessão válida (401 sem ela) e respondem `unavailable` (200,
`available: false`) fora do gate local, exceto `status`, que sempre responde.

| Endpoint | Papel |
| --- | --- |
| `GET /api/diagnostic/status` | tentativa ativa / concluída / disponibilidade |
| `POST /api/diagnostic/attempts` | cria tentativa (ou reinicia, com `restart: true`) |
| `GET /api/diagnostic/attempts/:id` | detalhe da tentativa do próprio usuário |
| `PATCH /api/diagnostic/attempts/:id/responses/:questionId` | salva/substitui resposta |
| `POST /api/diagnostic/attempts/:id/help/:questionId/:layer` | abre uma camada de ajuda |
| `POST /api/diagnostic/attempts/:id/complete` | conclui a tentativa |
| `GET /api/diagnostic/attempts/:id/result` | resultado técnico provisório |

## Origem e limites do tempo registrado

O tempo por questão (`time_spent_ms`) é **reportado pelo cliente** (diferença
entre o instante em que a questão foi carregada e o instante do "Avançar",
medida em `DiagnosticPage.tsx`) — o Worker não reconstrói esse intervalo de
forma independente a partir dos timestamps de suas próprias requisições. Por
isso o motor trata esse número como **tempo aproximado**, nunca como medida
pedagógica:

- `worker/src/lib/diagnosticValidation.ts:validateTimeSpentMs` aceita somente
  inteiro entre `0` e `TIME_SPENT_MS_MAX` (30 minutos) inclusive — valor
  negativo, não numérico, fracionário **ou acima do teto** é **rejeitado**
  (correção v1.2: versões anteriores saturavam em vez de rejeitar, o que
  permitia um payload adulterado sobrescrever uma resposta válida já
  persistida com um tempo artificialmente alto). A resposta inteira falha
  como erro de validação — nada é gravado nem substitui a resposta anterior.
  Esta telemetria não pode alimentar nenhum índice pedagógico enquanto
  continuar dependente de medição do lado do cliente.
- `totalTimeMs`/`averageTimeMs` do resultado são somados/calculados no Worker
  a partir do `time_spent_ms` já persistido de cada resposta
  (`getResult` em `worker/src/services/diagnosticService.ts`) — o cliente
  nunca envia um total ou uma média agregada; não existe esse campo na API.
- Retomar uma tentativa (refresh, fechar e reabrir a aba) não duplica nem
  zera o tempo já salvo de questões respondidas — cada resposta é uma linha
  própria (`PRIMARY KEY (attempt_id, question_id)`), e reler o estado da
  tentativa nunca reenvia tempo de questões já respondidas.
- **Limitação explícita**: se o aluno deixa a aba aberta/inativa numa questão
  ainda não respondida, esse tempo ocioso entra no cálculo como se fosse
  tempo de resolução, até o teto de 30 minutos — o motor não distingue tempo
  ativo de tempo ocioso. É por isso que a interface e este documento chamam
  o número de "tempo aproximado", nunca de tempo de resolução preciso.

Testes específicos: `worker/testing/diagnostic.test.ts`, describe "diagnóstico
— origem e limites do tempo registrado" (tempo exatamente no teto aceito,
acima do teto rejeitado sem persistir, sobrescrita adulterada não modifica
resposta válida anterior, retomada não duplica/zera, resultado bate
exatamente com a soma dos tempos persistidos).

## Progressão das camadas de ajuda (correção v1.2)

A ordem 1→2→3→4 é imposta no **Worker**, não só na interface. O gate vive
dentro do mesmo statement atômico que insere a abertura
(`buildInsertHelpOpenStatement` em `worker/src/repositories/
diagnosticRepository.ts`): a camada 1 é sempre permitida; a camada N>1 exige
que exista uma linha de abertura da camada N-1 para a mesma tentativa/questão
— avaliado como parte da própria condição SQL da inserção, nunca por uma
leitura separada antes de gravar. Isso elimina a corrida em que a tentativa
poderia mudar de estado (ou a camada anterior deixar de "estar aberta")
entre checar e escrever.

Como `meta.changes = 0` pode significar tanto "já estava aberta" (idempotente)
quanto "o gate bloqueou" (pré-requisito ausente ou tentativa inválida),
`openHelp()` (em `worker/src/services/diagnosticService.ts`) distingue os
dois casos com uma leitura de estado **depois** da tentativa de escrita — não
é uma corrida, é só classificar um resultado que já é definitivo. Só
abertura nova persistida (`outcome: "opened"`) gera o evento de auditoria
`diagnostic_help_opened`; reabertura idempotente não duplica evento.

## Atomicidade

Criação de tentativa, salvamento de resposta, registro de ajuda e conclusão
(+ resumo) usam `env.DB.batch()`. As mutações condicionadas por `WHERE`
(salvar resposta, abrir ajuda, concluir) usam esse guard como proteção
primária contra corrida — `meta.changes` depois decide a interpretação do
resultado (sucesso novo vs. idempotente vs. bloqueado), não é numa contagem
isolada que a segurança se apoia. `createAttempt()` valida explicitamente
que cada statement do lote afetou exatamente uma linha e, além disso, conta
com o índice único parcial da migration 0005 (`idx_diagnostic_attempts_
one_active_per_user`) para garantir no banco — não só na aplicação — que
nenhum usuário fica com duas tentativas `in_progress` simultâneas; uma
violação dessa constraint (corrida de duas criações/reinícios concorrentes)
é tratada como resultado controlado (`active_exists`), nunca um erro 500.
Testes de rollback simulam falha nas operações críticas de criação e de
reinício (`worker/testing/diagnostic.test.ts`). Conclusão é idempotente e
uma corrida de conclusão não gera dois resumos (PK composta em
`diagnostic_responses` e verificação de estado atômica).

## Métricas factuais exibidas × proibidas

**Exibidas**: questões respondidas, acertos brutos, questões marcadas "não
sei por onde começar", tempo total e médio **aproximados** (ver "Origem e
limites do tempo registrado" acima), ajudas abertas por camada,
reconhecimentos informados (contagem, sem virar índice).

**Proibidas** (não implementadas nesta sprint): nota TRI, nível fechado,
Índice de Reconhecimento/Resolução/Domínio definitivos, diagnóstico
clínico/cognitivo, plano adaptativo real, promessa de desempenho no ENEM. A
tela de resultado exibe o aviso literal: "Resultado técnico provisório para
validação do sistema. A análise pedagógica será ativada somente após
aprovação da metodologia e do banco de questões."

## Auditoria e privacidade

Eventos registrados em `audit_log`: `diagnostic_started`,
`diagnostic_progress_saved` (só `questionId`), `diagnostic_help_opened` (só
`questionId` + `layer`), `diagnostic_completed` (só contagens agregadas),
`diagnostic_restarted`. Nunca registrados: enunciado, alternativa escolhida,
resposta livre, conteúdo de acessibilidade, gabarito, token/cookie/e-mail.

Retenção e exclusão de dados de tentativas seguem em aberto — decisão
jurídica/pedagógica pendente, não inventada aqui.

## Decisões pendentes

- Taxonomia e fórmulas dos três índices pedagógicos (Documento Mestre, seção 5).
- Banco de questões pedagógico real — fornecido e aprovado pela Andreia; até
  lá, o motor roda exclusivamente sobre as 12 fixtures técnicas locais.
- Política de retenção/exclusão de tentativas e respostas.
- Direitos de uso do banco de questões definitivo.

Este diagnóstico **não está pronto para produção**: falta o conteúdo
pedagógico aprovado, os três índices, o provedor de e-mail de produção e o
rate limiting de borda (os dois últimos já adiados para o fechamento final do
produto desde a Sprint 2/3, não bloqueiam esta sprint).
