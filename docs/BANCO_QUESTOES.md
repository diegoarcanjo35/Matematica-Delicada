# Banco de Questões e Importação Editorial — Sprint 7 v1.4

> v1.1 corrige três pontos apontados na auditoria da v1.0: semântica PATCH
> parcial de verdade (Correção A), política CSV que não bloqueia matemática
> legítima (Correção B), e algoritmo de fingerprint explícito, documentado e
> testado diretamente (Correção C, ver seção "Fingerprint" abaixo).
>
> v1.2 substitui a heurística de idempotência por comparação de conteúdo por
> uma chave de operação explícita (`mutationId`) e adiciona validação de
> todo resultado do lote (não só o `UPDATE` central) — ver "Validação do
> lote" abaixo.
>
> v1.3 substitui a validação pós-`db.batch()` (tarde demais para reverter um
> commit já efetivado) por um trigger SQL que aborta a transação ANTES do
> commit — mas só cobre a direção "núcleo mudou sem histórico".
>
> v1.4 fecha as direções restantes (núcleo mudou mas o histórico/coleção
> não, e vice-versa) com um segundo trigger — ver "Validação do lote (v1.3 →
> v1.4)" abaixo.

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

## Schema — migrations 0008, 0009 e 0010

`migrations/0008_question_bank_editorial.sql` é puramente aditiva (só
`CREATE TABLE/INDEX IF NOT EXISTS`) sobre o schema das Sprints 1-6. Nenhum
conteúdo é inserido pela migration.

`migrations/0009_editorial_batch_invariants.sql` (Sprint 7 v1.3) é aditiva
também (só `CREATE TRIGGER IF NOT EXISTS`) — o trigger que impõe a
indivisibilidade núcleo+histórico diretamente no banco (uma única direção:
"se `version` mudou, o histórico correspondente precisa existir"); ver
"Validação do lote" abaixo para o mecanismo completo.

`migrations/0010_editorial_bidirectional_invariants.sql` (Sprint 7 v1.4)
fecha as direções que 0009 sozinha não cobria — ver "Validação do lote
(v1.3 → v1.4)" abaixo. Também é aditiva quanto a conteúdo e a
tabelas/triggers pré-existentes (nenhuma linha é apagada, nenhuma tabela
removida ou renomeada, 0009 nunca é tocada), mas acrescenta uma coluna nova
(`version_stamp`, nullable) às 5 tabelas de coleção via `ALTER TABLE` — a
ÚNICA parte deste projeto (0001-0010) que usa `ALTER TABLE` em vez de
`CREATE ... IF NOT EXISTS`, porque a versão do SQLite empacotada aqui não
aceita `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; por isso essas 5 linhas,
ao contrário de todo o resto da migration, não são idempotentes por
reaplicação manual direta — o que nunca acontece em uso real, já que
Wrangler/D1 aplicam cada arquivo de migration exatamente uma vez (ver
comentário extenso no próprio arquivo `.sql` e
`worker/testing/migration0010.test.ts`). **Sprint 8 deve começar sua
própria migration em `0011`** — nunca reaproveitar ou renumerar 0009/0010.

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

## Fingerprint (Sprint 7 v1.1/v1.2, Correção C)

Algoritmo EXPLÍCITO, DETERMINÍSTICO e testado DIRETAMENTE — nunca só provado
indiretamente via comportamento de duplicidade. Implementação em
`worker/src/lib/fingerprint.ts`; testes diretos em
`worker/testing/fingerprint.test.ts`.

> **v1.2** — a auditoria por inspeção direta do código encontrou que o
> payload v1 incluía `isCorrect` (o gabarito) de cada alternativa: isso
> permitia "lavar" uma duplicata criando a MESMA questão (mesmo enunciado,
> mesmos textos de alternativa) só trocando qual letra está marcada como
> correta — o fingerprint mudava e a duplicata escapava da detecção. A v2
> EXCLUI o gabarito (e a explicação do distrator) do payload canônico.

**Contrato (v2):**

- calculado no Worker (`computeQuestionFingerprint`), nunca no banco;
- `SHA-256` em hexadecimal (`worker/src/lib/crypto.ts:sha256Hex`) — nunca um
  hash não criptográfico;
- a partir de uma representação canônica **versionada**: um objeto
  serializado com `JSON.stringify` (nunca concatenação ambígua de string),
  no formato:

  ```json
  {
    "v": "question-fingerprint-v2",
    "enunciado": "<texto canonicalizado>",
    "alternativas": [
      { "letter": "A", "text": "<texto canonicalizado>" },
      { "letter": "B", "text": "<texto canonicalizado>" },
      { "letter": "C", "text": "<texto canonicalizado>" },
      { "letter": "D", "text": "<texto canonicalizado>" },
      { "letter": "E", "text": "<texto canonicalizado>" }
    ]
  }
  ```

- `v` é a constante de versão do algoritmo (`QUESTION_FINGERPRINT_VERSION =
  "question-fingerprint-v2"`) — SEMPRE o primeiro campo do payload; uma
  mudança futura de algoritmo exige uma nova constante (ex.:
  `question-fingerprint-v3`) e uma estratégia de migration/reindexação
  explícita para os fingerprints já gravados — nunca uma alteração silenciosa
  do texto canônico sob a MESMA versão. **Esta troca de v1→v2 especificamente
  NÃO exigiu essa reindexação**: a Sprint 7 ainda não foi mesclada em `main`
  nem tocou D1 remoto, então não existe nenhum fingerprint v1 "real" em
  produção para reconciliar — só fixtures/dados técnicos locais deste
  branch, e nenhuma delas computava um hash real (ver "Fixtures" abaixo).
  Uma eventual evolução do algoritmo DEPOIS de uma implantação real
  precisará de reindexação de verdade;
- inclui, no mínimo, o enunciado e os TEXTOS das cinco alternativas, sempre
  reordenados por LETRA (`buildCanonicalFingerprintPayload` ordena por
  `letter`, nunca pela ordem de chegada do cliente) — trocar duas
  alternativas de POSIÇÃO no envio não muda o fingerprint, mas trocar o
  CONTEÚDO (texto) entre duas letras muda;
- **EXCLUI** explicitamente: indicação de correta (`isCorrect`/gabarito),
  explicação do distrator, código editorial, ID, status editorial, autor,
  revisor e datas — nenhum desses campos entra na assinatura da função nem
  no payload. Trocar SÓ o gabarito (mantendo os mesmos textos de
  alternativa) produz o MESMO fingerprint — a duplicata continua detectada;
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

## PATCH parcial (Sprint 7 v1.1/v1.2, Correção A)

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
| Corpo sem NENHUM campo/coleção editável | 400, sem incrementar versão (v1.2) |
| `version` | sempre obrigatório; desatualizada → 409 |
| `mutationId` | sempre obrigatório (UUID) — ver "Idempotência por chave de operação" abaixo (v1.2) |
| `published` | sempre imutável (guard SQL + checagem no serviço) |
| Mass assignment | allow-list (`QUESTION_UPDATE_ALLOWED_FIELDS`) — `editorialStatus`/`version`/`autorId`/`revisorId` nunca são graváveis via PATCH |

### Idempotência por chave de operação (v1.2)

> A auditoria por inspeção direta encontrou que a heurística de retry da
> v1.1 (comparar `version`-alvo + `enunciado`/`conteudo`/`dificuldade`/
> `origem`/`fingerprint` mesclados) era insuficiente: uma edição concorrente
> DIFERENTE que só mudasse tags, DNA, imagens, direitos, prova ou a
> explicação de um distrator NUNCA entrava nessa comparação — então ela
> podia ser (incorretamente) reconhecida como "a mesma chamada sendo
> repetida" e aceita como sucesso silencioso, quando na verdade era uma
> segunda edição real e válida sendo descartada. **Removida por completo.**

Contrato final: `PATCH` exige `version` **e** `mutationId` (UUID gerado pelo
cliente). A prova de retry é EXCLUSIVAMENTE o `mutationId` — nunca
parecença de conteúdo.

Persistência sem migration nova: `question_history.id` (já `PRIMARY KEY`,
unicidade garantida pelo banco) é reaproveitado como a própria chave de
idempotência da mutação (`updateQuestion`, início da função):

1. busca um evento de histórico com `id = mutationId`
   (`questionRepository.ts:findHistoryById`);
2. se existir e **question_id/user_id/action baterem** com esta chamada →
   sucesso idempotente, `ok:true, changed:false`, **nenhuma** escrita nova;
3. se existir mas question_id/user_id/action **não** baterem → 409 (colisão
   com outra questão, outro ator ou outra ação — nunca tratado como retry);
4. se não existir (mutationId nova) → segue o fluxo normal; se a `version`
   enviada estiver desatualizada, o resultado é o 409 de conflito comum
   (não relacionado à mutationId).

O frontend (`src/pages/editorial/EditorialQuestionFormPage.tsx` +
`src/pages/editorial/mutationId.ts`) gera um `mutationId` novo a cada clique
explícito em "Salvar"; reutiliza o MESMO ID somente quando o payload da nova
tentativa é byte-a-byte idêntico ao da tentativa anterior que falhou POR
FALHA DE REDE (`isNetworkFailure` — nunca para um 400/409, que já significam
que o servidor processou a requisição); qualquer edição do formulário desde
então gera um ID novo. `resolveMutationId`/`computePayloadSignature`/
`isNetworkFailure` são testados isoladamente em
`src/pages/editorial/mutationId.test.ts` — cobertura de integração completa
da UX de retry (simular uma falha de rede real contra o componente montado)
fica para uma suíte E2E futura.

### PATCH vazio / no-op (v1.2)

- corpo **sem nenhum** campo/coleção editável presente → 400
  (`fieldErrors._body`), sem incrementar versão, sem histórico;
- corpo com campos/coleções presentes mas cujo valor EFETIVO é idêntico ao já
  gravado (comparação CANÔNICA — `alternativesCanonicallyEqual`/
  `dnaCanonicallyEqual`/`patternsCanonicallyEqual`/`tagsCanonicallyEqual`/
  `imagesCanonicallyEqual`, todas em `questionService.ts`, nunca por
  fingerprint — a v2 do fingerprint exclui gabarito/explicação, então
  compará-lo mascararia uma mudança real só nesses campos) → `ok:true,
  changed:false`, sem gravar versão/histórico/auditoria novos.
- a resposta sempre distingue `changed:true` / `changed:false` / 409.

### Atomicidade

O `UPDATE` escalar roda sempre que uma escrita real é decidida (nunca para
no-op/idempotente) — é o único jeito de expressar, num único statement
condicionado, o guard de versão. Só as coleções EXPLICITAMENTE presentes no
corpo entram no lote, cada uma como um par `DELETE` + `INSERT`s guardado
pela MESMA versão-alvo do `UPDATE` escalar
(`buildDeleteAlternativesStatement`/`buildGuardedInsertAlternativeStatement`
etc., em `worker/src/repositories/questionRepository.ts`) — uma coleção
ausente não gera nenhum statement, então nunca é apagada por omissão. Uma
falha lançada por QUALQUER statement do lote reverte a transação inteira
(nenhuma escrita parcial).

### Validação do lote (v1.2 → v1.3, Correção B)

> **v1.2** validava só em JS, DEPOIS de `db.batch()` retornar —
> `worker/src/lib/batchValidation.ts:validateBatchResults`. Uma inspeção
> direta do código (auditoria v1.3) apontou o problema real: `db.batch()` já
> é uma transação COMMITADA quando esse JS roda. Lançar um erro nesse ponto
> impede uma resposta HTTP de sucesso falso, mas **não desfaz o que já foi
> persistido** — se o `UPDATE` central mudasse `questions` mas o `INSERT`
> condicionado de `question_history` silenciosamente afetasse 0 linhas (sem
> lançar exceção), o núcleo ficava committido sem o histórico
> correspondente: uma inconsistência real e não recuperável, não só uma
> resposta ruim.

**v1.3 — mecanismo transacional real, imposto pelo SQLite/D1 antes do
commit**, via `migrations/0009_editorial_batch_invariants.sql`:

```sql
CREATE TRIGGER IF NOT EXISTS trg_questions_require_history_after_update
AFTER UPDATE ON questions
FOR EACH ROW
WHEN NEW.version != OLD.version
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM question_history
      WHERE question_id = NEW.id AND version = NEW.version
    )
    THEN RAISE(ABORT, 'invariante violada: questions.version mudou sem question_history correspondente')
  END;
END;
```

`RAISE(ABORT, ...)` aborta o statement corrente; como o statement dispara
DENTRO da mesma transação de `db.batch()`, a exceção resultante propaga para
o JS e o wrapper de transação (FakeD1Database e o D1 real, ambos com a MESMA
garantia: "se qualquer statement falhar, o lote inteiro é revertido") desfaz
TUDO — nenhum commit acontece. Provado diretamente: `worker/testing/migration0009.test.ts`
executa uma transação explícita com um `UPDATE` de `q2` (inócuo) seguido de
um `UPDATE` de `q1` que dispara o trigger, e confirma que a mudança em `q2`
— que "rodou" antes do erro — TAMBÉM é revertida, porque a transação inteira
nunca commitou.

**Ordem exigida** (`worker/src/services/questionService.ts:updateQuestion`
e `applyTransition`): a linha de `question_history` (e, no PATCH, cada
coleção presente) é inserida **ANTES** do `UPDATE` central de `questions`,
no MESMO lote — guardada pela versão **ATUAL/pré-mutação**
(`expectedVersion`), nunca pela resultante (que só existiria depois do
`UPDATE`, impossível de checar antes dele rodar). Como o `UPDATE` central
roda por último, ao efetivamente mudar `version` ele dispara o trigger, que
exige que o histórico já exista — inserido momentos antes, na mesma
transação. Todos os guards de coleção passaram a incluir a MESMA condição de
status do `UPDATE` central (`editorial_status IN ('draft','changes_requested')`
no PATCH; a `fromStatuses` dinâmica da transição em `applyTransition`) —
guards IDÊNTICOS só podem concordar (ambos passam ou ambos falham
simultaneamente), o que é o que torna a reordenação segura.

`worker/src/lib/batchValidation.ts:validateBatchResults` continua em uso
como **defesa em profundidade** (verifica cada resultado do lote contra a
expectativa declarada — `"any"` para `DELETE` de coleção,
`"exactlyOne"` para `INSERT`/`UPSERT` guardado e para o `INSERT` de
histórico) — mas o trigger é agora o mecanismo PRIMÁRIO e transacional; a
checagem em JS nunca mais precisaria disparar em operação normal, porque o
trigger já teria abortado a transação antes desse ponto.

`question_history` registra a ação `updated` com `metadata.fields` — os
NOMES dos grupos de campos alterados nesta chamada (ex.:
`"enunciado,alternativas"`), separados por vírgula — **nunca o conteúdo**.
`audit_log` (`editorial_question_updated`) só é gravado quando
`changed:true` — nunca em no-op nem em retry idempotente por `mutationId`,
e nunca alcançável se o trigger abortar a transação (o código nunca chega à
chamada de `recordAuditEvent`, que roda depois do `db.batch()` bem-sucedido).

### Validação do lote (v1.3 → v1.4) — invariante bidirecional

> O trigger de 0009 cobre só UMA direção: "se `questions.version` mudou, um
> `question_history` correspondente precisa existir". A auditoria v1.4
> apontou o buraco na direção OPOSTA: se o `UPDATE` central de `questions`
> afeta 0 linhas SILENCIOSAMENTE (guard não bate, sem lançar exceção)
> enquanto o `INSERT` condicionado de `question_history` RODOU com sucesso
> (guard bateu, roda ANTES do central no mesmo lote — v1.3), o trigger de
> 0009 NUNCA dispara: ele só reage a um `UPDATE` que de fato mudou uma
> linha. O lote inteiro poderia commitar com um histórico órfão e coleções
> substituídas, mas sem a mudança de versão correspondente — e o mesmo vale
> ao contrário: uma coleção substituída sem o núcleo mudar.

**v1.4 — mecanismo do marcador incondicional**, via
`migrations/0010_editorial_bidirectional_invariants.sql`: toda mutação
(`updateQuestion`/`applyTransition`) insere, como o ÚLTIMO statement do
lote, uma linha SEM WHERE-guard algum (sempre grava exatamente 1 linha) em
`editorial_mutation_checks`, declarando o que a mutação esperava alcançar
(questão, versão resultante e, por coleção tocada, a contagem esperada de
linhas). Por não ter guard, esse `INSERT` sempre dispara seu próprio
trigger `AFTER INSERT` (`trg_editorial_mutation_checks_bidirectional`) —
mesmo que o `UPDATE` central, statement anterior no mesmo lote, tenha
afetado 0 linhas sem lançar. Rodando por último, o trigger enxerga o estado
(ainda não commitado) de tudo que os statements anteriores da mesma
transação fizeram, e confere três coisas, todas verdadeiras juntas ou todas
falsas juntas — nunca uma combinação dividida:

1. **Núcleo <-> histórico**: `EXISTS(questions no version esperado)` deve
   coincidir com `EXISTS(question_history para question_id+version
   esperados)`. Checado por `(question_id, version)`, **nunca** por um id de
   linha específico desta chamada — um reenvio idempotente legítimo (mesma
   operação, `expectedVersion` que já foi correta mas ficou obsoleta porque
   a primeira tentativa já teve sucesso) tem seu histórico real gravado por
   uma chamada ANTERIOR, com um id diferente; checar por id quebraria esse
   reenvio válido.
2. **Núcleo <-> cada coleção tocada** (só quando `expected_count` não é
   `NULL`, ou seja, a mutação de fato tocou aquela coleção): quando
   `expected_count > 0`, confere `COUNT(linhas com version_stamp =
   expected_version) = expected_count`. A nova coluna `version_stamp`
   (gravada pelo mesmo `INSERT`/`UPSERT` guardado que já escreve cada linha,
   com o mesmo valor da versão resultante) é o que evita um falso-positivo:
   uma contagem "crua" (sem filtrar por versão) poderia coincidir por acaso
   com o estado antigo remanescente de um guard que falhou, abortando por
   engano uma tentativa que deveria só receber 409 — exatamente como
   `question_history.version` já protege o histórico.
3. **Coleção esvaziada** (`expected_count = 0`, ex. `tags: []`): uma
   contagem carimbada é sempre 0 neste caso, tenha o guard passado ou
   falhado (não há linha para carimbar quando a intenção é não inserir
   nada) — o carimbo não distingue os dois casos aqui. Este caso é
   **exemptado da checagem por contagem** e se apoia numa garantia
   estrutural, não de runtime: o `DELETE` guardado da coleção usa a MESMA
   condição de guard, byte a byte, que o `UPDATE` central
   (`guardedDeleteSql`), então sempre que o núcleo muda o `DELETE`
   necessariamente também rodou (mesmo guard, mesma transação, mesmo
   instante imutável) e vice-versa.

Uma divergência dispara `RAISE(ABORT, ...)`, revertendo a transação
INTEIRA — núcleo, histórico, coleções e a própria linha-marcador, sem
nenhum registro residual. Provado diretamente contra SQL real
(`worker/testing/migration0010.test.ts`, 17 cenários incluindo o reenvio
idempotente e o falso-positivo de contagem corrigido) e via um teste
adversarial que constrói o lote diretamente pelo repositório, bypassando o
serviço, com uma versão deliberadamente errada no `UPDATE` central
enquanto o histórico usa a versão correta (`worker/testing/questions.test.ts`,
describe "Sprint 7 v1.4").

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
- (Resolvida na v1.3) A validação do lote agora é imposta por um trigger SQL
  (`migrations/0009_editorial_batch_invariants.sql`) que aborta a transação
  ANTES do commit — ver "Validação do lote" acima. Não há mais dependência
  de uma checagem em JS pós-commit para este invariante específico
  (core+histórico); `validateBatchResults` continua só como defesa em
  profundidade.
- (Resolvida na v1.4) A direção OPOSTA (núcleo não mudou mas histórico/coleção
  sim, ou vice-versa) agora também é imposta no banco, por um segundo trigger
  (`migrations/0010_editorial_bidirectional_invariants.sql`) — ver "Validação
  do lote (v1.3 → v1.4)" acima.
- Cobertura de integração completa da UX de retry de `mutationId` (simular
  uma falha de rede real contra o formulário montado) fica para uma suíte
  E2E futura — hoje só a lógica pura de decisão é testada diretamente
  (`src/pages/editorial/mutationId.test.ts`).

## Próximos passos

Player do aluno consumindo questões `published`; registro de tentativas e
respostas; cálculo dos três índices por padrão; Caderno de Erros; revisão
versionada de conteúdo publicado; upload de mídia via R2.
