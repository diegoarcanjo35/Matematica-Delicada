# Painel Essencial do Professor e Acompanhamento Individual — Sprint 14 v1.0

## Objetivo

Dar ao papel Professor/Mentor a primeira experiência real da plataforma: uma área própria e
protegida onde um professor autorizado acompanha exclusivamente os alunos explicitamente
vinculados a ele, reutilizando 100% das evidências pedagógicas já produzidas pelas Sprints 3-13
(onboarding, diagnóstico, cronograma, padrões, banco de questões, Player, Caderno de Erros/revisão
espaçada, Mapa ENEM, treino diário, blocos de simulado, Relatório Semanal/Metas) através de
projeções somente leitura e sanitizadas. Esta sprint nunca inventa reconhecimento, resolução,
domínio, TRI, nota ou classificação pedagógica nova.

## Escopo desta sprint

Entregue:

- migration `0019_teacher_student_access.sql` (vínculo professor-aluno);
- reaproveitamento do RBAC já existente para o papel `teacher`;
- fixtures locais/técnicas do vínculo (nunca em D1 remoto, nunca criadas por GET);
- área `/professor`, `/professor/alunos`, `/professor/alunos/:studentId`;
- até 3 endpoints somente leitura sob `/api/teacher/*`;
- documentação e testes direcionados.

Fora do escopo (ver ordem, seção 26): gestão de turmas, convite/importação de aluno, atividades
atribuídas pelo professor, simulados do professor, observações privadas do professor,
comunicação/e-mail/WhatsApp/push, relatórios PDF/CSV, administração completa, TRI, estimativa de
nota, fórmula definitiva de reconhecimento/resolução/domínio, IA, D1 remoto, deploy. Nenhum desses
itens foi implementado.

## Modelo de autorização

Autorização de professor exige simultaneamente TRÊS fatores (ordem seção 6):

```text
usuário autenticado (sessão válida, mesmo checkSession do resto do projeto)
+ papel `teacher` (RBAC existente: roles/user_roles, migration 0008)
+ vínculo ATIVO teacher_student_access para o par exato (professor da sessão, aluno do path)
```

Regras aplicadas em toda rota `/api/teacher/*` (`worker/src/routes/teacher.ts` →
`worker/src/services/teacherService.ts`):

- `teacherId` nunca vem do cliente — é sempre `session.user.id`, derivado no servidor por
  `checkSession`;
- `studentId` sempre vem do path e é validado contra `teacher_student_access` no servidor antes de
  qualquer leitura de dado do aluno;
- vínculo inexistente e vínculo `inactive` respondem exatamente igual: **404**, nunca 403 — a rota
  nunca revela qual dos dois casos ocorreu (evita enumeração, seção 6/17);
- para `/api/teacher/dashboard` e `/api/teacher/students` (sem recurso de aluno específico), a
  ausência do papel `teacher` responde **403** — não há risco de enumeração aqui, pois não existe
  nenhum ID de terceiro no caminho;
- nenhuma rota permite alterar `teacher_id` arbitrariamente — não existe nenhum campo de
  `teacher_id` aceito em nenhuma requisição desta sprint.

## Vínculo professor ↔ aluno (`migrations/0019_teacher_student_access.sql`)

```sql
CREATE TABLE teacher_student_access (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users (id),
  student_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (teacher_id != student_id)
);
```

Invariantes garantidos pelo schema:

- `idx_teacher_student_access_pair` (UNIQUE `teacher_id, student_id`) — impede vínculo duplicado
  do mesmo par, independentemente de status. Reativar/inativar um vínculo é sempre um `UPDATE`
  nesta mesma linha (histórico preservado por inativação), nunca um segundo `INSERT`;
- `CHECK (teacher_id != student_id)` — impede um usuário virar "professor de si mesmo";
- `idx_teacher_student_access_teacher`/`idx_teacher_student_access_student` (ambos incluindo
  `status`) — toda checagem de autorização e toda listagem por professor são buscas diretas por
  índice.

A tabela não copia nenhum dado pessoal do aluno (só os dois IDs) e não guarda nenhum snapshot
pedagógico — todo fato exibido ao professor é lido em tempo real dos serviços existentes.

### Por que não há gate de runtime (`ENABLE_LOCAL_TEACHER_FIXTURES`) como nas Sprints 4-7

`teacher_student_access` é o mecanismo REAL de vínculo (ao contrário de
`diagnostic_questions`/`schedule_activities`/`patterns`/`questions`, que são conteúdo fictício por
natureza mesmo em produção futura). O caráter "só local" desta sprint está inteiramente em COMO as
linhas de demonstração são inseridas: só por `scripts/fixtures/teacher-fixtures.local.sql`, aplicado
manualmente contra o D1 local (`npm run db:seed:teacher:local`) — nunca por nenhum endpoint HTTP
(nenhum, nem dev-gated: a ordem seção 9 proíbe explicitamente qualquer API de criação de vínculo),
nunca automaticamente por GET, nunca contra D1 remoto. As contas de fixture têm nome
`[PROVISÓRIO]` e e-mail `@local.teste`, e nunca são apresentadas como dados reais.

## Papel Professor/Mentor — RBAC reaproveitado

Nenhum sistema novo de papéis foi criado. A tabela `roles` (migration `0008`) já incluía `'teacher'`
no `CHECK` desde a Sprint 7 — só nunca havia sido usado. `worker/src/lib/rbac.ts` ganhou
`resolveTeacherRole(db, userId)`, no mesmo formato de `resolveEditorialRole` já existente, consultando
`user_roles`/`roles` via `listRoleNamesForUser` (repositório já existente,
`worker/src/repositories/roleRepository.ts`, reaproveitado sem alteração). `admin`/`editor` NUNCA
herdam acesso de professor (ordem seção 8: "não ampliar permissões de editor/admin por
conveniência") — só a presença literal do papel `teacher` autoriza.

## Fixtures locais (ordem seção 9)

`scripts/fixtures/teacher-fixtures.local.sql` (aplicado via `npm run db:seed:teacher:local`, já
incluído em `npm run worker:preview`) cria sete contas fixas e quatro vínculos:

| Cenário | Professor | Aluno | Status |
|---|---|---|---|
| Vínculo ativo | `fixture-teacher-a` | `fixture-student-1` | active |
| Vínculo ativo | `fixture-teacher-a` | `fixture-student-2` | active |
| Vínculo ativo | `fixture-teacher-b` | `fixture-student-3` | active |
| Vínculo inativo | `fixture-teacher-b` | `fixture-student-1` | **inactive** |
| Professor sem alunos | `fixture-teacher-c` | — | — |
| Aluno sem professor | — | `fixture-student-4` | — |

Senha de todas as contas: `fixture-teacher-local-only-1` (hash PBKDF2 pré-computado com
`worker/src/lib/crypto.ts:hashPassword`, salt fixo zerado — nunca um segredo real). Login pela API
normal (`POST /api/auth/login`). Espelhado em TypeScript, para os testes unitários com
`FakeD1Database`, em `worker/testing/teacherFixtures.ts` — os dois arquivos precisam ser mantidos em
sincronia manualmente.

Nenhuma API de criação de vínculo foi implementada. A administração real de vínculos (criar/desfazer
pela UI) fica para uma sprint futura.

## Endpoints

Três endpoints, todos `GET`, todos estritamente somente leitura (nenhum cria vínculo, snapshot,
meta, evento de auditoria; nenhum altera `last_seen`; nenhum escreve cache; nenhum corrige dado
silenciosamente):

| Endpoint | Descrição |
|---|---|
| `GET /api/teacher/dashboard` | Contagens agregadas + seção "Para acompanhar" |
| `GET /api/teacher/students` | Lista paginada/filtrável/ordenável dos alunos vinculados |
| `GET /api/teacher/students/:studentId` | Acompanhamento individual consolidado |

A "sugestão máxima" da ordem (seção 14) previa até 5 endpoints, incluindo
`/students/:id/weekly-review` e `/students/:id/patterns` separados. Optamos por consolidar os dois
dentro de `GET /api/teacher/students/:studentId` — a página de acompanhamento individual sempre
precisa dos dois de uma vez (nunca um sem o outro), então dividir em requisições separadas só
adicionaria I/O e checagens de autorização redundantes sem nenhum ganho real (a mesma composição
melhor citada na própria ordem). Não existe um endpoint dedicado só para checar o papel
(`/api/teacher/me`): o frontend (`RequireTeacherRole.tsx`) reaproveita a própria chamada de
`GET /api/teacher/dashboard` — 403 nela já significa "sem papel de professor".

## Isolamento entre professores e dados exibidos

Toda consulta de listagem (`worker/src/repositories/teacherRepository.ts`) tem
`teacher_id = ? AND status = 'active'` no `WHERE` — nunca um filtro só na camada de aplicação.
Provado por teste (`worker/testing/teacher.test.ts`, "isolamento entre professores"): a lista do
professor B nunca inclui alunos exclusivos da professora A, mesmo que os dois estejam autenticados
simultaneamente.

### Dados visíveis ao professor

- nome do aluno;
- série (`student_profiles.current_grade`), só quando já preenchida no onboarding;
- última atividade, questões confirmadas recentes, dias com atividade recente, revisões vencidas,
  meta semanal ativa (lista/dashboard);
- no acompanhamento individual: relatório semanal factual (mesmos campos do Relatório Semanal do
  aluno, Sprint 13, exceto os que a própria Sprint 13 já não expõe), meta ativa e progresso
  factual (sem edição), treino do dia + itens de treino concluídos na semana, metadados do
  Caderno de Erros (contagens por status e por tipo de erro), padrões praticados com o mesmo
  estado provisório de 5 rótulos já usado no Mapa ENEM do aluno (Sprint 10).

### Dados deliberadamente ocultos (ordem seção 15/18)

Nunca retornados por nenhum endpoint desta sprint: senha/hash, tokens, sessões, e-mail de
recuperação, e-mail do aluno (sem necessidade funcional), respostas livres do onboarding,
anotação livre do Caderno de Erros (`student_note`), denúncias textuais, dados de suporte,
conteúdo administrativo, IDs internos desnecessários no frontend. A minimização acontece
inteiramente no Worker (`teacherService.ts` monta cada DTO campo a campo, nunca faz `...spread`
de um objeto interno) — nunca "escondida" só no frontend. Provado por teste
(`worker/testing/teacher.test.ts`, "nunca expõe campos privados"): uma anotação privada real
semeada no banco nunca aparece no corpo bruto da resposta HTTP.

## Regra factual de "atividade recente"

Constante técnica única e centralizada:
`worker/src/lib/teacherRules.ts:RECENT_ACTIVITY_WINDOW_DAYS = 7`. Um aluno sem nenhuma tentativa
confirmada (`question_attempts.status = 'completed'`) nos últimos 7 dias corridos entra na
categoria "sem atividade registrada nos últimos 7 dias" — nunca um julgamento ("fraco",
"desinteressado", "em risco"). O mesmo corte de tempo é usado consistentemente pelo dashboard e
pela lista de alunos (`recentCutoffIso`, `teacherService.ts`).

## Desenho das consultas e prevenção de N+1

O dashboard e a lista de alunos usam **uma única consulta agregada** (`listStudentsForTeacher`/
`listAllActiveStudentsForTeacher`/`countStudentsForTeacher`, todas apoiadas na mesma CTE
`buildStudentAggregateQuery` em `worker/src/repositories/teacherRepository.ts`), nunca um loop
chamando um serviço por aluno. Cada fato (última atividade, questões recentes, revisões vencidas,
entradas pendentes do Caderno de Erros, meta ativa) vem de um `LEFT JOIN` com uma sub-consulta
`GROUP BY user_id`, e cada sub-consulta é escopada por
`user_id IN (SELECT student_id FROM teacher_student_access WHERE teacher_id = ? AND status = 'active')`
— o custo cresce com o número de alunos DESTE professor, nunca com o total de usuários da
plataforma. `search`/`filter`/`sort`/`limit`/`offset` são sempre aplicados no SQL.

O acompanhamento individual (`getStudentDetail`) faz `Promise.all` de seis leituras independentes
(perfil, relatório semanal, padrões, resumo do Caderno de Erros, contagem por tipo de erro, treino
de hoje) — uma requisição por aluno visualizado, não uma por métrica multiplicada por aluno
listado.

## Dashboard (`/professor`)

- "Alunos vinculados": quantidade ativa total, quantos têm evidência na janela técnica, quantos
  não têm;
- "Para acompanhar" (`worker/src/lib/teacherRules.ts:deriveAttentionReasons`): lista só alunos com
  ao menos um dos quatro critérios 100% factuais — revisão vencida existente; ausência de
  atividade na janela técnica; meta ativa sem evidência registrada até o momento (a combinação das
  duas condições anteriores); Caderno de Erros com entrada pendente. Cada item mostra o fato
  objetivo que o colocou ali — nenhuma recomendação pedagógica automática definitiva, nenhum rótulo
  "padrão mais frágil" (não existe fórmula aprovada para essa classificação).

## Lista de alunos (`/professor/alunos`)

Busca por nome (`LIKE ... COLLATE NOCASE`), ordenação (`nome_asc`/`nome_desc`/
`atividade_recente_desc`/`revisoes_vencidas_desc`), filtros técnicos (`com_atividade_recente`,
`sem_atividade_recente`, `com_revisao_vencida`, `com_meta_ativa`, `com_caderno_pendente`) e
paginação — todos resolvidos no SQL. Parâmetro inválido de filtro/ordenação nunca quebra a rota
(cai no padrão). Página muito alta retorna lista vazia, nunca erro (ordem seção 17: "paginação
abusiva").

## Acompanhamento individual (`/professor/alunos/:studentId`)

Consolida, sem duplicar nenhuma regra: `getReportForWeek` (weeklyReviewService, Sprint 13) para
resumo/semana/meta; `listPatternMetrics` (studentMetricsService, Sprint 10) para padrões;
`summaryForUser` + `countByErrorType` (errorNotebookRepository, Sprint 9, com uma função nova de
contagem por tipo adicionada nesta sprint) para metadados do Caderno de Erros; `getCurrent`
(dailyTrainingService, Sprint 12) para o treino do dia. O professor nunca pode editar a meta do
aluno (nenhum endpoint de escrita existe nesta sprint). Se reconhecimento/resolução/domínio
continuam indisponíveis por falta de fórmula definitiva do lado do aluno, continuam indisponíveis
aqui também — nenhum percentual é fabricado.

## Estados vazios

Tratados explicitamente em todas as combinações: professor sem alunos vinculados; aluno sem
atividade; aluno sem meta; aluno sem Caderno de Erros; aluno sem revisões; aluno sem evidência no
período. Texto sempre factual ("Ainda não há evidências registradas neste período.",
"Nenhuma meta semanal registrada para este período.", "Nenhum registro no Caderno de Erros
ainda."), nunca um "0%"/zero fabricado.

## Ausência de fórmula pedagógica definitiva / ausência de TRI

Esta sprint não cria nenhuma fórmula nova. O único "estado" exibido para padrões é o mesmo rótulo
provisório de 5 estados já aprovado e usado pelo próprio aluno desde a Sprint 10
(`worker/src/lib/studentMetricsRules.ts:PROVISIONAL_STATE_LABELS`) — nunca uma segunda versão
dessas regras. TRI, estimativa de nota e qualquer classificação de "domínio"/"resolução"
definitiva continuam fora do escopo da plataforma inteira, não só desta sprint.

## Testes direcionados

Ver relatório da sprint para a contagem final por arquivo. Cobertura:

- `worker/testing/migration0019.test.ts` — schema real (`node:sqlite`): criação, idempotência,
  `CHECK`s (status, `teacher_id != student_id`), unicidade do par, múltiplos vínculos por
  professor/aluno, índices, inativação preservando histórico;
- `worker/testing/teacher.test.ts` — autorização (professor autorizado/não vinculado/errado/aluno
  comum/não autenticado/vínculo inativo/404 indistinguível), dashboard (sem alunos, agregação,
  isolamento, ausência de evidência, dados factuais corretos, nenhum GET escreve), lista
  (busca/filtro/paginação/paginação abusiva/parâmetro inválido), acompanhamento individual
  (conteúdo presente, campos privados ausentes);
- `e2e/teacherDashboard.spec.ts` — os 12 cenários da ordem (seção 23) em Chromium real, contra o
  Worker local, login sempre pelas contas fixas de fixture (nunca contas dinâmicas, já que não há
  API para criar vínculo em cima delas).

## Limitações e decisões pendentes

- A seção "Padrões" do dashboard (ordem seção 11: "Pode exibir... padrões mais praticados") não
  foi implementada nesta v1.0 — é explicitamente opcional na ordem, e uma agregação cruzada de
  padrões por MÚLTIPLOS alunos ao mesmo tempo exigiria uma consulta adicional não trivial; decisão
  deliberada de escopo, não uma omissão silenciosa;
- "meta ativa sem evidência registrada até o momento" (um dos motivos de "Para acompanhar") é
  aproximado pela combinação "tem meta ativa E não tem atividade na janela técnica de 7 dias" —
  não é uma checagem estrita "meta ativa PARA a semana atual sem nenhuma questão feita NAQUELA
  semana especificamente" (isso exigiria juntar a semana da meta com a janela de atividade recente,
  que podem não coincidir); documentado aqui para a próxima sprint decidir se vale refinar;
- não existe nenhuma tela de administração de vínculos (criar/inativar) — só o SQL de fixture
  local, exatamente como a ordem pede para esta sprint;
- a série do aluno (`current_grade`) só aparece quando o próprio aluno já preencheu o onboarding;
  sem isso, a tela mostra "Série não informada", nunca um valor fabricado;
- gestão completa de turmas continua fora do escopo da plataforma — não é entregue por esta
  sprint nem por nenhuma anterior.

## Próximos passos (fora desta sprint)

- administração real de vínculos (criar/inativar pela UI, atrás de um fluxo de convite ou
  aprovação);
- gestão de turmas;
- comunicação professor→aluno;
- relatórios exportáveis (PDF/CSV) quando houver necessidade real validada.
