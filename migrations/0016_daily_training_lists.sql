-- Sprint 11 v1.0 — Treino Diário Real e Listas Adaptativas. Puramente
-- aditiva sobre o schema das Sprints 1-10 (0001-0015): só CREATE TABLE/
-- INDEX/TRIGGER IF NOT EXISTS, nenhum ALTER TABLE, nenhuma migration
-- anterior é editada. A Sprint 12 deve começar sua própria migration em
-- `0017` — nunca reaproveitar ou renumerar 0001-0016.
--
-- Reaproveita integralmente o schema já existente das Sprints 6-10 (nenhuma
-- tabela nova para questões/padrões/revisão/cronograma): `questions`,
-- `patterns`, `question_patterns`, `question_attempts` (Sprint 8),
-- `error_notebook_entries`/`error_review_events` (Sprint 9),
-- `schedule_activity_assignments` (Sprint 5). O treino diário é uma camada
-- de ORQUESTRAÇÃO sobre essas tabelas, nunca uma cópia dos dados delas —
-- ver worker/src/lib/dailyTrainingRules.ts (algoritmo provisório
-- centralizado) e worker/src/repositories/dailyTrainingRepository.ts
-- (consultas de candidatos, sempre lendo as tabelas de evidência reais).
--
-- ---------------------------------------------------------------------------
-- daily_training_lists — uma linha por (aluno, data local de treino)
-- efetivamente APLICADA (nunca uma prévia — seção 6 da ordem: "o GET de
-- preview nunca pode criar lista"; só POST /api/daily-training/apply grava
-- esta tabela). `training_date` é a data CIVIL (YYYY-MM-DD) no fuso do
-- aluno NO MOMENTO DO APPLY — mesma convenção de `schedule_activity_
-- assignments.planned_date`/`civilDateInTimezone` (worker/src/lib/
-- scheduleValidation.ts), reaproveitada aqui sem duplicar a função.
-- `timezone` é carimbado (não só lido de schedule_preferences) para que uma
-- lista já aplicada nunca mude de "dia" retroativamente se o aluno trocar
-- de fuso depois — mesma razão de robustez de `question_attempts.
-- question_version` (Sprint 8): um carimbo técnico, não uma referência viva.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_training_lists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  training_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  -- Soma das estimativas dos itens no momento do apply — sempre "aproximadamente"
  -- na apresentação ao aluno (seção 8 da ordem), nunca uma medição exata.
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes >= 0),
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  -- Concorrência otimista — mesma convenção de todo o resto do projeto desde
  -- a Sprint 5 (schedule_activity_assignments.version).
  version INTEGER NOT NULL DEFAULT 1,
  -- Identidade da MUTAÇÃO ESPECÍFICA que gravou esta linha por último —
  -- mesmo papel de question_attempts.last_mutation_id (migrations/0013) e
  -- error_notebook_entries.last_mutation_id (migrations/0014). Setada pelo
  -- MESMO INSERT/UPDATE guardado que muda `version`; o trigger no final
  -- deste arquivo compara contra ela, nunca contra um número de versão
  -- resultante sozinho (mesma lição da Sprint 7 v1.6, migrations/0012).
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_training_lists_user_date ON daily_training_lists (user_id, training_date);
CREATE INDEX IF NOT EXISTS idx_daily_training_lists_user_status ON daily_training_lists (user_id, status);

-- Seção 5 da ordem: "garantir no banco, por índice único parcial, no máximo
-- uma lista active por aluno e data local" — mesmo padrão comprovado em
-- migrations/0005 (diagnóstico), 0013 (tentativa in_progress) e 0014
-- (revisão in_progress por entrada): um índice único PARCIAL, que só
-- restringe linhas com status = 'active'. Dois applies concorrentes para o
-- MESMO aluno/dia só podem ambos inserir se SQLite/D1 permitisse a
-- violação — não permite; o serviço (worker/src/services/
-- dailyTrainingService.ts) trata a violação como "já existe, devolva a
-- existente" — garantia real de banco, nunca uma checagem em JS que
-- poderia perder a corrida.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_training_lists_one_active_per_day
  ON daily_training_lists (user_id, training_date)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- daily_training_items — os itens concretos de UMA lista, persistidos
-- atomicamente junto com ela no apply (seção 6 da ordem: "persistir lista e
-- itens atomicamente"). `origin` é a categoria AMPLA exigida pela seção 5
-- da ordem (cinco valores fechados); `reason` é a razão TÉCNICA CURTA E
-- FECHADA exigida pela seção 7 ("fornecer motivo técnico curto e
-- compreensível para cada item") — os seis valores de `reason` casam 1:1
-- com as seis camadas de prioridade da seção 7, e cada `reason` mapeia para
-- exatamente um `origin` (tabela fixa em worker/src/lib/dailyTrainingRules.ts:
-- REASON_TO_ORIGIN — nunca decidida ad-hoc por chamada). `scheduled_review`
-- é um valor LEGAL do CHECK de `origin` (fidelidade à seção 5 da ordem, que
-- lista os cinco valores explicitamente) mas nenhum caminho de código desta
-- sprint o escreve — mesmo precedente já documentado para `'overdue'` em
-- migrations/0006 (ver scheduleValidation.ts): reservado para uma futura
-- extensão (revisão ainda não vencida, incorporada preventivamente), sem
-- fechar a porta a essa evolução com uma migration nova.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_training_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES daily_training_lists (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  primary_pattern_id TEXT REFERENCES patterns (id),
  origin TEXT NOT NULL CHECK (origin IN (
    'overdue_review', 'scheduled_review', 'development', 'consistency', 'schedule_commitment'
  )),
  reason TEXT NOT NULL CHECK (reason IN (
    'overdue_review', 'schedule_commitment', 'pattern_in_development',
    'pattern_initial_evidence', 'pattern_maintenance', 'pattern_exploration'
  )),
  player_mode TEXT NOT NULL CHECK (player_mode IN ('learning', 'practice', 'recognition')),
  position INTEGER NOT NULL CHECK (position >= 0),
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'blocked')),
  -- Ligação com o Player (seção 10 da ordem) — só não-nulo depois do
  -- endpoint /start. Referencia diretamente question_attempts (Sprint 8) —
  -- nenhuma tentativa é duplicada ou espelhada aqui.
  question_attempt_id TEXT REFERENCES question_attempts (id),
  -- Só não-nulo quando origin = 'overdue_review' — liga o item à entrada
  -- real do Caderno de Erros (Sprint 9) cuja revisão este item representa;
  -- reaproveita startOrResumeReviewAttempt/selectSimilarQuestion já
  -- existentes (worker/src/services/playerService.ts,
  -- worker/src/repositories/errorNotebookRepository.ts) em vez de duplicar
  -- a lógica de seleção de questão semelhante.
  error_entry_id TEXT REFERENCES error_notebook_entries (id),
  -- Só não-nulo quando origin = 'schedule_commitment' — liga o item à
  -- atribuição real do cronograma (Sprint 5) que motivou sua inclusão,
  -- usado pelo touch-point da seção 13 ("Cronograma consegue indicar que o
  -- compromisso do dia entrou no treino"). Coluna ADICIONAL sobre o mínimo
  -- da seção 5 da ordem (que permite campos além do mínimo listado),
  -- deliberadamente nula para todos os outros origins.
  source_schedule_assignment_id TEXT REFERENCES schedule_activity_assignments (id),
  -- Razão técnica fechada de por que o item foi PULADO (seção 12 da ordem:
  -- "pular com confirmação e motivo técnico fechado") — só não-nula quando
  -- status = 'skipped'. Nunca texto livre.
  skip_reason TEXT CHECK (skip_reason IN ('not_now', 'too_hard', 'already_know', 'out_of_time')),
  version INTEGER NOT NULL DEFAULT 1,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_training_items_list ON daily_training_items (list_id);
CREATE INDEX IF NOT EXISTS idx_daily_training_items_user ON daily_training_items (user_id);
CREATE INDEX IF NOT EXISTS idx_daily_training_items_attempt ON daily_training_items (question_attempt_id);

-- Seção 7 da ordem: "não repetir a mesma questão dentro da lista" —
-- garantido no BANCO, não só no algoritmo de seleção em JS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_training_items_list_question
  ON daily_training_items (list_id, question_id);

-- Ordem de apresentação determinística e sem colisão dentro da mesma lista.
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_training_items_list_position
  ON daily_training_items (list_id, position);

-- No máximo um item do treino diário associado à MESMA tentativa do Player
-- — impede que duas linhas de daily_training_items apontem para a mesma
-- question_attempts por engano de corrida (start concorrente já é resolvido
-- no nível do Player por idx_question_attempts_one_active, migrations/0013;
-- este índice é a garantia espelhada do lado do treino diário).
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_training_items_attempt_unique
  ON daily_training_items (question_attempt_id)
  WHERE question_attempt_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- daily_training_events — histórico append-only de mutações REAIS (seção 5
-- da ordem). Nunca armazena texto livre pedagógico nem resposta do aluno
-- (seção 5/14 da ordem) — só os fatos técnicos mínimos (tipo, lista, item,
-- quando). `item_id` é nulo para os três eventos de nível de LISTA
-- (list_created/list_completed/list_abandoned) e obrigatório para os
-- quatro de nível de ITEM (item_started/item_completed/item_skipped/
-- item_blocked) — reforçado pelo trigger abaixo, nunca só por convenção.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_training_events (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES daily_training_lists (id),
  item_id TEXT REFERENCES daily_training_items (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'list_created', 'item_started', 'item_completed', 'item_skipped', 'item_blocked',
    'list_completed', 'list_abandoned'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_daily_training_events_list ON daily_training_events (list_id, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_training_events_item ON daily_training_events (item_id);

-- ---------------------------------------------------------------------------
-- Atomicidade real (seção 15 da ordem) — mesma classe de mecanismo
-- "marcador incondicional + RAISE(ABORT) por identidade, ANTES do commit"
-- já comprovada nas migrations 0009-0014 (Banco de Questões, Player,
-- Caderno de Erros). Cada INSERT em daily_training_events é INCONDICIONAL
-- (nunca um `WHERE EXISTS` que pode silenciosamente afetar zero linhas) e
-- usa como seu próprio `id` o MESMO `mutationId` gravado em
-- daily_training_lists.last_mutation_id (eventos de lista) ou
-- daily_training_items.last_mutation_id (eventos de item) pelo
-- INSERT/UPDATE pareado, no MESMO lote — a própria linha de evento já SERVE
-- como marcador, sem precisar de uma tabela de marcador separada (mesma
-- decisão de simplicidade de migrations/0013 para este domínio, que também
-- não tem coleções para reconciliar).
--
-- Um único trigger consolidado (mesmo padrão de migrations/0012 para o
-- núcleo editorial) cobre as três formas de exigência:
--   1) eventos de LISTA exigem identidade em daily_training_lists;
--   2) especificamente para 'list_created', exige ADICIONALMENTE que
--      item_count já bata com a contagem REAL de linhas em
--      daily_training_items para esta lista — prova, ANTES do commit, que
--      "a lista foi criada" e "todos os itens foram persistidos" são
--      sempre o MESMO fato, nunca dois fatos que um bug poderia separar
--      (ex.: um item rejeitado pelo índice único de questão duplicada
--      já teria abortado o lote inteiro antes mesmo de chegar aqui, mas
--      esta checagem cobre qualquer outro caminho de divergência futuro);
--   3) eventos de ITEM exigem identidade em daily_training_items, incluindo
--      pertencer à MESMA lista e ao MESMO usuário do evento (nunca só a
--      mesma identidade de mutação por coincidência — mesma disciplina de
--      migrations/0014 v1.1 para os dois triggers do Caderno de Erros).
--
-- Qualquer divergência reverte a transação INTEIRA (`RAISE(ABORT)`) — nunca
-- existe uma janela, nem uma linha commitada, em que o evento existe sem o
-- núcleo correspondente (ou o núcleo mudou sem o evento).
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_daily_training_events_require_identity
AFTER INSERT ON daily_training_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.event_type IN ('list_created', 'list_completed', 'list_abandoned')
     AND NOT EXISTS (
       SELECT 1 FROM daily_training_lists
       WHERE id = NEW.list_id AND user_id = NEW.user_id AND last_mutation_id = NEW.id
     )
    THEN RAISE(ABORT, 'invariante violada: evento de lista sem daily_training_lists.last_mutation_id correspondente (por identidade)')
  END;

  SELECT CASE
    WHEN NEW.event_type = 'list_created'
     AND (
       (SELECT item_count FROM daily_training_lists WHERE id = NEW.list_id)
       IS NOT (SELECT COUNT(*) FROM daily_training_items WHERE list_id = NEW.list_id)
     )
    THEN RAISE(ABORT, 'invariante violada: list_created com item_count divergente da contagem real de itens')
  END;

  SELECT CASE
    WHEN NEW.event_type IN ('item_started', 'item_completed', 'item_skipped', 'item_blocked')
     AND (
       NEW.item_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM daily_training_items
         WHERE id = NEW.item_id AND list_id = NEW.list_id AND user_id = NEW.user_id AND last_mutation_id = NEW.id
       )
     )
    THEN RAISE(ABORT, 'invariante violada: evento de item sem daily_training_items.last_mutation_id correspondente (por identidade, mesma lista, mesmo usuário)')
  END;
END;
