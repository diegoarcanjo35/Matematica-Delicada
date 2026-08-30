# Padrões ENEM — Sprint 6 v1.0

Fundação técnica da taxonomia de padrões recorrentes do ENEM e das telas
`/padroes-enem` (catálogo) e `/padroes-enem/:slug` (ficha do padrão).

## Escopo e não escopo

**Esta sprint entrega:**

- modelo de dados revisável para padrões (migration `0007_patterns_foundation.sql`);
- estruturas multivaloradas sem lista separada por vírgula;
- relações dirigidas entre padrões, com tipo fechado;
- catálogo e ficha técnica do padrão para o aluno;
- busca, filtros, paginação e estados de interface;
- estrutura de progresso individual preparada para os três índices, sem inventar fórmulas;
- fixtures estritamente locais e provisórias, atrás de gate de falha fechada;
- acessibilidade, isolamento por usuário, testes e esta documentação.

**Esta sprint NÃO entrega:**

- banco editorial completo de questões nem importação em lote;
- player de questão;
- treino diário real;
- fórmula dos três índices (Reconhecimento, Resolução, Domínio);
- taxonomia oficial definitiva;
- conteúdo pedagógico pronto para produção;
- endpoints editoriais/admin (virão em sprint própria, com RBAC real).

## Referência ao Documento Mestre

Seções 2, 5, 24, 36–40 e 42–45 do
`Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md`. A ficha do padrão
segue a seção 2.3. O Documento Mestre **não foi alterado** nesta sprint.

Os cinco nomes usados nas fixtures locais são exatamente os citados
literalmente no Documento Mestre: Razão em Gráfico, Escala, Porcentagem
Direta, Mediana e Frequência, Projeção Ortogonal. O eixo inicial deverá
trabalhar futuramente com **aproximadamente** 20 padrões — número não rígido,
e por isso nenhuma quantidade fixa de padrões aparece como texto na interface.

## Schema — migration 0007

Aditiva (`CREATE TABLE/INDEX IF NOT EXISTS`), sem alterar nenhuma tabela das
Sprints 1–5.

| Tabela | Papel |
| --- | --- |
| `patterns` | definição de um padrão: `code` e `slug` únicos, nome, frase de reconhecimento, descrição, estratégia principal, exemplo introdutório, resumo estratégico, `editorial_status`, `version`, `is_local_fixture`, datas |
| `pattern_attributes` | TODAS as estruturas multivaloradas, com enum fechado em `attribute_type` |
| `pattern_relations` | relação dirigida entre dois padrões, com tipo fechado |
| `student_pattern_progress` | progresso de UM aluno em UM padrão (PK composta `user_id + pattern_id`) |

Índices e restrições:

- `idx_patterns_code` e `idx_patterns_slug` — únicos;
- `idx_patterns_editorial_status` — consulta do catálogo (só `published`);
- `idx_pattern_attributes_lookup` em `(pattern_id, attribute_type, position)`;
- `idx_pattern_relations_unique` em `(from_pattern_id, to_pattern_id, relation_type)` — impede duplicidade da mesma relação exata;
- `CHECK (from_pattern_id != to_pattern_id)` — impede auto-relação;
- `idx_student_pattern_progress_user` — consulta escopada ao aluno.

A migration **só cria estrutura**: não insere nenhum padrão, atributo, relação
ou progresso (provado em `worker/testing/migration0007.test.ts`).

### Decisão de modelagem das estruturas multivaloradas

A ordem permite tabelas-filhas tipadas **ou** uma tabela de atributos com enum
fechado, exigindo justificar a escolha. Optamos por **uma única tabela
genérica `pattern_attributes` com enum fechado de `attribute_type`**, cobrindo
as oito categorias:

`frequent_clue` (pistas frequentes), `recurring_phrase` (palavras/expressões
recorrentes), `recurring_visual_element` (elementos visuais recorrentes),
`alternative_strategy` (estratégias alternativas), `required_content`
(conteúdos matemáticos), `prerequisite_content` (pré-requisitos),
`common_mistake` (erros/pegadinhas frequentes), `tag` (tags).

**Justificativa.** As oito categorias são estruturalmente idênticas: cada uma
é uma lista ordenada de textos curtos pertencente a um padrão — exatamente
`(pattern_id, position, content)`. Oito tabelas-filhas seriam oito cópias do
mesmo DDL, oito índices equivalentes e oito consultas quase iguais no
repositório, sem ganhar nenhuma restrição que a tabela única não ofereça. Com
a tabela única, o schema fica DRY e uma consulta só carrega todos os
atributos de um padrão (ou de uma página inteira do catálogo). O enum fechado
preserva a mesma garantia de integridade que tabelas tipadas dariam: um
`attribute_type` fora da lista é rejeitado pelo banco.

**Correção (v1.1) — evoluir o enum exige migration, não é grátis.** A tabela
genérica evita criar uma tabela nova *por categoria*, mas **não** evita
migration ao evoluir o próprio enum. Como `attribute_type` usa `CHECK`
fechado, adicionar ou remover um tipo é uma alteração de schema como qualquer
outra e exige uma migration versionada, igual a qualquer mudança em
`patterns.editorial_status` ou em `schedule_activity_assignments.status` nas
sprints anteriores. Em SQLite/D1 não existe `ALTER TABLE ... DROP/ADD CHECK`
direto — o caminho normal é: criar uma tabela substituta com o novo `CHECK`,
copiar os dados da tabela antiga para a nova, validar a contagem/integridade
copiada, trocar o nome das tabelas (`ALTER TABLE ... RENAME TO`) e recriar os
índices sobre a tabela final. A migration `0007` já publicada **nunca é
reescrita** para acomodar um tipo novo — uma migration futura (`0008`, `0009`,
…) é que faz essa evolução, e ela deve preservar todos os `id`, `position` e
FKs (`pattern_id`) das linhas existentes, sem perder nenhum dado. Manter o
enum fechado continua sendo a escolha correta (ver "custo aceito" abaixo) —
a resposta certa ao custo de evoluir o enum é aceitar a migration quando
necessário, nunca trocar `attribute_type` por texto livre só para evitá-la.

**Custo aceito e conscientemente escolhido.** A tabela genérica não permite
colunas específicas por categoria (se, no futuro, "elemento visual" precisar
de um campo próprio como referência de imagem, será necessário evoluir o
modelo). Nesta fundação nenhuma categoria tem campo específico, então o custo
é hipotético e o ganho é imediato. O mesmo vale para o próprio enum: adicionar
um nono tipo de atributo é uma migration pequena e localizada (criar/copiar/
trocar/reindexar), não uma reestruturação do schema — um custo aceitável em
troca de nunca precisar de uma nona tabela-filha hoje.

Nenhum campo guarda lista separada por vírgula — cada item é uma linha
própria (testado em `worker/testing/migration0007.test.ts`).

### Relações entre padrões

`pattern_relations` é **dirigida**: a aresta vai DO padrão da ficha PARA o
padrão relacionado. `prerequisite` significa "o destino é pré-requisito da
origem". Tipos: `related`, `prerequisite`, `often_confused_with`.

Auto-relação é bloqueada por `CHECK`; a mesma tripla
`(origem, destino, tipo)` é bloqueada por índice único. Dois tipos
**diferentes** entre o mesmo par continuam permitidos de propósito (A pode
ser `related` a B e, ao mesmo tempo, B ser `prerequisite` de A).

As relações usam o **ID estável** do padrão, nunca `slug` ou `code`.

### Impacto de alterar `slug` e `code`

`code` e `slug` são identificadores revisáveis e únicos, e não dependem de
ordem física na tabela. Como toda relação interna (`pattern_attributes`,
`pattern_relations`, `student_pattern_progress`) referencia o `id`, renomear
um `slug` ou um `code` **não quebra nenhuma aresta nem nenhum progresso de
aluno**. O impacto de mudar um `slug` é externo: URLs `/padroes-enem/:slug` já
compartilhadas passam a responder 404. Quando houver editor real, uma sprint
futura deverá tratar redirecionamento de slug antigo — não há nada disso
nesta fundação.

## Padrão × dimensões complementares

Um **padrão** é a situação recorrente que se repete nas provas: como
reconhecê-la e por onde começar a resolvê-la. Cada questão poderá ter um
padrão principal e padrões secundários.

**Assunto, habilidade, dificuldade e origem são dimensões complementares** —
descrevem a questão, não o padrão, e por isso **não** viraram colunas de
`patterns` nesta sprint. Os conteúdos matemáticos e pré-requisitos que
aparecem na ficha (`required_content`, `prerequisite_content`) descrevem o que
o padrão exige, não classificam a questão. O vínculo formal
padrão ↔ questão ↔ dimensões chega junto com o banco de questões, em sprint
própria.

## Status editorial

Enum técnico fechado, com seis valores:

`draft`, `in_review`, `changes_requested`, `approved`, `published`, `archived`.

Só `published` é exposto ao aluno — em **todas** as consultas, incluindo as
relações (uma relação apontando para um rascunho não aparece na ficha). Slug
inexistente e slug não publicado produzem **exatamente a mesma resposta 404**,
byte a byte, para não permitir descobrir a existência de conteúdo editorial em
preparação.

A coluna `version` existe desde já para concorrência otimista quando houver
endpoint editorial; nesta sprint nada a incrementa, porque nada escreve.

## Gate local e fixtures

Mesma falha fechada das Sprints 2–5, com **três condições simultâneas**
(`worker/src/env.ts:isLocalPatternFixturesAllowed`):

1. `ENVIRONMENT` é exatamente `development` ou `test`;
2. `ENABLE_LOCAL_PATTERN_FIXTURES === "true"` — flag exclusiva de
   `wrangler.local.jsonc`;
3. o hostname da URL **efetivamente recebida** é `localhost`/`127.0.0.1`/`[::1]`
   — nunca `X-Forwarded-Host`, nunca `*.workers.dev`, nunca domínio customizado.

Fora disso, os três endpoints respondem `200 { ok: true, available: false,
message: "O catálogo de padrões está em preparação pedagógica." }` **sem tocar
em nenhuma tabela `pattern_*`** — nunca 404, nunca 500, nunca vestígio de
conteúdo.

`scripts/check-deployable-d1-config.mjs` bloqueia o deploy se
`ENABLE_LOCAL_PATTERN_FIXTURES` aparecer em `wrangler.jsonc`.

As fixtures vivem em `scripts/fixtures/patterns-fixtures.local.sql`, aplicadas
só manualmente contra o D1 **local**:

```bash
npm run db:seed:patterns:local
```

Todo texto pedagógico das fixtures carrega a marcação literal
`[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR]`, e a
interface repete o aviso em cada card e em cada ficha marcada como
`is_local_fixture`. Nada disso é conteúdo revisado ou aprovado pela Andreia.
O seed é idempotente (`INSERT OR IGNORE` com IDs determinísticos) e **não cria
nenhuma linha de progresso de aluno**.

## Contratos dos três endpoints

Todos exigem sessão válida (401 sem sessão) e são **estritamente somente
leitura**. Qualquer método diferente de `GET` sob `/api/patterns` responde
`405` sem tocar no banco.

### `GET /api/patterns`

Parâmetros (todos opcionais):

| Parâmetro | Valores | Padrão |
| --- | --- | --- |
| `busca` | texto até 120 caracteres | sem busca |
| `conteudo` | conteúdo matemático exato | sem filtro |
| `tag` | tag exata | sem filtro |
| `evidencia` | `todos`, `com_evidencia`, `sem_evidencia` | `todos` |
| `ordenar` | `codigo`, `nome` | `codigo` |
| `pagina` | inteiro ≥ 1 | `1` |
| `limite` | inteiro de 1 a 50 | `6` |

Resposta:

```json
{
  "ok": true,
  "available": true,
  "patterns": [
    {
      "code": "PAD-01",
      "slug": "razao-em-grafico",
      "name": "Razão em Gráfico",
      "recognitionPhrase": "…",
      "requiredContents": ["…"],
      "tags": ["…"],
      "isLocalFixture": true,
      "progress": { "hasProgress": false, "lastPracticedAt": null, "nextReviewAt": null,
                    "indices": { "recognition": { "available": false, "value": null },
                                 "resolution":  { "available": false, "value": null },
                                 "mastery":     { "available": false, "value": null } } }
    }
  ],
  "page": 1, "pageSize": 6, "total": 5, "totalPages": 1
}
```

### `GET /api/patterns/:slug`

Ficha completa: tudo do resumo mais `description`, `mainStrategy`,
`introductoryExample`, `strategicSummary`, `frequentClues`,
`recurringPhrases`, `recurringVisualElements`, `alternativeStrategies`,
`prerequisiteContents`, `commonMistakes`, `relations[]` e
`availableQuestionCount`.

`availableQuestionCount` é **zero real**: não existe banco de questões ligado a
padrão nesta sprint, então nenhuma questão está associada. Não é um número
pedagógico estimado.

404 para slug inexistente, slug não publicado e slug malformado — sempre a
mesma resposta.

### `GET /api/patterns/:slug/progress`

Devolve `{ ok, available, slug, code, progress }` com o progresso **do aluno
da sessão**, ou `hasProgress: false` com os três índices indisponíveis quando
ele nunca praticou. **Nunca cria a linha.**

## Paginação e filtros

- `total` e a página retornada vêm da MESMA cláusula `WHERE` (contagem e
  listagem compartilham o construtor de filtro), então nunca divergem.
- Ordenação sempre determinística: chave escolhida, depois `code`, depois `id`
  — nunca ordem de inserção.
- Página além do fim devolve lista vazia com o `total` correto, nunca 404 e
  nunca "corrigida" silenciosamente para a última.
- Limite fora da faixa 1–50 é **rejeitado com 400**, nunca saturado no teto.
- Busca textual usa `LIKE` parametrizado com `ESCAPE`, de modo que `%` e `_`
  digitados pelo aluno são texto literal, não curinga. Limitação conhecida: o
  `LIKE` do SQLite só é insensível a maiúsculas para ASCII — buscas com acento
  são sensíveis a caixa.
- `evidencia=com_evidencia` significa apenas "existe linha de progresso deste
  aluno com ao menos um dos três índices não nulo". Uma linha de progresso com
  os três índices `NULL` **não** conta como evidência.

## Regra dos índices `NULL`

As fórmulas dos três índices estão **pendentes**. Portanto:

- as colunas `recognition_index`, `resolution_index` e `mastery_index` aceitam `NULL`;
- nenhum valor fictício é calculado em nenhuma camada;
- a API representa a indisponibilidade **explicitamente**, como
  `{ "available": false, "value": null }`;
- a interface mostra literalmente **"Ainda sem evidências suficientes"** —
  nunca `0`, nunca `0%`, nunca um traço que sugira cálculo.

Isso é testado do banco até a UI: no schema
(`worker/testing/migration0007.test.ts`), no serviço e na API
(`worker/testing/patterns.test.ts`) e na tela (`e2e/patterns.spec.ts`).

## Isolamento por usuário

Dados de progresso pertencem exclusivamente ao usuário da sessão. O `user_id`
vem **sempre** da sessão validada em `worker/src/routes/patterns.ts`, nunca de
parâmetro de URL ou corpo, e o escopo está no `WHERE` do SQL
(`student_pattern_progress.user_id = ?`), não apenas na camada de aplicação —
inclusive dentro do `EXISTS` do filtro de evidência. Nenhuma resposta contém
`user_id`, `raw_evidence_count`, `editorial_status`, `version`, `id` interno ou
datas de auditoria editorial.

## Prova de que todo `GET` é somente leitura

- `worker/src/repositories/patternsRepository.ts` não contém nenhum
  `INSERT`/`UPDATE`/`DELETE` — só `SELECT`.
- Nenhum endpoint desta sprint chama `db.batch()` nem `.run()`.
- Nenhum evento de auditoria de padrão foi criado: `AuditEventType` continua
  sem entrada `pattern_*`, porque não há mutação a auditar.
- Teste dedicado repete os três GETs três vezes juntos e compara a contagem de
  linhas de sete tabelas (incluindo `audit_log`) antes e depois — tudo
  idêntico (`worker/testing/patterns.test.ts`, describe "GET é estritamente
  somente leitura").
- **Correção B (v1.1):** além do teste combinado acima, cada um dos três
  endpoints tem prova **separada e dedicada**, repetida no mínimo cinco vezes
  cada — incluindo variações de busca/filtro/paginação na listagem, slug
  inexistente e não publicado na ficha, e uma rodada inteira fora do gate
  local — sempre consultando as cinco tabelas exigidas
  (`patterns`, `pattern_attributes`, `pattern_relations`,
  `student_pattern_progress`, `audit_log`) diretamente no banco antes/depois,
  nunca só por busca textual no código-fonte
  (`worker/testing/patterns.test.ts`, describe "Correção B (v1.1) — prova de
  leitura pura, separada por endpoint, ≥5 repetições").

## Acessibilidade

- Todo filtro tem `<label>` visível associado ao controle.
- A contagem de resultados é anunciada por região `role="status"`
  `aria-live="polite"`.
- Navegação completa por teclado; foco visível herdado dos tokens globais.
- Nenhum estado é comunicado só por cor: o índice indisponível é comunicado
  pelo texto "Ainda sem evidências suficientes" (o itálico é reforço, não
  sinal único).
- Sem rolagem horizontal em 360/390/768/1280/1440 px (grade fluida
  `auto-fill`/`minmax`, campos com `flex-basis` e `max-width: 100%`).
- Nenhum `dangerouslySetInnerHTML`; todo conteúdo é texto renderizado por React.
- Botão "Treinar este padrão" é um `<button>` nativo desabilitado, com
  explicação textual do porquê ao lado — não um link falso nem um controle que
  parece ativo.

## Decisões provisórias

1. **Tabela genérica de atributos** em vez de oito tabelas-filhas (justificada acima).
2. **Códigos `PAD-01`…`PAD-05`** nas fixtures são identificadores técnicos de
   desenvolvimento, não a numeração oficial da taxonomia.
3. **`availableQuestionCount` fixo em zero** enquanto não existir vínculo
   padrão ↔ questão.
4. **Opções dos filtros de conteúdo/tag derivadas dos padrões realmente
   publicados**, nunca de uma lista fixa escrita no frontend — para não
   petrificar taxonomia antes da análise do acervo.
5. **`evidencia` como filtro de disponibilidade**, não de faixa de domínio —
   qualquer faixa dependeria da fórmula pendente.
6. **Uma relação é dirigida e assimétrica**: a fixture registra explicitamente
   os dois sentidos quando faz sentido, em vez de o código inferir o inverso.

## Limitações conhecidas

- `LIKE` do SQLite não dobra maiúsculas/minúsculas acentuadas (ver acima).
- Não há paginação por cursor: `LIMIT/OFFSET` é suficiente para a ordem de
  grandeza desta fundação (~20 padrões).
- Não há redirecionamento de `slug` antigo após renomeação.
- Não há endpoint editorial, então `version` e os status intermediários do enum
  ainda não são exercitados por nenhum fluxo de escrita real.
- O card do dashboard faz duas leituras do mesmo endpoint (total e total com
  evidência) por não existir endpoint de resumo — deliberado, para não criar
  um quarto endpoint fora do escopo da ordem.

## Próximos passos

1. **Banco de questões e importação em lote**, com vínculo padrão principal /
   padrões secundários e as dimensões complementares (assunto, habilidade,
   dificuldade, origem).
2. **Player de questão** e registro de evidência real de reconhecimento e de
   resolução.
3. **Fórmulas dos três índices** (Reconhecimento, Resolução, Domínio),
   aprovadas pedagogicamente — só então `student_pattern_progress` passa a ter
   valores e a UI passa a exibir números.
4. **Treino por padrão**, habilitando de fato o botão "Treinar este padrão".
5. **Editor/admin editorial com RBAC real**, exercitando `editorial_status` e
   `version` (concorrência otimista) e o fluxo de revisão.
