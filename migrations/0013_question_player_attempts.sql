-- Sprint 8 v1.1 — Player de Questão: tentativas, reconhecimento, ajuda,
-- revisão e denúncia. Puramente aditiva (só CREATE TABLE/INDEX
-- IF NOT EXISTS) sobre o schema das Sprints 1-7 (0001-0012). Nenhuma
-- alteração em nenhuma tabela existente, nenhum conteúdo inserido por esta
-- migration. A Sprint 9 deve começar sua própria migration em `0014` —
-- nunca reaproveitar ou renumerar 0001-0013.
--
-- Sprint 8 v1.2 — correção de auditoria (PO): editada AQUI MESMO, em 0013,
-- em vez de uma migration 0014 nova, porque esta migration NUNCA foi
-- aplicada nem commitada em lugar nenhum (Sprint 8 inteira segue sem
-- git add/commit/push) — corrigir o arquivo ainda não publicado é a decisão
-- certa, não uma indireção desnecessária. Adiciona os três triggers no
-- final do arquivo (ver comentário extenso antes deles) implementando o
-- mesmo mecanismo de "marcador incondicional + RAISE(ABORT) por identidade,
-- ANTES do commit" das migrations 0009-0012 do Banco de Questões, adaptado
-- para este domínio (mais simples: nenhuma coleção para reconciliar, só UM
-- evento obrigatório por mutação bem-sucedida).
--
-- ---------------------------------------------------------------------------
-- question_attempts (seção 4.1) — uma linha por tentativa (aluno+questão+
-- modo). `question_version` é a versão de `questions.version` CONGELADA no
-- início da tentativa (a questão publicada é imutável — Sprint 7 — então
-- isto é só um registro técnico, nunca precisa "reagir" a uma mudança que
-- não pode acontecer). `version` aqui é a MESMA concorrência otimista já
-- usada em todo o resto do projeto (schedule/patterns/questions) — cada
-- mutação (reconhecimento, resposta, confirmação, ajuda) exige a versão
-- atual e a incrementa ao suceder de verdade.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  question_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('learning', 'practice', 'recognition')),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'answered', 'completed', 'abandoned')),
  selected_alternative TEXT CHECK (selected_alternative IN ('A', 'B', 'C', 'D', 'E')),
  is_correct INTEGER CHECK (is_correct IN (0, 1)),
  recognition_pattern_id TEXT REFERENCES patterns (id),
  recognition_clue TEXT,
  recognition_strategy TEXT,
  -- 0 = nenhuma camada aberta ainda; 1-4 = camada mais funda já aberta.
  highest_help_layer INTEGER NOT NULL DEFAULT 0 CHECK (highest_help_layer BETWEEN 0 AND 4),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT,
  completed_at TEXT,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  -- Identidade da MUTAÇÃO ESPECÍFICA (nunca um número de versão sozinho)
  -- que a última vez alterou esta linha com sucesso — setada pelo MESMO
  -- UPDATE guardado que muda `version`. Mesma lição da Sprint 7 v1.6
  -- (migrations/0012_editorial_mutation_identity.sql): comparar só por
  -- versão resultante não distingue DUAS chamadas concorrentes que
  -- calculam o MESMO alvo aritmético (`expectedVersion + 1`) — só a
  -- vencedora real deveria conseguir gravar o evento pareado no mesmo
  -- lote; a perdedora (cujo UPDATE afetou 0 linhas) não pode ser
  -- confundida com a vencedora só porque a versão numérica bateu por
  -- coincidência. Cada INSERT de evento pareado (question_answer_events/
  -- question_recognition_events/question_help_events) é guardado por
  -- `last_mutation_id = <id gerado por ESTA chamada>`, nunca só por
  -- `version = <número>` — comprovado por teste direto de corrida real
  -- (worker/testing/playerAttempts.test.ts, "CORRIDA na confirmação").
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_attempts_user ON question_attempts (user_id);
CREATE INDEX IF NOT EXISTS idx_question_attempts_question ON question_attempts (question_id);

-- Invariante de concorrência (seção 4.1, "garantir no banco uma única
-- tentativa in_progress por usuário+questão+modo") — mesmo padrão já
-- comprovado em migrations/0005_diagnostic_invariants.sql
-- (idx_diagnostic_attempts_one_active_per_user): um índice único PARCIAL,
-- que só restringe linhas com status = 'in_progress'. Duas chamadas
-- concorrentes de início de tentativa só podem ambas inserir se D1/SQLite
-- permitisse a violação — não permite: a segunda tentativa de INSERT falha
-- com violação de unicidade, e o serviço (worker/src/services/playerService.ts)
-- trata essa falha como "já existe, devolva a existente" — garantia real de
-- banco, não uma checagem em JS que poderia perder a corrida.
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_attempts_one_active
  ON question_attempts (user_id, question_id, mode)
  WHERE status = 'in_progress';

-- ---------------------------------------------------------------------------
-- question_answer_events (seção 4.2) — append-only. NUNCA armazena o
-- gabarito (is_correct) em evento algum antes da confirmação — só o próprio
-- INSERT da confirmação carrega o resultado computado no servidor, e mesmo
-- assim só como referência técnica (a fonte de verdade do resultado
-- continua sendo question_attempts.is_correct).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_answer_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  previous_alternative TEXT CHECK (previous_alternative IN ('A', 'B', 'C', 'D', 'E')),
  new_alternative TEXT CHECK (new_alternative IN ('A', 'B', 'C', 'D', 'E')),
  event_type TEXT NOT NULL CHECK (event_type IN ('selected', 'changed', 'confirmed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_answer_events_attempt ON question_answer_events (attempt_id, created_at);

-- ---------------------------------------------------------------------------
-- question_recognition_events (seção 4.3) — append-only. Uma linha por
-- SALVAMENTO REAL (mudança de conteúdo) do passo de reconhecimento — uma
-- repetição idêntica (mesmo padrão/pista/estratégia) nunca insere linha
-- nova (checado no serviço antes de construir o statement, mesma
-- convenção de no-op canônico já usada em questionService.ts:updateQuestion
-- desde a Sprint 7 v1.2). Texto livre (pista/estratégia) tem limite de
-- tamanho e normalização aplicados no serviço, e NUNCA vai para
-- `audit_log` (seção 15) — só o conteúdo aqui, numa tabela técnica própria.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_recognition_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  clue TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT '',
  -- Versão da tentativa (question_attempts.version) resultante deste
  -- salvamento — mesma convenção de "versão no evento" já usada por
  -- question_history desde a Sprint 7, permitindo checar diretamente qual
  -- salvamento corresponde a qual versão da tentativa.
  attempt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_recognition_events_attempt ON question_recognition_events (attempt_id, created_at);

-- ---------------------------------------------------------------------------
-- question_help_events (seção 4.4) — idempotência por tentativa+camada
-- IMPOSTA NO BANCO por um índice único (não só uma checagem em JS): a
-- MESMA camada da MESMA tentativa só pode ter, no máximo, uma linha, para
-- sempre — uma segunda abertura da mesma camada (reenvio, F5, corrida) é
-- tratada pelo serviço como "já aberta", nunca duplica.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_help_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_help_events_unique ON question_help_events (attempt_id, layer);

-- ---------------------------------------------------------------------------
-- question_review_bookmarks (seção 4.5) — único por usuário+questão,
-- imposto no banco (índice único), nunca só em JS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_review_bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_review_bookmarks_unique ON question_review_bookmarks (user_id, question_id);

-- ---------------------------------------------------------------------------
-- question_problem_reports (seção 4.5) — categoria técnica FECHADA (CHECK),
-- nunca um texto livre de categoria. `comment` é curto e opcional, validado/
-- truncado no serviço, e NUNCA vai integralmente para `audit_log` (seção
-- 15) — só id/categoria/metadados técnicos são auditados.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_problem_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  attempt_id TEXT REFERENCES question_attempts (id),
  category TEXT NOT NULL CHECK (category IN (
    'statement_problem', 'alternative_problem', 'answer_key_problem', 'image_problem', 'accessibility_problem', 'other'
  )),
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_problem_reports_user ON question_problem_reports (user_id);
CREATE INDEX IF NOT EXISTS idx_question_problem_reports_question ON question_problem_reports (question_id);

-- ---------------------------------------------------------------------------
-- Sprint 8 v1.2 — atomicidade real (não só idempotência) das mutações do
-- Player, mesma classe de correção da saga 0009-0012 do Banco de Questões.
--
-- O que `last_mutation_id` (acima) já resolvia por si só: qual das DUAS
-- chamadas concorrentes, calculando o MESMO `version + 1` aritmético,
-- realmente venceu — o guard do INSERT de evento pareado, condicionado a
-- `last_mutation_id = <id desta chamada>`, só aceitava o evento da chamada
-- vencedora. Isso é concorrência/idempotência corretas.
--
-- O que `last_mutation_id` sozinho NÃO provava: que, SE o UPDATE central de
-- `question_attempts` teve sucesso, o INSERT do evento obrigatório pareado
-- TAMBÉM teve sucesso — ANTES do commit. O INSERT de evento era um
-- `INSERT ... SELECT ... WHERE EXISTS(...)` guardado — uma forma
-- CONDICIONAL, que pode silenciosamente afetar zero linhas sem lançar erro
-- nenhum. O código em worker/src/services/playerService.ts só inspecionava
-- `coreResult.meta.changes` DEPOIS de `db.batch()` já ter retornado — ou
-- seja, depois de QUALQUER inconsistência real já ter sido COMMITADA.
-- Checar depois só DETECTA; nunca PREVINE. Exatamente o erro corrigido nas
-- migrations 0009-0012 para o núcleo de questões — aqui, o mesmo raciocínio,
-- adaptado: como não existe NENHUMA coleção para reconciliar neste domínio
-- (só um evento obrigatório por mutação — nunca "N linhas de uma coleção"),
-- não é preciso uma tabela de marcador separada: a PRÓPRIA linha de evento,
-- inserida de forma INCONDICIONAL (nunca mais guardada por WHERE EXISTS) e
-- usando como seu `id` o MESMO `mutationId` gravado em
-- `question_attempts.last_mutation_id` pelo UPDATE pareado no MESMO lote
-- (idêntico à convenção "NEW.id É o mutationId" de
-- migrations/0012_editorial_mutation_identity.sql), já SERVE como o próprio
-- marcador.
--
-- Mecanismo: um trigger `AFTER INSERT` em cada uma das três tabelas de
-- evento verifica, na MESMA transação, se `question_attempts` mostra
-- EXATAMENTE esta identidade (`id = NEW.attempt_id AND last_mutation_id =
-- NEW.id`). Se não mostrar — porque o UPDATE central falhou por conflito de
-- versão (0 linhas afetadas, `last_mutation_id` continua com o valor
-- anterior) ou por qualquer outro motivo — `RAISE(ABORT)` reverte a
-- transação INTEIRA, incluindo o próprio INSERT do evento que acabou de
-- rodar. Nunca existe uma janela, nem uma linha commitada, em que o evento
-- existe sem o núcleo correspondente (ou o núcleo mudou sem o evento).
--
-- ORDEM exigida no serviço (worker/src/services/playerService.ts): UPDATE
-- central de `question_attempts` PRIMEIRO no lote, INSERT do evento
-- (incondicional) por ÚLTIMO — para que, quando o INSERT do evento dispara
-- este trigger, o resultado real do UPDATE já esteja visível na mesma
-- transação.
--
-- Uma FALHA GENUÍNA de SQL ao gravar o evento (ex.: violação de CHECK/FK)
-- nunca chega a disparar este trigger — a própria linha nunca é inserida, e
-- o erro do INSERT já reverte a transação sozinho (garantia nativa de
-- qualquer motor SQL transacional, D1 incluído).
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_question_answer_events_require_attempt_identity
AFTER INSERT ON question_answer_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM question_attempts WHERE id = NEW.attempt_id AND last_mutation_id = NEW.id
    )
    THEN RAISE(ABORT, 'invariante violada: question_answer_events inserido sem question_attempts.last_mutation_id correspondente (por identidade)')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_question_recognition_events_require_attempt_identity
AFTER INSERT ON question_recognition_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM question_attempts WHERE id = NEW.attempt_id AND last_mutation_id = NEW.id
    )
    THEN RAISE(ABORT, 'invariante violada: question_recognition_events inserido sem question_attempts.last_mutation_id correspondente (por identidade)')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_question_help_events_require_attempt_identity
AFTER INSERT ON question_help_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM question_attempts WHERE id = NEW.attempt_id AND last_mutation_id = NEW.id
    )
    THEN RAISE(ABORT, 'invariante violada: question_help_events inserido sem question_attempts.last_mutation_id correspondente (por identidade)')
  END;
END;
