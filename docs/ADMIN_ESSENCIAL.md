# Administração Essencial — Sprint 15 v1.0/v1.1

Documenta a primeira área administrativa real da Matemática Delicada
(`/admin`) e o mecanismo de Bootstrap Administrativo Seguro (adendo v1.1).

## 1. Escopo

**Entregue nesta sprint:**
- dashboard administrativo (contagens factuais);
- listagem de usuários com busca, filtro por papel/situação, ordenação e paginação;
- detalhe de usuário com atribuição/remoção de papel;
- gestão de vínculos professor↔aluno (criar, reativar, inativar);
- bootstrap one-shot, secreto, atômico, para promover as duas primeiras contas a `admin`.

**Fora do escopo** (ordem seção 28): turmas completas, convite por e-mail,
responsáveis, cadastro em massa/CSV, atividades/listas/simulados do
professor, comunicados, WhatsApp/e-mail real/push, suporte, planos,
pagamento, IA, gamificação, exportação, D1 remoto, deploy.

## 2. RBAC reutilizado

`admin` já existia no `CHECK` de `roles.name` desde a migration 0008
(Sprint 7) — só nunca tinha sido consultado como papel de área própria
(igual a `teacher` até a Sprint 14). `worker/src/lib/rbac.ts` ganhou
`resolveAdminRole`, no mesmo formato de `resolveTeacherRole`/
`resolveEditorialRole`: consulta `user_roles`/`roles` pelo `userId` da
sessão já validada, nunca por um campo enviado pelo cliente.

`admin` **não herda** de `editor`/`teacher` nem é herdado por eles — um
editor sem `admin` explícito não acessa `/admin`; um `admin` não precisa
também ter `teacher` para gerenciar vínculos alheios.

Todas as rotas em `worker/src/routes/admin.ts` seguem, sempre nesta ordem:
sessão válida (401) → papel `admin` (403). Nenhuma rota aceita `role`/
`adminId` do corpo/query como fonte de verdade.

## 3. Migration 0020 — decisão

A Administração Essencial (base v1.0) **não precisou de nenhuma tabela
nova**: `users`, `roles`, `user_roles` e `teacher_student_access` (0008 e
0019) já cobrem usuário/papel/vínculo por completo; `audit_log` (0001)
aceita qualquer `event_type` novo sem migration.

`migrations/0020_admin_user_management.sql` foi criada só por causa do
adendo v1.1, para duas coisas:

1. **`admin_bootstrap_state`** — estado persistente do bootstrap (seção 6).
2. **`trg_user_roles_protect_last_admin`** — trigger que bloqueia a remoção
   do último administrador (seção 5.1).

Nenhuma migration 0001-0019 foi editada. `worker/testing/fakeD1.ts` foi
atualizado com o mesmo DDL (espelho manual, mesma convenção das migrations
anteriores) e `worker/testing/migration0020.test.ts` roda o **SQL real**
contra `node:sqlite`.

## 4. Endpoints (`/api/admin/*`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/admin/dashboard` | contagens factuais |
| GET | `/api/admin/users` | listagem paginada/filtrada |
| GET | `/api/admin/users/:id` | detalhe sanitizado |
| POST | `/api/admin/users/:id/roles` | atribui papel (`{role, mutationId}`) |
| DELETE | `/api/admin/users/:id/roles/:role?mutationId=` | remove papel |
| GET | `/api/admin/teacher-student-links` | listagem de vínculos |
| POST | `/api/admin/teacher-student-links` | cria vínculo (`{teacherId, studentId, mutationId}`) |
| PATCH | `/api/admin/teacher-student-links/:id` | reativa/inativa (`{action, mutationId}`) |

8 endpoints, exatamente a superfície sugerida pela ordem (seção 14).

## 5. Projeções de dados (privacidade — seção 17)

`worker/src/repositories/adminRepository.ts` monta cada campo
explicitamente — nunca um spread de linha interna.

**Listagem/detalhe de usuário incluem:** `id`, `name`, `email`, `status`,
`emailConfirmed` (booleano, nunca a data crua do token), `createdAt`,
`lastLoginAt`, `roles[]`; no detalhe, também `activeTeacherBondsCount`
(só quando o usuário tem papel `teacher` — contagem, nunca a lista de
alunos, que duplicaria o Painel do Professor).

**Nunca incluem:** `password_hash`, `session_version`, tokens de
confirmação/redefinição, qualquer linha de `sessions`, respostas de
onboarding, conteúdo do Caderno de Erros (`student_note` etc.), histórico
de tentativas/questões, dados de responsável.

**E-mail é exibido ao admin** — decisão explícita (ordem seção 10 permite
quando "já faz parte do modelo legítimo de conta e há necessidade
operacional clara"): e-mail é o próprio identificador de login desta
plataforma (não um campo de contato opcional), e o admin precisa dele para
localizar/confirmar contas — inclusive para o bootstrap (seção 8 abaixo).

**Vínculos** expõem `id`, `teacherId`/`teacherName`, `studentId`/
`studentName`, `status`, `createdAt`/`updatedAt` — nomes por JOIN, nunca
N+1.

## 6. Gestão de papéis (seção 12)

Contrato de mutação **deliberadamente mais simples** que o padrão de
"identidade completa por `mutationId`" usado em `weeklyReviewService.ts`/
`dailyTrainingService.ts`. Aquele padrão existe porque aquelas mutações têm
CONTEÚDO que pode divergir entre duas tentativas (`targetMinutes` etc.).
Atribuir/remover papel é "alternar associação" — não há conteúdo que possa
conflitar entre duas tentativas do mesmo alvo.

Por isso, aqui a idempotência real vem do `meta.changes` da **única**
instrução SQL que muda o estado:

- **Atribuir**: `INSERT OR IGNORE INTO user_roles` com **id determinístico**
  `user-role-<userId>-<roleId>` — uma segunda tentativa (mesmo par
  usuário/papel) sempre tenta a MESMA linha, nunca duplica.
- **Remover**: `DELETE ... WHERE user_id = ? AND role_id = ?` — afeta no
  máximo 1 linha, 0 se já não existia.

Se `changes === 0`, nada mudou nesta chamada (idempotente por natureza) e
**nenhuma auditoria é gravada**. Se `changes === 1`, o evento de auditoria
(`admin_role_assigned`/`admin_role_removed`) é gravado com
`id = mutationId` (PRIMARY KEY de `audit_log` — reuso do mesmo `mutationId`
por duas operações diferentes vira 409, nunca um segundo evento
silencioso).

`mutationId` continua exigido no contrato por consistência de API e como
defesa em profundidade, mesmo não sendo a garantia primária aqui — a
garantia primária é o próprio `meta.changes` da instrução determinística,
provado sob concorrência real em `worker/testing/admin.test.ts`
("concorrência: duas atribuições simultâneas...").

**Proteções (ordem seção 12):**
1. role arbitrária → 400 (`isAssignableRole`, mesmo enum de `ALL_ROLES`);
2. duplicidade → idempotente, `changed:false`;
3. remover papel inexistente → `changed:false`, nunca reportado como mudança;
4. retry idempotente → sem auditoria duplicada (provado em teste);
5. autopromoção → estruturalmente impossível (o próprio ator precisa já
   ser `admin` para a rota nem começar a processar a mutação — 403 antes de
   qualquer lógica de negócio);
6. `teacher` concedendo papéis → 403 (RBAC exige `admin`, nunca `teacher`);
7. identidade do ator do cliente → nunca aceita (`adminId` sempre vem da
   sessão);
8. concorrência → provada com chamadas paralelas reais contra o mesmo
   `FakeD1Database`.

### 6.1 Último administrador

**Definição de "admin ativo" adotada** (ordem seção 12: "se o modelo atual
permitir identificar isso de forma segura, implementar"): existe uma linha
em `user_roles` apontando para o papel `admin`. `user_roles` não tem coluna
de status própria, e `users.status` nunca é gravado com um valor diferente
de `'active'` em nenhum fluxo hoje existente do produto (não há
suspensão/banimento implementado) — combinar os dois daria uma falsa
sensação de precisão sem fonte real de verdade por trás. Essa é uma decisão
de julgamento explícita: se o PO quiser uma semântica mais rica no futuro
(ex.: excluir contas com e-mail não confirmado), é uma extensão posterior.

**Implementação**: `migrations/0020`, trigger
`trg_user_roles_protect_last_admin` — `BEFORE DELETE ON user_roles`, aborta
se a linha sendo removida é do papel `admin` E a contagem de portadores
distintos do papel `admin` (antes desta remoção) é `<= 1`. Implementado
como TRIGGER (não checagem em JavaScript antes do DELETE) porque é a única
forma imune a corrida real entre duas remoções concorrentes: o SQLite
serializa escritas, então cada `DELETE` reavalia a contagem no momento da
SUA PRÓPRIA execução — testado em `worker/testing/migration0020.test.ts` e
`worker/testing/admin.test.ts`.

## 7. Gestão de vínculos (seção 13)

Reaproveita `teacher_student_access` (migration 0019) por inteiro — nenhuma
tabela paralela. `worker/src/repositories/teacherRepository.ts` ganhou
`buildReactivateBondStatement`/`buildDeactivateBondStatement` (a Sprint 14
só tinha `buildCreateBondStatement`, usado só por fixture/teste; a Sprint
15 é a primeira a expor uma rota HTTP real de escrita sobre esta tabela).

- **Criar**: rejeitado (400, nenhuma linha tocada) se já existir QUALQUER
  linha para o par (ativa → "já existe vínculo ativo"; inativa → "use
  reativar"). Nunca insere uma segunda linha para o mesmo par
  (`idx_teacher_student_access_pair`, UNIQUE desde a 0019).
- **Reativar/inativar**: sempre `UPDATE` guardado por status
  (`WHERE status = 'inactive'`/`'active'`) — nunca `DELETE`, nunca um
  segundo `INSERT`. Idempotente pelo mesmo raciocínio de `meta.changes` da
  seção 6.
- **Validações**: `teacherId != studentId`; professor precisa ter papel
  `teacher` (`resolveTeacherRole`); aluno precisa existir em `users`.

## 8. Bootstrap Administrativo Seguro (adendo v1.1)

### 8.1 Por que existe

Antes desta sprint, não existe NENHUMA forma de um usuário virar `admin`
— cadastro público só cria conta comum, e nenhuma API/tela de promoção
existia em lugar nenhum do código. O bootstrap resolve exclusivamente esse
problema de "ovo e galinha": como criar os dois primeiros administradores
quando nenhum administrador ainda existe para usar a área `/admin` normal.

### 8.2 Por que não existe `super_admin`/`devmaster`

O sistema de papéis já tem `admin` desde a migration 0008 — criar um
segundo nível de papel só para o bootstrap seria um RBAC paralelo
(proibido pela ordem seção 6, e explicitamente vetado pelo adendo seção
C). As duas contas de bootstrap recebem exatamente `admin`, o mesmo papel
que a área `/admin` normal usa depois.

### 8.3 Fluxo

1. Andreia e Diego criam conta pelo cadastro normal (`/api/auth/signup`) —
   contas comuns, sem nenhum papel.
2. Um operador com o segredo de bootstrap chama
   `POST /api/admin-bootstrap/run` com os dois e-mails.
3. As duas contas recebem `admin`; o bootstrap se marca concluído.
4. Toda promoção/gestão futura acontece pelos endpoints normais da seção 6
   (`/api/admin/users/:id/roles`).

### 8.4 Desenho escolhido: endpoint técnico protegido, não script

O adendo (seção N) oferecia duas opções: script local, ou endpoint técnico
protegido. Este projeto não tem NENHUM precedente de script Node
acessando D1 diretamente com lógica de aplicação — os únicos scripts
existentes (`scripts/fixtures/*.sql` via `wrangler d1 execute`) são SQL
bruto sem idempotência/atomicidade/auditoria própria, aplicados só contra
D1 local. Reescrever toda a lógica de atomicidade/auditoria/RBAC fora do
Worker, num script separado, seria duplicar infraestrutura que o Worker já
tem pronta (repositórios, `db.batch()`, `audit_log`). Um endpoint protegido
por segredo, dentro do próprio Worker, reaproveita tudo isso e funciona
igualmente contra D1 local (esta sprint) ou remoto (uma ordem futura
autorizada — adendo seção T), sem reescrever nada.

**Superfície de exposição mínima** (adendo: "escolher a superfície de
menor exposição"):
- um único endpoint, `POST /api/admin-bootstrap/run`;
- **existe apenas quando `ADMIN_BOOTSTRAP_SECRET` está configurado** —
  ausente de TODO arquivo de configuração deste repositório nesta sprint
  (nem `wrangler.jsonc`, nem `wrangler.local.jsonc`), então a rota responde
  404 em qualquer ambiente hoje, como se não existisse
  (`worker/src/env.ts:isAdminBootstrapConfigured`);
- exige o segredo no cabeçalho `X-Admin-Bootstrap-Secret`, comparado em
  tempo constante (`worker/src/lib/crypto.ts:timingSafeEqualStrings`) —
  nunca por query string nem no corpo;
- nenhuma tela/link/botão consome este endpoint em lugar nenhum do
  frontend (adendo seção M).

`ADMIN_BOOTSTRAP_SECRET` **não** entra na lista `FORBIDDEN_DEV_VAR_NAMES`
de `scripts/check-deployable-d1-config.mjs`, ao contrário das flags
`ENABLE_LOCAL_*`/`DEV_*`: aquelas existem para conteúdo que NUNCA pode
alcançar produção; esta variável é, por desenho, a mesma que uma ordem
futura e separada do PO autorizaria configurar em produção via
`wrangler secret put` (seção 8.7 abaixo) — nunca commitada em nenhum
arquivo, nem local nem implantável.

### 8.5 Estado persistente (seção E do adendo)

`admin_bootstrap_state` (migration 0020) nasce **sempre vazia**. A
conclusão é representada pela EXISTÊNCIA da única linha permitida
(`id = 'singleton'`, forçado por `CHECK`) — nunca uma coluna `status`
mutável. "Bootstrap já concluído?" = `SELECT ... WHERE id = 'singleton'`.

### 8.6 One-shot real, atomicidade, idempotência (seções I/J/K)

A conclusão é um `INSERT` **simples** (nunca `OR IGNORE`, nunca um
`UPDATE`): uma segunda tentativa concorrente colide com a `PRIMARY KEY`
`'singleton'` e o SQLite/D1 **lança de verdade**, abortando o `db.batch()`
inteiro (rollback real — mesma garantia transacional documentada em
`https://developers.cloudflare.com/d1/worker-api/d1-database/#batch`).

Isto é deliberadamente diferente do erro corrigido na Sprint 11
(validar `meta.changes` em JavaScript DEPOIS que um lote já comitou, que
não é um rollback): aqui a garantia vem de uma violação REAL de
`PRIMARY KEY` levantada PELO PRÓPRIO banco durante a execução do lote,
antes de qualquer commit parcial — o mesmo lote inclui as duas concessões
de papel e os três eventos de auditoria, então "tudo ou nada" é garantido
pela transação, não por lógica de aplicação depois do fato.

Uma pré-checagem (`SELECT` antes do lote) existe só como OTIMIZAÇÃO —
evita todo o trabalho de validar e-mails/consultar contas quando o
bootstrap já está óbvio concluído — nunca como a garantia real (mesmo
princípio já estabelecido no projeto: `weeklyGoalEventIdInUse`/
`isUniqueEventIdViolation`).

Retry com o MESMO `mutationId`, mesmas contas: a pré-checagem já detecta
"concluído" e responde `{alreadyCompleted: true}` sem tocar o banco — nunca
duplica `user_roles` nem `audit_log`. Uma tentativa NOVA (mutationId
diferente, contas diferentes) depois de concluído recebe a MESMA resposta
`alreadyCompleted: true` — nunca revela se é retry legítimo ou tentativa de
adicionar um terceiro admin.

Provado sob **concorrência real forçada** (não só ordem "natural" de
`Promise.all`) em `worker/testing/adminBootstrap.test.ts`, usando
`pauseReadsMatching` (mesmo mecanismo de
`worker/testing/weeklyReviewAtomicity.test.ts`) para garantir que as duas
chamadas cheguem a tentar o `db.batch()` de verdade.

### 8.7 Autorização (seção H)

O segredo é comparado em tempo constante, nunca logado, nunca persistido
em texto puro (não existe NENHUMA coluna de segredo em
`admin_bootstrap_state`), nunca enviado ao frontend. `NÃO` foi configurado
nenhum segredo real nesta sprint — testado só localmente, com um valor de
teste inline em `worker/testing/adminBootstrap.test.ts`
(`test-only-bootstrap-secret-...`), nunca commitado em nenhum arquivo de
configuração.

### 8.8 Auditoria (seção L)

Três eventos por bootstrap bem-sucedido, todos no MESMO lote atômico:
`admin_role_assigned` × 2 (um por conta promovida, `userId: null` — nenhum
ator humano autenticado existe neste momento) + `admin_bootstrap_completed`
× 1. Metadados: só IDs internos das contas promovidas e o `mutationId` —
NUNCA o segredo, NUNCA senha, NUNCA dado pessoal além do necessário.

### 8.9 Contas-alvo e identificação (seções F/G)

Só promove contas JÁ EXISTENTES, localizadas por e-mail
(`findUserByNormalizedEmail`, único índice já existente desde a migration
0001 — "ambígua" é estruturalmente impossível). Nenhum e-mail é hardcoded
em código-fonte ou migration — os dois identificadores vêm sempre do corpo
da requisição, em tempo de execução. Nenhuma senha é criada, armazenada,
logada ou commitada em nenhum momento pelo bootstrap.

### 8.10 Como o mecanismo deixa de ser utilizável

Depois do primeiro sucesso, `admin_bootstrap_state` tem a linha
`'singleton'` para sempre — qualquer chamada futura (mesmo com o segredo
correto) recebe `{ok:true, alreadyCompleted:true}` e nenhuma escrita
acontece. Não existe endpoint/rota para apagar essa linha; a única forma de
"reabrir" seria uma migration/operação manual direta no banco, fora de
qualquer API — deliberadamente fora do alcance do frontend e de qualquer
fluxo autenticado normal.

### 8.11 Execução futura em produção (seção T)

Esta sprint só constrói e testa localmente (`worker/testing/
adminBootstrap.test.ts`, `FakeD1Database`, sem D1 remoto, sem deploy,
sem `wrangler secret put`). A utilização real (produção) exige uma ordem
separada do PO que: identifique exatamente as duas contas; confirme que
elas já existem em produção; confirme que o bootstrap ainda está pendente;
configure `ADMIN_BOOTSTRAP_SECRET` via `wrangler secret put` (nunca em
arquivo versionado); execute a chamada; verifique os dois papéis e a
auditoria; confirme o encerramento definitivo.

## 9. UX, responsividade, acessibilidade (seções 19-22)

Navegação: Visão Geral, Usuários, Vínculos — nenhum placeholder de
Planos/Pagamentos/Conteúdos/Banco de Questões/Auditoria visual/Suporte
(seção 19). Confirmação via `Modal` (seção 20) só para ações sensíveis:
remover papel, inativar vínculo — atribuir papel/criar/reativar vínculo
não usa modal (efeito sempre aditivo/restaurador). Após toda mutação, a
tela sempre relê o servidor (`load()`), nunca atualização otimista.
Botões desabilitados durante mutação em andamento (`isLoading`/
`disabled`). Testado em 1280px, 390px (mobile) e navegação por teclado —
`e2e/adminEssential.spec.ts`. Tabelas ficam dentro de um contêiner com
`overflow-x: auto` próprio (`.admin-page__table-wrap`) — o corpo da página
nunca rola horizontalmente.

## 10. Limitações conhecidas / itens adiados

- "Admin ativo" (proteção do último admin) usa só existência de papel —
  ver seção 6.1 para o raciocínio completo e por que uma semântica mais
  rica foi deliberadamente adiada.
- Mutação de papel/vínculo não usa o padrão completo de "identidade por
  `mutationId`" das Sprints 11-13 — ver seção 6 para a justificativa
  específica desta sprint.
- Criação de vínculo usa IDs brutos de usuário no formulário (não um campo
  de busca por nome/autocomplete) — a busca por nome já existe em
  `/admin/usuarios`, usada para localizar o ID antes de criar o vínculo.
  Um campo de busca integrado é uma melhoria de UX futura, não um risco de
  segurança/correção.
- Bootstrap não tem endpoint de status (`GET`) — decisão deliberada de
  superfície mínima (seção 8.4); o estado só é observável indiretamente
  (nova tentativa sempre responde `alreadyCompleted`).
