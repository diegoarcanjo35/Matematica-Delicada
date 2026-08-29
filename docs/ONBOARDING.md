# Onboarding e Perfil Inicial do Aluno — Sprint 3 v1.1

Implementa o onboarding real e persistente do aluno (Documento Mestre, seção
10.2), transformando uma conta autenticada em um perfil inicial. **Não**
implementa o diagnóstico real, taxonomia oficial de padrões, cronograma
adaptativo, professor/admin, pagamento nem integração de e-mail — ver
"Fora do escopo" abaixo.

Atualizado na v1.1 (correção cirúrgica, sem ampliar funcionalidade): a v1.0
afirmava, incorretamente, que nenhum dado sensível é coletado — corrigido na
seção "Classificação e privacidade dos dados" abaixo. As faixas/conjuntos de
validação não citados no Documento Mestre agora estão explicitamente
marcados como regras técnicas provisórias, não decisões pedagógicas
aprovadas pela Andreia (ver "Regras de validação — o que é documentado vs.
provisório").

## Modelo de dados (`migrations/0003_student_profiles_onboarding.sql`)

Tabela `student_profiles`, um perfil por usuário (`user_id TEXT PRIMARY KEY
REFERENCES users (id)`). Faixas e conjuntos fechados abaixo são, salvo os
dois marcados com \*, regras técnicas provisórias — ver tabela completa em
"Regras de validação — o que é documentado vs. provisório" mais abaixo.

| Coluna | Tipo | Observação |
|---|---|---|
| `current_grade` | TEXT | conjunto fechado — ver `GRADE_OPTIONS` |
| `enem_year` | INTEGER | ≥ ano corrente |
| `goal_type` | TEXT | `acertos` \| `nota` \* (Documento Mestre, seção 10.2) |
| `goal_value` | INTEGER | 0–45 (acertos) ou 0–1000 (nota) |
| `current_correct_estimate` | INTEGER, opcional | 0–45 |
| `available_days` | TEXT | JSON array de dias (`seg`…`dom`), sem duplicidade |
| `daily_minutes` | INTEGER | 10–240 |
| `difficulties` | TEXT | JSON array de string livre, até 6 itens, 80 caracteres cada, sanitizado |
| `time_preference` | TEXT | `manha` \| `tarde` \| `noite` \| `variavel` |
| `accessibility_needs` | TEXT, opcional | texto livre até 200 caracteres, sanitizado |
| `diagnostic_choice` | TEXT | `agora` \| `depois` \* (Documento Mestre, seção 10.2) |
| `current_step` | INTEGER | 1–7 |
| `status` | TEXT | `not_started` \| `in_progress` \| `completed` |
| `started_at` / `completed_at` | TEXT | timestamps |

Arrays são persistidos como JSON serializado numa coluna `TEXT` — formato
documentado aqui, validado em `worker/src/lib/onboardingValidation.ts`
(nunca em mais de um lugar).

## Contrato dos endpoints (`/api/onboarding`)

Todas as rotas exigem sessão válida no Worker (`checkSession`) e derivam
`user_id` **exclusivamente** da sessão — qualquer `userId`/`user_id` enviado
no corpo é ignorado (testado em `worker/testing/onboarding.test.ts`, cenário
18). `Origin` é validado globalmente para mutações (`worker/src/index.ts`).

- **`GET /api/onboarding`** — retorna o perfil do usuário autenticado. Se
  ainda não existe (nunca salvou nada), retorna `status: "not_started"` sem
  criar linha no banco.
- **`PATCH /api/onboarding`** (ou `PUT`, equivalente) — salva progresso
  parcial de forma idempotente. Cria o perfil no primeiro salvamento
  (`status: "in_progress"`, `started_at` gravado). Só valida os campos
  presentes no corpo — etapas ainda não respondidas não geram erro. Depois de
  `status: "completed"`, só os campos em
  `ONBOARDING_COLUMNS_EDITABLE_AFTER_COMPLETION`
  (`dailyMinutes`, `availableDays`, `timePreference`, `accessibilityNeeds`)
  podem ser alterados — qualquer outro campo enviado gera erro 400 por campo
  ("não pode mais ser alterado após a conclusão").
- **`POST /api/onboarding/complete`** — valida que todos os campos
  obrigatórios já foram salvos (currentGrade, enemYear, goalType, goalValue,
  availableDays, dailyMinutes, difficulties, timePreference,
  diagnosticChoice) e marca `status: "completed"`. Idempotente: se já
  concluído, retorna sucesso sem revalidar nem regravar `completed_at`.

Erros de validação sempre respondem `400` com
`{ error: { code: "validation_error", message, fields: { <campo>: <mensagem> } } }`
— nunca detalhe interno.

## Estados e redirecionamentos

- `RequireOnboardingComplete` (`src/auth/RequireOnboardingComplete.tsx`)
  redireciona qualquer rota da área do aluno para `/onboarding` quando
  `status !== "completed"`.
- `/onboarding` é sempre acessível a um usuário autenticado. Se o onboarding
  já está `completed`, acessar `/onboarding` diretamente redireciona para
  `/` (decisão documentada — a edição de preferências pós-conclusão fica em
  Configurações, não reabrindo o assistente).
- Escolha de diagnóstico `agora` → `/diagnostico` (placeholder, "será
  implementado na próxima sprint"); `depois` → `/` (dashboard, com um link
  para retomar o diagnóstico a qualquer momento).
- Logout continua acessível diretamente na tela de onboarding (cabeçalho da
  `OnboardingPage`) — nunca vira armadilha de navegação.
- `OnboardingStatusProvider` (`src/onboarding/`) busca `/api/onboarding` uma
  vez por sessão de navegação autenticada e é compartilhado entre a
  `OnboardingPage`, o guard e o Dashboard/Configurações — evita duplicar a
  requisição. A `OnboardingPage` chama `refresh()` explicitamente após
  concluir, para o guard nunca redirecionar de volta com um status obsoleto.

## Validações

Centralizadas em `worker/src/lib/onboardingValidation.ts` — nunca duplicadas
entre rotas. O frontend espelha as mesmas opções em
`src/pages/onboarding/onboardingOptions.ts` só para render de UI; a
validação real e definitiva é sempre a do Worker.

### Regras de validação — o que é documentado vs. provisório

O Documento Mestre define **quais perguntas existem** no onboarding (seção
10.2: série atual, ano do ENEM, meta de acertos ou nota, quantidade atual
aproximada de acertos, dias disponíveis, minutos por dia, principais
dificuldades percebidas, preferência de horário, necessidade de
acessibilidade, diagnóstico agora/depois) e o tipo de meta (`acertos` ou
`nota`, seção 10.2, literal). Ele **não define** valores numéricos de
faixa/limite, nem a lista fechada de opções de cada pergunta — esses são
constantes técnicas provisórias desta implementação, centralizadas e fáceis
de ajustar, e **não foram aprovadas pela Andreia como decisão pedagógica**:

| Regra | Valor atual | Origem |
|---|---|---|
| Tipo de meta (`acertos` \| `nota`) | — | **Documento Mestre, seção 10.2** (literal: "meta de acertos ou nota") |
| Escolha de diagnóstico (`agora` \| `depois`) | — | **Documento Mestre, seção 10.2** (literal: "realização do diagnóstico agora ou depois") |
| Existência das demais perguntas (série, ano ENEM, dias, minutos, dificuldades, preferência de horário, acessibilidade) | — | **Documento Mestre, seção 10.2** |
| Teto da meta em acertos | 45 | **Regra técnica provisória** — fato público sobre o formato atual do ENEM (45 questões de Matemática), não citado no Documento Mestre, não aprovado como decisão pedagógica |
| Faixa da meta em nota | 0–1000 | **Regra técnica provisória** — escala numérica comum do ENEM usada só como limite de sanidade do campo; o Documento Mestre (seção 11, item "Decisão pendente") alerta explicitamente contra apresentar uma "nota TRI oficial" sem modelo validado — esta implementação nunca chama o valor de "nota TRI" nem de projeção garantida, apenas de meta autodeclarada |
| Opções de série (`GRADE_OPTIONS`) | 8º/9º EF, 1ª–3ª série EM, "já concluí" | **Regra técnica provisória** — enumeração própria, não listada no Documento Mestre |
| Faixa de minutos por dia | 10–240 | **Regra técnica provisória** — limite de sanidade, não citado no Documento Mestre |
| Limite de dificuldades | até 6 itens, 80 caracteres cada | **Regra técnica provisória** — limite técnico de UI/armazenamento, não citado no Documento Mestre |
| Opções de preferência de horário (`manha`/`tarde`/`noite`/`variavel`) | — | **Regra técnica provisória** — a pergunta existe no Documento Mestre; as opções fechadas são desta implementação |
| Codificação dos dias da semana (`seg`…`dom`) | — | **Regra técnica provisória** — representação interna; a pergunta ("dias disponíveis") está no Documento Mestre |
| Limite de acessibilidade | até 200 caracteres | **Regra técnica provisória** — limite técnico de armazenamento |

Nenhum desses valores foi alterado nesta rodada (v1.1) — nenhum contradiz
diretamente o Documento Mestre, só preenche lacunas que ele deixa em aberto.
Qualquer um pode ser revisto por decisão pedagógica futura sem migração de
schema (são limites de validação, não estrutura de dados).

## Eventos de auditoria (`audit_log`)

`onboarding_started`, `onboarding_progress_saved` (metadado: só o número da
etapa), `onboarding_completed`, `onboarding_preferences_updated` (PATCH
depois da conclusão). Nunca gravam dificuldades, acessibilidade ou qualquer
resposta completa — testado em `worker/testing/onboarding.test.ts`, cenário
19.

## Classificação e privacidade dos dados

Corrigido na v1.1 — a v1.0 afirmava incorretamente que "nenhum dado pessoal
sensível é coletado". Essa afirmação absoluta não se sustenta: o campo
opcional de necessidades de acessibilidade pode conter dado de saúde ou
deficiência, dependendo do que o aluno escrever nele.

**Classificação:**

- **Dados pessoais vinculados ao perfil educacional** (não sensíveis por si
  só, mas pessoais): série atual, ano do ENEM, meta e desempenho percebido
  (`goal_type`, `goal_value`, `current_correct_estimate`), rotina
  (`available_days`, `daily_minutes`, `time_preference`), dificuldades
  percebidas, escolha de diagnóstico.
- **Campo que pode conter dado pessoal sensível**: `accessibility_needs`
  (necessidades de acessibilidade) — texto livre e **opcional**. Dependendo
  do que o aluno escrever, pode revelar informação relacionada a saúde ou
  deficiência (categoria sensível sob a LGPD). Por isso:
  - continua opcional e aceita ficar vazio/`null` (testado — ver "Testes
    novos da v1.1" em `docs/ONBOARDING.md`/relatório);
  - nunca é enviado para `audit_log`, `console`, query string ou URL —
    confirmado no código (nenhuma rota grava `accessibilityNeeds` em
    metadado de auditoria; todo tráfego é POST/PATCH com corpo JSON) e por
    teste automatizado dedicado;
  - a interface exibe um aviso curto junto ao campo (texto exato abaixo),
    tanto no onboarding quanto em Configurações.

**Texto do aviso de privacidade** (idêntico nos dois lugares onde o campo
aparece):

> "Opcional. Informe somente o que for necessário para adaptarmos sua
> experiência. Esse conteúdo nunca aparece em URL, logs, auditoria ou
> mensagens de erro."

**Demais pontos de minimização:**

- Nenhum dado de nascimento, CPF, telefone, escola, endereço, renda ou dados
  do responsável é coletado nesta sprint.
- `difficulties` (dificuldades percebidas) também nunca aparece em
  `audit_log` — mesmo não sendo, em si, uma categoria sensível pela LGPD,
  segue a mesma minimização por prudência.
- Respostas nunca entram em URL (POST/PATCH com corpo JSON, nunca query
  string).
- `localStorage` não é usado como fonte de verdade — todo estado vem de
  `GET /api/onboarding` no servidor.
- **Retenção de dados do onboarding**: pendência, não definida nesta sprint
  — nenhum prazo foi inventado.
- **Consentimento do responsável para menores**: pendência jurídica/operacional,
  não implementada — bloqueio de lançamento, não uma regra legal inventada
  aqui.
- **Base legal e política de privacidade aplicável a dado sensível**: também
  pendente — esta sprint só minimiza a exposição técnica do campo (nunca
  aparece em log/auditoria/URL); a decisão jurídica sobre tratamento de dado
  sensível de saúde/deficiência continua em aberto para Andreia/PO.

## Campos editáveis depois da conclusão (Configurações)

Só `dailyMinutes`, `availableDays`, `timePreference`, `accessibilityNeeds`
(`src/pages/SettingsPage.tsx`). Série, meta, ano do ENEM e dificuldades não
são editáveis nesta tela — a mudança desses dados fica fora do escopo desta
sprint (o texto da tela orienta o aluno a contatar o suporte).

## Fora do escopo desta sprint

- Diagnóstico real (a rota `/diagnostico` é só um placeholder estrutural).
- Taxonomia oficial/definitiva de padrões ou de dificuldades.
- Cronograma adaptativo real.
- Professor/admin, pagamento.
- Integração de provedor de e-mail real (Gmail/Resend) — `proffandreia5@gmail.com`
  é só referência administrativa.
- MCP Cloudflare, D1 remoto, deploy — nada disso foi tocado nesta sprint.

## Decisões pendentes (não fechadas nesta sprint)

- Consentimento de responsável legal para menores.
- Termos e política de privacidade definitivos.
- Provedor real de e-mail (pendência herdada da Sprint 2 — ver
  `docs/AUTENTICACAO.md`).
- Rate limit de produção na borda (idem).
- Política de retenção de dados de onboarding.
