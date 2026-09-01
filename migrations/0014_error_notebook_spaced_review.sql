-- Sprint 9 v1.0 — Caderno de Erros e Revisão Espaçada (primeira versão
-- técnica). Puramente aditiva sobre o schema das Sprints 1-8 (0001-0013):
-- só CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS e UM ALTER TABLE ADD COLUMN
-- (mesmo precedente de migrations/0012_editorial_mutation_identity.sql,
-- que adicionou `questions.last_mutation_id` da mesma forma). Nenhuma
-- migration anterior (0001-0013) é editada. A Sprint 10 deve começar sua
-- própria migration em `0015` — nunca reaproveitar ou renumerar 0001-0014.
--
-- Colunas/tabelas reais de migrations/0013_question_player_attempts.sql
-- (relidas integralmente antes de escrever este arquivo, por instrução
-- explícita da ordem — nada aqui presume nome de coluna de memória):
--   question_attempts(id, user_id, question_id, question_version, mode,
--     status, selected_alternative, is_correct, recognition_pattern_id,
--     recognition_clue, recognition_strategy, highest_help_layer,
--     started_at, answered_at, completed_at, last_activity_at, version,
--     last_mutation_id, created_at, updated_at)
--   question_answer_events(id, attempt_id, previous_alternative,
--     new_alternative, event_type CHECK IN ('selected','changed','confirmed'),
--     created_at)
--   trg_question_answer_events_require_attempt_identity — já garante que
--     TODO INSERT em question_answer_events só sobrevive se
--     question_attempts.last_mutation_id = NEW.id (a identidade da MESMA
--     mutação) — ou seja, quando os triggers desta migration abaixo
--     rodam (depois dele, mesma tabela, mesmo evento — SQLite executa
--     triggers na ordem de criação), já é garantido que
--     `question_attempts` reflete o resultado REAL desta confirmação.

-- ---------------------------------------------------------------------------
-- error_notebook_entries (seção 4.1) — uma linha por (aluno, questão
-- ORIGINAL). "Original" = a questão em que o erro foi descoberto pela
-- primeira vez fora de uma revisão — nunca a questão semelhante usada
-- numa revisão (essa fica só em error_review_events.reviewed_question_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_notebook_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  original_question_id TEXT NOT NULL REFERENCES questions (id),
  original_attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  latest_attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  primary_pattern_id TEXT REFERENCES patterns (id),
  error_type TEXT NOT NULL DEFAULT 'unclassified' CHECK (error_type IN (
    'unclassified', 'pattern_not_recognized', 'wrong_pattern', 'inadequate_strategy',
    'interpretation', 'content_or_base', 'calculation', 'haste', 'time_shortage', 'marking_error'
  )),
  -- Texto livre opcional do aluno — NUNCA aparece em URL/query
  -- string/audit_log/logs/mensagens de erro/screenshots (seção 10 da
  -- ordem) e NUNCA é usado como chave de idempotência (essa chave é
  -- sempre `mutationId`, uma coluna técnica separada). Hostil é tratado
  -- como DADO (bind parametrizado), nunca SQL/HTML.
  student_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_understanding' CHECK (status IN (
    'pending_understanding', 'scheduled', 'due', 'in_review', 'corrected', 'archived'
  )),
  error_count INTEGER NOT NULL DEFAULT 1 CHECK (error_count >= 1),
  review_stage INTEGER NOT NULL DEFAULT 0 CHECK (review_stage >= 0),
  -- Contagem de questões DISTINTAS com pelo menos uma revisão CORRETA
  -- registrada para esta entrada — mantida pelo serviço a cada revisão
  -- concluída (worker/src/services/errorNotebookService.ts), recomputada
  -- por COUNT(DISTINCT reviewed_question_id) sobre error_review_events
  -- WHERE result = 'correct'. Usada, junto com
  -- error_review_events.used_different_question, para decidir o critério
  -- provisório de "corrected" (seção 6.1 da ordem) — nunca por acertar a
  -- mesma questão uma única vez.
  distinct_review_questions_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (distinct_review_questions_succeeded >= 0),
  first_error_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_reviewed_at TEXT,
  next_review_at TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
  corrected_at TEXT,
  -- Mesma concorrência otimista do resto do projeto desde a Sprint 5.
  version INTEGER NOT NULL DEFAULT 1,
  -- Identidade da MUTAÇÃO ESPECÍFICA que gravou esta linha por último —
  -- mesmo papel de question_attempts.last_mutation_id (migrations/0012 e
  -- 0013). Setada pelo MESMO UPDATE/INSERT guardado que muda `version`;
  -- os triggers no final deste arquivo comparam contra ela, nunca contra
  -- um número de versão resultante sozinho (mesma lição da Sprint 7 v1.6).
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uma entrada por (aluno, questão original) — user_id e
-- original_question_id são NOT NULL sempre (nunca nulos), então este
-- índice único já é seguro quanto a NULL por construção (SQLite trata
-- cada linha com NULL numa coluna UNIQUE como distinta das demais, mas
-- como nenhuma das duas colunas aqui aceita NULL, essa ressalva nunca se
-- aplica a este índice específico).
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_notebook_entries_user_question
  ON error_notebook_entries (user_id, original_question_id);

CREATE INDEX IF NOT EXISTS idx_error_notebook_entries_user ON error_notebook_entries (user_id);
CREATE INDEX IF NOT EXISTS idx_error_notebook_entries_status ON error_notebook_entries (status);
CREATE INDEX IF NOT EXISTS idx_error_notebook_entries_next_review ON error_notebook_entries (next_review_at);
CREATE INDEX IF NOT EXISTS idx_error_notebook_entries_pattern ON error_notebook_entries (primary_pattern_id);

-- ---------------------------------------------------------------------------
-- error_review_events (seção 4.4) — append-only, histórico pedagógico
-- próprio (nunca substituído por audit_log — seção 11 da ordem). `id` É a
-- identidade da mutação (mesma convenção de "NEW.id É o mutationId" de
-- migrations/0012/0013): o mesmo id gravado tanto aqui quanto em
-- error_notebook_entries.last_mutation_id pelo UPDATE pareado no MESMO
-- lote da confirmação do Player — os triggers no final deste arquivo
-- garantem essa identidade ANTES do commit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_review_events (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES error_notebook_entries (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  reviewed_question_id TEXT NOT NULL REFERENCES questions (id),
  result TEXT NOT NULL CHECK (result IN ('correct', 'incorrect')),
  previous_stage INTEGER NOT NULL CHECK (previous_stage >= 0),
  resulting_stage INTEGER NOT NULL CHECK (resulting_stage >= 0),
  previous_next_review_at TEXT NOT NULL,
  resulting_next_review_at TEXT NOT NULL,
  used_different_question INTEGER NOT NULL CHECK (used_different_question IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_error_review_events_entry ON error_review_events (entry_id, created_at);
-- Idempotência por IDENTIDADE de tentativa confirmada: a mesma tentativa
-- de revisão só pode gerar UM evento de conclusão, para sempre — imposto
-- no BANCO (índice único), nunca só por checagem em JS. `confirmAnswer`
-- só roda o UPDATE central de question_attempts uma única vez por
-- confirmação real (tentativas já completed são rejeitadas antes de
-- chegar a um novo lote — worker/src/services/playerService.ts), então
-- attempt_id é a chave natural de "uma revisão, um evento".
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_review_events_attempt_unique ON error_review_events (attempt_id);

-- ---------------------------------------------------------------------------
-- Seção 4.5 — ligação aditiva da tentativa do Player com o Caderno.
-- ALTER TABLE (não idempotente por reaplicação direta — mesma ressalva já
-- documentada em migrations/0012 para questions.last_mutation_id) em vez
-- de reescrever question_attempts inteira só para acrescentar um modo
-- `review` ao CHECK existente (a ordem, seção 4.5, proíbe explicitamente
-- essa reescrita). O Player CONTINUA persistindo tecnicamente o modo
-- `practice` numa tentativa de revisão (nenhuma migração de dado, nenhum
-- novo valor no CHECK de `mode`) — é `error_entry_id IS NOT NULL` que diz
-- ao frontend para apresentar a tela como "Revisão" em vez de "Prática"
-- (ver docs/CADERNO_ERROS_REVISAO.md, seção "Distinção técnica
-- modo x apresentação"). Nenhum campo adicional de "contexto/origem" foi
-- necessário: `error_entry_id` sozinho já distingue tentativa comum de
-- tentativa de revisão sem ambiguidade.
ALTER TABLE question_attempts ADD COLUMN error_entry_id TEXT REFERENCES error_notebook_entries (id);

CREATE INDEX IF NOT EXISTS idx_question_attempts_error_entry ON question_attempts (error_entry_id);

-- Evita duas revisões simultâneas para a mesma entrada (seção 8.1 da
-- ordem) — índice único PARCIAL, mesmo padrão comprovado em
-- migrations/0005 (diagnóstico) e migrations/0013 (uma tentativa
-- in_progress por usuário+questão+modo): só restringe linhas
-- `error_entry_id IS NOT NULL AND status = 'in_progress'`. Duas chamadas
-- concorrentes de início de revisão só podem ambas inserir se SQLite
-- permitisse a violação — não permite; o serviço trata a violação como
-- "já existe, devolva a existente" (mesmo padrão de
-- playerService.ts:startOrResumeAttempt desde a Sprint 8).
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_attempts_one_active_review_per_entry
  ON question_attempts (error_entry_id)
  WHERE error_entry_id IS NOT NULL AND status = 'in_progress';

-- ---------------------------------------------------------------------------
-- Sprint 9 v1.1 — correção de auditoria (PO): a v1.0 destes dois triggers
-- comentava (incorretamente) que dependiam da ORDEM de execução em
-- relação a `trg_question_answer_events_require_attempt_identity`
-- (migrations/0013) — "roda depois dele, então já reflete o resultado
-- real". A auditoria rejeitou essa alegação: múltiplos triggers
-- `AFTER INSERT` no MESMO evento nunca podem depender de ordem relativa
-- entre si para estarem corretos — cada um precisa ser autossuficiente.
--
-- Os dois triggers abaixo foram reescritos para NUNCA assumir que outro
-- trigger já rodou ou já validou nada. Cada um, sozinho:
--   1) identifica a tentativa por `NEW.attempt_id` e confirma que ela
--      existe;
--   2) confirma DIRETAMENTE que `question_attempts.last_mutation_id =
--      NEW.id` (a identidade desta mutação específica) — nunca assume
--      isso já verificado por outro trigger;
--   3) confirma que a entrada do Caderno (quando exigida) pertence ao
--      MESMO usuário E à MESMA questão da tentativa (`e.user_id = a.user_id`,
--      `e.original_question_id = a.question_id` / `r.user_id = a.user_id`),
--      nunca só a mesma identidade de mutação por coincidência;
--   4) distingue fluxo normal (`error_entry_id IS NULL`) de conclusão de
--      revisão (`error_entry_id IS NOT NULL`) só a partir do estado REAL
--      de `question_attempts` — nunca a partir de um efeito colateral de
--      outro trigger;
--   5) só then verifica se a mutação exigida (entrada criada/atualizada,
--      ou evento de revisão + entrada) existe com essa identidade;
--   6) `RAISE(ABORT)` reverte a transação inteira em qualquer divergência.
-- Continuam corretos qualquer que seja a ordem relativa entre os dois
-- (mutuamente exclusivos por construção — ver seção "Exclusividade" logo
-- abaixo) e entre eles e o trigger de 0013 (que continua ativo, como
-- defesa adicional em profundidade, mas deixou de ser uma dependência).
--
-- Exclusividade mútua (nunca os dois disparam significativamente para o
-- MESMO evento): o primeiro trigger só considera a linha quando
-- `error_entry_id IS NULL`; o segundo, só quando `error_entry_id IS NOT
-- NULL` — o MESMO campo, na MESMA linha, no MESMO instante da checagem
-- (ambos leem `question_attempts` fresco, depois do UPDATE central já ter
-- rodado no lote) — logo, para qualquer confirmação real, exatamente UM
-- dos dois pode ter sua condição de exigência avaliada como verdadeira;
-- o outro nunca exige nada (seu `EXISTS` de "isto é uma mutação deste
-- tipo" já é falso). Provado por teste direto em
-- worker/testing/errorNotebook.test.ts, "correção incorreta durante
-- revisão dispara SÓ o fluxo de revisão".
--
-- Seção 5.1 — REGISTRO AUTOMÁTICO do erro: quando o serviço confirma uma
-- resposta ERRADA (`is_correct = 0`) numa tentativa que NÃO é revisão
-- (`error_entry_id IS NULL`), o MESMO db.batch() da confirmação
-- (worker/src/services/playerService.ts:confirmAnswer) inclui um UPSERT
-- incondicional em error_notebook_entries carimbado com
-- `last_mutation_id = mutationId` — o MESMO id usado como
-- `question_answer_events.id`.
CREATE TRIGGER IF NOT EXISTS trg_question_answer_events_require_error_entry
AFTER INSERT ON question_answer_events
FOR EACH ROW
WHEN NEW.event_type = 'confirmed'
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM question_attempts a
      WHERE a.id = NEW.attempt_id
        AND a.last_mutation_id = NEW.id
        AND a.is_correct = 0
        AND a.error_entry_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM error_notebook_entries e
      JOIN question_attempts a ON a.id = NEW.attempt_id
      WHERE e.last_mutation_id = NEW.id
        AND e.user_id = a.user_id
        AND e.original_question_id = a.question_id
    )
    THEN RAISE(ABORT, 'invariante violada (autossuficiente): confirmação incorreta sem entrada/atualização obrigatória do Caderno de Erros (por identidade própria, mesmo usuário e mesma questão)')
  END;
END;

-- Seção 8.3 — CONCLUSÃO DE REVISÃO: quando a tentativa confirmada É uma
-- revisão (`error_entry_id IS NOT NULL` — correta ou incorreta, os dois
-- casos exigem exatamente um `error_review_events` mais a atualização
-- consolidada da entrada), o MESMO lote inclui o INSERT incondicional em
-- error_review_events (id = mutationId) MAIS o UPDATE de
-- error_notebook_entries (last_mutation_id = mutationId) — os dois
-- exigidos juntos, cada um validado contra o MESMO usuário e a MESMA
-- entrada da tentativa.
CREATE TRIGGER IF NOT EXISTS trg_question_answer_events_require_review_completion
AFTER INSERT ON question_answer_events
FOR EACH ROW
WHEN NEW.event_type = 'confirmed'
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM question_attempts a
      WHERE a.id = NEW.attempt_id
        AND a.last_mutation_id = NEW.id
        AND a.error_entry_id IS NOT NULL
    )
    AND NOT (
      EXISTS (
        SELECT 1 FROM error_review_events r
        JOIN question_attempts a ON a.id = NEW.attempt_id
        WHERE r.id = NEW.id
          AND r.attempt_id = a.id
          AND r.user_id = a.user_id
          AND r.reviewed_question_id = a.question_id
      )
      AND EXISTS (
        SELECT 1 FROM error_notebook_entries e
        JOIN question_attempts a ON a.id = NEW.attempt_id
        WHERE e.id = a.error_entry_id
          AND e.last_mutation_id = NEW.id
          AND e.user_id = a.user_id
      )
    )
    THEN RAISE(ABORT, 'invariante violada (autossuficiente): confirmação de revisão sem error_review_events/atualização de entrada correspondentes (por identidade própria, mesmo usuário e mesma questão)')
  END;
END;
