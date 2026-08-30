# Banco de Questões e Importação Editorial — Sprint 7 v1.1

> v1.1 corrige três pontos apontados na auditoria da v1.0: semântica PATCH
> parcial de verdade (Correção A), política CSV que não bloqueia matemática
> legítima (Correção B), e algoritmo de fingerprint explícito, documentado e
> testado diretamente (Correção C, ver seção "Fingerprint" abaixo).

## Escopo e não escopo

Esta sprint constrói a fundação editorial do Banco de Questões: modelo completo de
questão/alternativas/imagens/padrões/DNA, RBAC mínimo real (editor/admin), CRUD
editorial seguro, workflow versionado com atomicidade, importação CSV com prévia,
validação/duplicidade/erro por linha, aplicação como rascunho, desfazer lote,
interface editorial desktop/mobile, fixtures locais, testes e documentação.

Não escopo (adiado para sprints futuras): player do aluno, tentativas/respostas,
treino diário, Caderno de Erros, cálculo dos três índices (Reconhecimento,
Resolução, Domínio), upload remoto de mídia/R2, questões oficiais reais, conteúdo
pedagógico definitivo, publicação em produção, D1 remoto ou deploy.

## Schema — migration 0008

`migrations/0008_question_bank_editorial.sql` é puramente aditiva (só
`CREATE TABLE/INDEX IF NOT EXISTS`) sobre o schema das Sprints 1-6. Nenhum
conteúdo é inserido pela migration.

Tabelas criadas:

- `roles` / `user_roles` — RBAC extensível (seis papéis conhecidos do Documento
  Mestre; esta sprint só wireia `editor`/`admin` a algo real).
- `questions` — registro central: código único, enunciado, resolução comentada,
  conteúdo/subconteúdo/habilidade/competência, dificuldade (`facil`/`media`/
  `dificil`), origem (`oficial`/`autoral`/`licenciada`/`diagnostico`/
  `reconhecimento`/`revisao_base`), prova/ano/tempo estimado/tipo de
  cálculo/necessidade de calculadora, status editorial, autor/revisor,
  titular de direitos/base de licença/atribuição, `fingerprint`, `version`
  (concorrência otimista), `is_local_fixture`, datas.
- `question_alternatives` — uma linha por letra A-E (`UNIQUE(question_id, letter)`),
  texto não vazio (`CHECK`), indicação de correta, explicação opcional do
  distrator, posição estável.
- `question_images` — metadados apenas (sem upload remoto nesta sprint):
  referência local, alt (pode nascer vazio, exigido antes de revisão pelo
  serviço), legenda, ordem, direitos/licença.
- `question_patterns` — FK para `patterns.id` (nunca slug/code), papel
  `principal`/`secundario`; `UNIQUE(question_id, pattern_id)` impede o mesmo
  padrão como principal E secundário; índice único parcial garante no máximo
  um principal por questão.
- `question_tags` — relação multivalorada normalizada dedicada.
- `question_dna` — um-para-um com a questão: pista, estratégia, pegadinha,
  conteúdo de apoio, resolução, atalho (opcional) e aprendizado do erro.
- `question_history` — append-only: questão, usuário responsável, ação, estado
  anterior/novo, versão, metadados mínimos não sensíveis, data. Nunca guarda o
  texto integral da questão/resolução.
- `question_import_batches` / `question_import_items` — registro técnico leve
  de prévia/lote de importação, com expiração, e o mapeamento lote→questão
  criada (usado pelo undo).

### Por que `question_tags` é uma tabela dedicada (não a genérica `pattern_attributes`)

A Sprint 6 criou `pattern_attributes` como tabela genérica porque um padrão tem
OITO tipos de atributo multivalorado diferentes (pistas, frases, elementos
visuais, estratégias alternativas, conteúdos, pré-requisitos, erros, tags) —
uma tabela genérica evitou oito tabelas quase idênticas. Uma questão, nesta
sprint, tem apenas UM atributo multivalorado (tags); o DNA é modelado como
colunas dedicadas (um-para-um, não multivalorado) porque cada componente tem
semântica própria e sempre existe no máximo uma vez por questão. Criar uma
tabela genérica de "atributo de questão" para um único tipo seria
over-engineering — por isso `question_tags` é uma tabela normal e dedicada.

### Invariantes que o SQLite/D1 não expressam em CHECK — impostos no serviço

- Exatamente 5 alternativas por questão, exatamente uma correta.
- Imagem sem texto alternativo não pode avançar para revisão.
- Padrão principal obrigatório antes de revisão.
- Componentes obrigatórios do DNA completos antes de aprovação/publicação.
- Direitos/licença completos antes de publicação.

Todos provados por teste em `worker/testing/questions.test.ts` e
`worker/testing/migration0008.test.ts`.

## RBAC

Papéis modelados em `roles`/`user_roles`, nunca confiados a partir do cliente:
`worker/src/lib/rbac.ts:resolveEditorialRole` deriva o papel efetivo SEMPRE
consultando o banco pelo `user_id` da sessão já validada pelo servidor.
`admin` herda tudo que `editor` pode fazer.

- Sem papel → API editorial responde 403 (corpo genérico, nunca vaza
  conteúdo); rotas de interface mostram estado de acesso negado
  (`src/auth/RequireEditorialRole.tsx`).
- Sem sessão → 401 (nunca 403 — não revela se o problema é "sem sessão" ou
  "sem papel").

### Bootstrap local

`worker/src/env.ts:isLocalEditorialFixturesAllowed` — mesmo padrão de falha
fechada dos outros gates do projeto (ambiente development/test + flag
exclusiva `ENABLE_LOCAL_EDITORIAL_FIXTURES` de `wrangler.local.jsonc` +
hostname local reconhecido, nunca `X-Forwarded-Host`). Atrás desse gate,
`POST /api/dev/editorial/bootstrap-role` (`worker/src/routes/dev.ts`) concede
`editor`/`admin` **apenas ao próprio usuário da sessão autenticada** — nunca
um GET, nunca a outro usuário, idempotente (`INSERT OR IGNORE`).
`scripts/check-deployable-d1-config.mjs` bloqueia a flag em `wrangler.jsonc`.

## Campos obrigatórios por etapa

| Etapa | Exigências |
| --- | --- |
| Criação (`draft`) | código, enunciado, dificuldade, origem, 5 alternativas (mesmo incompletas), DNA (mesmo incompleto) |
| Envio para revisão | 5 alternativas válidas (uma correta, sem vazias), toda imagem com alt, padrão principal presente |
| Aprovação | tudo do envio para revisão + DNA completo (todos os campos obrigatórios não vazios) |
| Publicação | tudo da aprovação + titular de direitos + base de licença + autor + revisor preenchidos |

## Workflow editorial

Matriz (`worker/src/lib/questionsValidation.ts:QUESTION_TRANSITIONS`):

```
draft → in_review → changes_requested → in_review → approved → published
qualquer estado não-published elegível → archived
```

- Toda mutação exige `version` (concorrência otimista); versão desatual → 409.
- Transição + histórico são escritos no MESMO `db.batch()`
  (`worker/src/services/questionService.ts:applyTransition`), mesmo padrão de
  `scheduleService.ts:applyGuardedTransition`.
- **Idempotência**: diferente do cronograma (onde cada `to_status` só é
  alcançado uma única vez de verdade), no Banco de Questões um mesmo
  `to_status` pode se repetir em rodadas diferentes (ex.: `in_review`
  aparece duas vezes no ciclo `draft → in_review → changes_requested →
  in_review → approved`). Por isso o guard de idempotência de
  `question_history` usa `NOT EXISTS (question_id, version)` — a versão
  resultante é estritamente crescente e nunca reaproveitada para a mesma
  questão, então uma dada versão só pode ter exatamente um evento de
  histórico, não importa quantas vezes a mesma chamada (com o mesmo
  `expectedVersion` já obsoleto) seja repetida.
- `published` nunca é apagada nem tem seu conteúdo editado; import undo nunca
  afeta questão publicada.
- Editar conteúdo de questão publicada é **bloqueado nesta sprint**: o guard
  SQL do `UPDATE` restringe a `editorial_status IN ('draft',
  'changes_requested')`. Uma revisão versionada de conteúdo publicado fica
  para sprint futura (ver Limitações).

## Invariantes e proteções

- Mass assignment: toda escrita usa allow-list explícita de campos
  (`QUESTION_CREATE_ALLOWED_FIELDS`/`QUESTION_UPDATE_ALLOWED_FIELDS`) — nunca
  um spread do corpo inteiro.
- `fingerprint` sinaliza duplicidade na criação e na importação, tanto contra
  o arquivo quanto contra o banco — não é uma constraint `UNIQUE` no banco
  (uma colisão de hash não pode travar conteúdo legítimo), é verificada no
  serviço. Algoritmo exato na seção "Fingerprint" abaixo.
- Todo `GET` é 100% somente leitura — nenhuma rota GET cria questão, papel ou
  lote de importação.

## Fingerprint (Sprint 7 v1.1, Correção C)

Algoritmo EXPLÍCITO, DETERMINÍSTICO e testado DIRETAMENTE — nunca só provado
indiretamente via comportamento de duplicidade. Implementação em
`worker/src/lib/fingerprint.ts`; testes diretos em
`worker/testing/fingerprint.test.ts`.

**Contrato:**

- calculado no Worker (`computeQuestionFingerprint`), nunca no banco;
- `SHA-256` em hexadecimal (`worker/src/lib/crypto.ts:sha256Hex`) — nunca um
  hash não criptográfico;
- a partir de uma representação canônica **versionada**: um objeto
  serializado com `JSON.stringify` (nunca concatenação ambígua de string),
  no formato:

  ```json
  {
    "v": "question-fingerprint-v1",
    "enunciado": "<texto canonicalizado>",
    "alternativas": [
      { "letter": "A", "text": "<texto canonicalizado>", "correta": false },
      { "letter": "B", "text": "<texto canonicalizado>", "correta": true },
      { "letter": "C", "text": "<texto canonicalizado>", "correta": false },
      { "letter": "D", "text": "<texto canonicalizado>", "correta": false },
      { "letter": "E", "text": "<texto canonicalizado>", "correta": false }
    ]
  }
  ```

- `v` é a constante de versão do algoritmo (`QUESTION_FINGERPRINT_VERSION =
  "question-fingerprint-v1"`) — SEMPRE o primeiro campo do payload; uma
  mudança futura de algoritmo exige uma nova constante (ex.:
  `question-fingerprint-v2`) e uma estratégia de migration/reindexação
  explícita para os fingerprints já gravados — nunca uma alteração silenciosa
  do texto canônico sob a MESMA versão;
- inclui, no mínimo, o enunciado e as cinco alternativas (texto + indicação
  de correta), sempre reordenadas por LETRA (`buildCanonicalFingerprintPayload`
  ordena por `letter`, nunca pela ordem de chegada do cliente) — trocar duas
  alternativas de POSIÇÃO no envio não muda o fingerprint, mas trocar o
  CONTEÚDO entre duas letras muda;
- independente de código editorial, ID, status editorial, autor, revisor e
  datas — nenhum desses campos entra na assinatura da função nem no payload;
- produz o MESMO resultado seja a questão criada pelo formulário unitário
  (`questionService.ts:createQuestion`/`updateQuestion`) ou pela importação
  CSV (`questionImportService.ts:parseAndValidateRow`) — os dois caminhos
  chamam a MESMA função `computeQuestionFingerprint`, nunca duas
  implementações paralelas.

**Normalização de texto** (`canonicalizeFingerprintText`), nesta ordem:

1. Unicode NFC (`.normalize("NFC")`) — formas visualmente idênticas (ex.:
   "á" precomposto vs. "a" + acento combinante) produzem o MESMO fingerprint;
2. CRLF/CR → LF — quebra de linha do Windows vs. Unix não muda o
   fingerprint, mas a quebra em si (`\n`) é PRESERVADA (pode ser
   semanticamente relevante, ex. separar etapas de um enunciado);
3. `trim()` das bordas — espaço externo nunca é conteúdo;
4. colapso de sequências de espaço/tab HORIZONTAL em um único espaço — nunca
   toca `\n`, nunca remove/altera `-`, `+`, `=`, expoentes (`^`), frações
   (`/`) ou qualquer pontuação — só normaliza espaçamento.

**Limitação conhecida:** o fingerprint é uma assinatura técnica do texto
canônico — não substitui revisão editorial humana de duplicidade semântica
(duas questões com o mesmo VALOR numérico mas enunciados com palavras
diferentes têm fingerprints diferentes, de propósito).

## API editorial

Prefixo `/api/editorial/questions` (`worker/src/routes/editorialQuestions.ts`):

1. `GET /api/editorial/questions` — lista com busca, status, origem,
   dificuldade, conteúdo, autor/revisor, ano, presença de imagem, paginação,
   ordenação estável (`updated_at DESC, code, id`).
2. `GET /api/editorial/questions/:id` — ficha completa.
3. `POST /api/editorial/questions` — cria em `draft`.
4. `PATCH /api/editorial/questions/:id` — edita (só `draft`/`changes_requested`) —
   **PATCH PARCIAL de verdade** (Sprint 7 v1.1, Correção A; ver seção própria abaixo).
5. `POST /api/editorial/questions/:id/submit-review`
6. `POST /api/editorial/questions/:id/request-changes` (admin, motivo obrigatório)
7. `POST /api/editorial/questions/:id/approve` (admin)
8. `POST /api/editorial/questions/:id/publish` (admin)
9. `POST /api/editorial/questions/:id/archive` (admin)

Auxiliar: `GET /api/editorial/me` — devolve só `{ role }` (nunca conteúdo),
usado pela interface para decidir entre shell editorial e acesso negado.

Todos exigem sessão + papel editorial; parametrizado; corpo limitado; sem
stack/SQL nas respostas de erro.

## PATCH parcial (Sprint 7 v1.1, Correção A)

`PATCH /api/editorial/questions/:id` aplica atualização PARCIAL real —
implementado em `worker/src/services/questionService.ts:updateQuestion`.

Contrato exato:

| Situação | Comportamento |
| --- | --- |
| Campo escalar AUSENTE do corpo | preserva o valor atual (nunca é tocado) |
| Coleção (`alternativas`/`dna`/`padroes`/`tags`/`imagens`) AUSENTE | preserva a coleção atual inteira — nenhum `DELETE` é emitido |
| Coleção enviada como `[]` | limpa explicitamente — só quando o status atual permite edição (`draft`/`changes_requested`) |
| Campo escalar enviado como `null` | aceito SOMENTE se o campo é anulável (`prova`, `ano`, `tempoEstimadoSegundos`, `titularDireitos`, `baseLicenca`, `textoAtribuicao` — `NULLABLE_QUESTION_SCALAR_FIELDS` em `worker/src/lib/questionsValidation.ts`); qualquer outro campo com `null` explícito é 400 **sem escrever nada** |
| Coleção enviada como `null` | sempre 400 (coleções não são anuláveis — `[]` é a forma de limpar) |
| `version` | sempre obrigatório; desatualizada → 409 |
| `published` | sempre imutável (guard SQL + checagem no serviço) |
| Mass assignment | allow-list (`QUESTION_UPDATE_ALLOWED_FIELDS`) — `editorialStatus`/`version`/`autorId`/`revisorId` nunca são graváveis via PATCH |

### Atomicidade

O `UPDATE` escalar roda **sempre**, mesmo quando nenhum campo escalar mudou —
é o único jeito de expressar, num único statement condicionado, o guard de
versão que decide sucesso/conflito/idempotência para a chamada inteira. Isso
garante que o lote (`db.batch()`) NUNCA fica vazio, então não existe cenário
onde seria preciso lidar com um `db.batch([])` dinâmico (a preocupação da
ordem de correção) — o `UPDATE` escalar É a operação, não um "extra".

Só as coleções EXPLICITAMENTE presentes no corpo entram no lote, cada uma
como um par `DELETE` + `INSERT`s guardado pela MESMA versão-alvo do `UPDATE`
escalar (`buildDeleteAlternativesStatement`/`buildGuardedInsertAlternativeStatement`
etc., em `worker/src/repositories/questionRepository.ts`) — uma coleção
ausente não gera nenhum statement, então nunca é apagada por omissão. Uma
falha lançada por QUALQUER statement do lote reverte a transação inteira
(nenhuma escrita parcial).

### Concorrência e idempotência

- `version` desatualizada (e o conteúdo enviado não bate com o que já está
  gravado) → 409.
- Repetição idempotente do MESMO PATCH (mesmo `expectedVersion` já obsoleto,
  reenviado por retry de rede) → sucesso silencioso, sem duplicar
  `question_history`: o serviço reconhece que a questão já está exatamente na
  versão que esta chamada teria produzido E que o conteúdo escalar mesclado
  bate com o que está gravado, e retorna `ok: true` sem escrever de novo. O
  guard `NOT EXISTS (question_id, version)` de `question_history` (mesmo de
  antes) impede a duplicação mesmo se a tentativa chegasse a re-executar.
- `question_history` registra a ação `updated` com `metadata.fields` — os
  NOMES dos grupos de campos alterados nesta chamada (ex.:
  `"enunciado,alternativas"`), separados por vírgula — **nunca o conteúdo**.

## Importação CSV

`docs/templates/questoes-importacao-v1.csv` (ver `docs/templates/README.md`
para o guia de colunas). Endpoints sob `/api/editorial/question-imports`
(`worker/src/routes/editorialImports.ts`):

1. `GET /api/editorial/question-imports/template` — baixa o template.
2. `POST /api/editorial/question-imports/preview` — corpo é o CSV bruto
   (`Content-Type: text/csv`); NUNCA cria questão; valida cabeçalho,
   UTF-8/BOM, tamanho (300KB) e número de linhas (500), produz erros por
   linha/campo, detecta código e fingerprint duplicados (arquivo e banco),
   valida padrão por `code` sem criar padrão, nunca loga conteúdo completo de
   linha (só campo + valor da célula responsável + mensagem). Cria só um
   registro técnico leve de lote com expiração de 30min.
3. `POST /api/editorial/question-imports/apply` — só a partir de um preview
   válido (zero erros) e não expirado; cria todas as questões como `draft`
   num único `db.batch()` (uma linha ruim reverte o lote inteiro);
   idempotente (reaplicar o mesmo `batchId` não duplica).
4. `GET /api/editorial/question-imports/:id` — status do lote.
5. `POST /api/editorial/question-imports/:id/undo` — só admin; só lote
   `applied`; só se TODAS as questões do lote continuarem `draft`; remove
   atomicamente questões e dependentes; nunca apaga padrão; idempotente.

### Atomicidade e idempotência da importação

`applyImport`/`undoImport` (`worker/src/services/questionImportService.ts`)
seguem o mesmo princípio de "um único `db.batch()`, resultado interpretado
depois": o marcador do lote (`applied_at`/`undone_at`) é condicionado por
`WHERE ... IS NULL`, então uma segunda tentativa vê `meta.changes = 0` e é
tratada como repetição idempotente, nunca como erro. No `undo`, a ordem dos
statements importa: os itens do lote são desvinculados (`question_id = NULL`)
ANTES de apagar as questões (evita violar a FK), e o `UPDATE` que marca o
lote como `undone` roda por ÚLTIMO — se rodasse primeiro, os `DELETE`s
seguintes (guardados por `status = 'applied'`) veriam o lote já `undone` e
não apagariam nada.

## Política de segurança CSV (Sprint 7 v1.1, Correção B)

Numa plataforma de matemática, valores como `-5`, `+3`, `= 2x + 4` ou
`@ representa uma variável` são conteúdo pedagógico legítimo. A política
final trata IMPORTAÇÃO e EXPORTAÇÃO como problemas diferentes:

### Importação (`worker/src/services/questionImportService.ts:parseAndValidateRow`)

- toda célula é tratada como TEXTO PURO — nunca "executada", nunca rejeitada
  por causa do primeiro caractere;
- **nenhuma linha é rejeitada só por um campo pedagógico começar com `=`,
  `+`, `-` ou `@`** — `-5`, `+3`, `= 2x + 4` e `@ representa uma variável`
  importam normalmente;
- validação continua 100% SEMÂNTICA por campo: `dificuldade` só aceita
  `facil`/`media`/`dificil`, `origem` só aceita o enum fechado, `ano` só
  aceita inteiro plausível, `código` exige formato e unicidade — essas
  continuam estritas independentemente do conteúdo de outros campos;
- o conteúdo é preservado BYTE A BYTE entre o CSV e o banco (só o
  escaping/aspas do FORMATO CSV são removidos pelo parser RFC 4180 —
  `worker/src/lib/csv.ts:parseCsv` — nunca o conteúdo humano em si).

### Exportação/relatório CSV (`worker/src/lib/csv.ts`)

Só na hora de gerar um arquivo CSV que alguém pode reabrir numa planilha é
que a neutralização de fórmula se aplica:

- `hasDangerousLeadingCharacter(value)` — verifica o primeiro caractere
  NÃO-BRANCO do valor (espaços antes do prefixo não escapam da checagem);
- `neutralizeForCsvExport(value)` — se perigoso, prefixa uma aspa simples
  (`'`) no início ABSOLUTO do valor (estratégia padrão de
  Excel/Sheets/LibreOffice: a célula inteira vira texto literal a partir da
  aspa); conteúdo comum nunca ganha o apóstrofo;
- `serializeCsvExportRow`/`serializeCsvReport` aplicam a neutralização em
  **todas as células** de um arquivo exportado — cabeçalho, valor original,
  nome do campo e mensagem inclusos — e SÓ DEPOIS o escaping RFC 4180
  obrigatório (aspas/vírgulas/quebras de linha), porque a aspa de
  neutralização passa a fazer parte do conteúdo da célula;
- a neutralização é só da REPRESENTAÇÃO exportada — o conteúdo armazenado no
  banco (`questions.enunciado`, alternativas, etc.) NUNCA é alterado por
  estas funções;
- usado por `questionImportService.ts:buildImportErrorReportCsv` — o
  relatório de erros de importação, disponível como
  `errorsReportCsv` na resposta de `POST /preview` e baixável pela UI
  (`src/pages/editorial/EditorialImportsPage.tsx`) como um arquivo `.csv`
  separado (nunca inserido como HTML).

### UI

A prévia de importação mostra todo texto (enunciado, valores de erro etc.)
como DADO puro — o React escapa automaticamente, e nenhum
`dangerouslySetInnerHTML` é usado em nenhuma tela editorial.

## Fixtures

`scripts/fixtures/questions-fixtures.local.sql` — cinco questões técnicas,
todo enunciado/resolução com o prefixo `FIXTURE TÉCNICA LOCAL — NÃO
PUBLICAR — NÃO É QUESTÃO OFICIAL`, vinculadas apenas aos cinco padrões da
Sprint 6, sem imagens (decisão deliberada: nenhum asset de licença conhecida
foi produzido para esta sprint, então preferimos zero imagens de fixture a
arriscar uma licença incerta), cobrindo vários status do workflow para
telas/screenshots. Seed idempotente (`INSERT OR IGNORE`, IDs determinísticos),
aplicado via `npm run db:seed:questions:local`. Nenhuma fixture é inserida
pela migration nem por qualquer GET.

## Limitações conhecidas

- Edição de conteúdo de questão publicada é bloqueada nesta sprint — uma
  revisão versionada (nova versão de conteúdo mantendo a anterior publicada)
  fica para sprint futura.
- Sem upload de mídia: imagens só podem referenciar assets já existentes no
  repositório local.
- Sem cálculo dos três índices, sem player, sem tentativas — o Banco de
  Questões ainda não está conectado ao aluno.
- `fingerprint` é uma assinatura técnica determinística (algoritmo explícito
  documentado na seção "Fingerprint" acima); não substitui revisão editorial
  humana de duplicidade semântica.
- PATCH parcial não suporta reordenar/renomear letras de alternativas de
  forma incremental (envie o conjunto completo de 5 quando quiser alterar
  alternativas) — só omitir o campo `alternativas` inteiro preserva o estado
  atual sem tocar nele.

## Próximos passos

Player do aluno consumindo questões `published`; registro de tentativas e
respostas; cálculo dos três índices por padrão; Caderno de Erros; revisão
versionada de conteúdo publicado; upload de mídia via R2.
