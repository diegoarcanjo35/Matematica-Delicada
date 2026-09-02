-- Sprint 12 v1.0 — Simulados em Blocos e Análise Factual de Desempenho.
-- Puramente aditiva sobre o schema das Sprints 1-11 (0001-0016): só CREATE
-- TABLE/INDEX/TRIGGER IF NOT EXISTS, nenhum ALTER TABLE, nenhuma migration
-- anterior é editada. A próxima sprint deve começar sua própria migration em
-- `0018` — nunca reaproveitar ou renumerar 0001-0017.
--
-- Reaproveita integralmente o schema já existente das Sprints 6-8 (nenhuma
-- tabela nova para questões/padrões/tentativas): `questions`, `patterns`,
-- `question_patterns`, `question_attempts` (Sprint 8). O simulado em blocos
-- é uma camada de ORQUESTRAÇÃO sobre essas tabelas, nunca uma cópia dos
-- dados delas — ver worker/src/lib/simulationRules.ts (algoritmo
-- determinístico centralizado) e worker/src/repositories/
-- simulationsRepository.ts (consultas de candidatos, sempre lendo as
-- tabelas de evidência reais). Mesma classe de mecanismo de atomicidade já
-- comprovada em migrations/0013 (Player), 0014 (Caderno de Erros) e 0016
-- (Treino Diário) — reaplicada aqui sem inventar nada novo.
--
-- Seção 1/28 da ordem: esta funcionalidade NUNCA é "prova oficial do ENEM"
-- nem calcula TRI/nota estimada/ranking — só o schema técnico mínimo para
-- um "bloco de questões" real, usando exclusivamente conteúdo publicado do
-- Banco de Questões e reutilizando o Player já existente (nenhuma tabela
-- aqui armazena resposta, texto livre ou qualquer dado sensível).
--
-- ---------------------------------------------------------------------------
-- simulation_blocks — uma linha por bloco APLICADO explicitamente (nunca uma
-- prévia — seção 7 da ordem: "nenhum GET pode criar bloco"; só
-- POST /api/simulations/apply grava esta tabela). `block_date` é a data
-- CIVIL (YYYY-MM-DD) no fuso do aluno NO MOMENTO DO APPLY — mesma convenção
-- de daily_training_lists.training_date (migrations/0016). `timezone` é
-- carimbado pelo mesmo motivo (um bloco já aplicado nunca muda de "dia"
-- retroativamente se o aluno trocar de fuso depois).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulation_blocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- Seção 6 da ordem: só dois tipos oferecidos nesta sprint.
  block_type TEXT NOT NULL CHECK (block_type IN ('mixed', 'pattern_focused')),
  -- Obrigatório quando (e só quando) block_type = 'pattern_focused' — seção
  -- 5 da ordem ("primary_pattern_id anulável e obrigatório apenas no modo
  -- focado"), garantido no próprio CHECK, nunca só por convenção de
  -- aplicação.
  primary_pattern_id TEXT REFERENCES patterns (id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  -- Tamanho SOLICITADO pelo aluno no momento do apply — seção 6 da ordem,
  -- só os três tamanhos técnicos provisórios permitidos (nunca 45 — "prova
  -- completa" nunca é implementada nesta sprint).
  planned_item_count INTEGER NOT NULL CHECK (planned_item_count IN (5, 10, 15)),
  -- Quantidade REAL de itens persistidos — pode ser MENOR que
  -- planned_item_count quando não há questões treináveis suficientes (seção
  -- 6/7 da ordem: "ausência de questões suficientes gera estado honesto,
  -- nunca preenchimento artificial"), mas NUNCA zero (seção 9: "nunca
  -- persistir bloco vazio").
  actual_item_count INTEGER NOT NULL CHECK (actual_item_count > 0 AND actual_item_count <= planned_item_count),
  -- Soma das estimativas dos itens no momento do apply — sempre
  -- "aproximadamente" na apresentação ao aluno (seção 11 da ordem), nunca
  -- uma medição exata.
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes >= 0),
  timezone TEXT NOT NULL,
  block_date TEXT NOT NULL,
  -- Concorrência otimista — mesma convenção do resto do projeto desde a
  -- Sprint 5.
  version INTEGER NOT NULL DEFAULT 1,
  -- Identidade da MUTAÇÃO ESPECÍFICA que gravou esta linha por último —
  -- mesmo papel de daily_training_lists.last_mutation_id (migrations/0016).
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  abandoned_at TEXT,
  -- Seção 5 da ordem: "primary_pattern_id anulável e obrigatório apenas no
  -- modo focado" — garantido aqui, na constraint de TABELA (posicionada ao
  -- final, depois de todas as colunas — exigência de sintaxe do motor
  -- SQLite embutido usado pelos testes locais, node:sqlite), nunca só por
  -- convenção de aplicação.
  CHECK (
    (block_type = 'pattern_focused' AND primary_pattern_id IS NOT NULL)
    OR (block_type = 'mixed' AND primary_pattern_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_simulation_blocks_user ON simulation_blocks (user_id);
CREATE INDEX IF NOT EXISTS idx_simulation_blocks_user_status ON simulation_blocks (user_id, status);

-- Seção 9 da ordem: "impedir duas sessões ativas concorrentes" — mesmo
-- padrão comprovado em migrations/0005 (diagnóstico), 0013 (tentativa
-- in_progress), 0014 (revisão in_progress por entrada) e 0016 (lista ativa
-- por dia): um índice único PARCIAL, restrito a status = 'active'. Diferente
-- do Treino Diário (uma lista ativa POR DIA), aqui é "no máximo um bloco
-- ativo por aluno", sem escopo de data — seção 5 da ordem: "garantir no
-- banco no máximo um bloco active por aluno" (nunca por aluno/dia).
CREATE UNIQUE INDEX IF NOT EXISTS idx_simulation_blocks_one_active_per_user
  ON simulation_blocks (user_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- simulation_block_items — os itens concretos de UM bloco, persistidos
-- atomicamente junto com ele no apply (seção 9 da ordem). Cada item
-- referencia diretamente uma questão PUBLICADA do Banco de Questões — nunca
-- uma cópia do conteúdo editorial.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulation_block_items (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES simulation_blocks (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  -- Padrão PRINCIPAL da questão no momento da seleção (seção 8 da ordem:
  -- "usar padrão principal, não secundário, para composição") — carimbado
  -- aqui (não relido de question_patterns depois) pela mesma razão técnica
  -- de daily_training_items.primary_pattern_id.
  primary_pattern_id TEXT REFERENCES patterns (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'blocked')),
  -- Ligação com o Player (seção 10 da ordem) — só não-nulo depois do
  -- endpoint /start. Referencia diretamente question_attempts (Sprint 8) —
  -- nenhuma tentativa é duplicada ou espelhada aqui.
  question_attempt_id TEXT REFERENCES question_attempts (id),
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
  version INTEGER NOT NULL DEFAULT 1,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_simulation_block_items_block ON simulation_block_items (block_id);
CREATE INDEX IF NOT EXISTS idx_simulation_block_items_user ON simulation_block_items (user_id);
CREATE INDEX IF NOT EXISTS idx_simulation_block_items_attempt ON simulation_block_items (question_attempt_id);

-- Seção 5/8 da ordem: "questão única por bloco" — garantido no BANCO, não
-- só no algoritmo de seleção em JS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_simulation_block_items_block_question
  ON simulation_block_items (block_id, question_id);

-- Seção 5 da ordem: "posição única no bloco" — ordem de apresentação
-- determinística e sem colisão dentro do mesmo bloco.
CREATE UNIQUE INDEX IF NOT EXISTS idx_simulation_block_items_block_position
  ON simulation_block_items (block_id, position);

-- Seção 5 da ordem: "tentativa associada no máximo a um item de simulado" —
-- impede que duas linhas de simulation_block_items apontem para a mesma
-- question_attempts por engano de corrida (mesma garantia espelhada já
-- comprovada em migrations/0016 para o Treino Diário; a criação/retomada em
-- si já é protegida no nível do Player por idx_question_attempts_one_active,
-- migrations/0013).
CREATE UNIQUE INDEX IF NOT EXISTS idx_simulation_block_items_attempt_unique
  ON simulation_block_items (question_attempt_id)
  WHERE question_attempt_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- simulation_block_events — histórico append-only de mutações REAIS (seção 5
-- da ordem). Nunca armazena resposta, texto livre, token ou conteúdo
-- sensível (seção 5/17 da ordem) — só os fatos técnicos mínimos (tipo,
-- bloco, item, quando). `item_id` é nulo para os três eventos de nível de
-- BLOCO (block_applied/block_completed/block_abandoned) e obrigatório para
-- os três de nível de ITEM (item_started/item_completed/item_skipped) —
-- reforçado pelo trigger abaixo, nunca só por convenção. `item_blocked`
-- (seção 5 da ordem: "item bloqueado" é um evento a ser suportado) cobre uma
-- questão que deixou de estar disponível (despublicada) entre a aplicação
-- do bloco e a tentativa de início — mesmo papel do 'item_blocked' do
-- Treino Diário (migrations/0016).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS simulation_block_events (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES simulation_blocks (id),
  item_id TEXT REFERENCES simulation_block_items (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'block_applied', 'item_started', 'item_completed', 'item_skipped', 'item_blocked',
    'block_completed', 'block_abandoned'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_simulation_block_events_block ON simulation_block_events (block_id, created_at);
CREATE INDEX IF NOT EXISTS idx_simulation_block_events_item ON simulation_block_events (item_id);

-- ---------------------------------------------------------------------------
-- Atomicidade real (seção 9/19 da ordem) — mesma classe de mecanismo
-- "marcador incondicional + RAISE(ABORT) por identidade, ANTES do commit"
-- já comprovada nas migrations 0009-0014 e 0016. Cada INSERT em
-- simulation_block_events é INCONDICIONAL (nunca um `WHERE EXISTS` que pode
-- silenciosamente afetar zero linhas) e usa como seu próprio `id` o MESMO
-- `mutationId` gravado em simulation_blocks.last_mutation_id (eventos de
-- bloco) ou simulation_block_items.last_mutation_id (eventos de item) pelo
-- INSERT/UPDATE pareado, no MESMO lote.
--
-- Um único trigger consolidado (mesmo padrão de migrations/0016) cobre as
-- três formas de exigência:
--   1) eventos de BLOCO exigem identidade em simulation_blocks;
--   2) especificamente para 'block_applied', exige ADICIONALMENTE que
--      actual_item_count já bata com a contagem REAL de linhas em
--      simulation_block_items para este bloco — prova, ANTES do commit, que
--      "o bloco foi criado" e "todos os itens foram persistidos" são
--      sempre o MESMO fato;
--   3) eventos de ITEM exigem identidade em simulation_block_items,
--      incluindo pertencer ao MESMO bloco e ao MESMO usuário do evento.
--
-- Qualquer divergência reverte a transação INTEIRA (`RAISE(ABORT)`) — nunca
-- existe uma janela, nem uma linha commitada, em que o evento existe sem o
-- núcleo correspondente (ou o núcleo mudou sem o evento).
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_simulation_block_events_require_identity
AFTER INSERT ON simulation_block_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.event_type IN ('block_applied', 'block_completed', 'block_abandoned')
     AND NOT EXISTS (
       SELECT 1 FROM simulation_blocks
       WHERE id = NEW.block_id AND user_id = NEW.user_id AND last_mutation_id = NEW.id
     )
    THEN RAISE(ABORT, 'invariante violada: evento de bloco sem simulation_blocks.last_mutation_id correspondente (por identidade)')
  END;

  SELECT CASE
    WHEN NEW.event_type = 'block_applied'
     AND (
       (SELECT actual_item_count FROM simulation_blocks WHERE id = NEW.block_id)
       IS NOT (SELECT COUNT(*) FROM simulation_block_items WHERE block_id = NEW.block_id)
     )
    THEN RAISE(ABORT, 'invariante violada: block_applied com actual_item_count divergente da contagem real de itens')
  END;

  SELECT CASE
    WHEN NEW.event_type IN ('item_started', 'item_completed', 'item_skipped', 'item_blocked')
     AND (
       NEW.item_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM simulation_block_items
         WHERE id = NEW.item_id AND block_id = NEW.block_id AND user_id = NEW.user_id AND last_mutation_id = NEW.id
       )
     )
    THEN RAISE(ABORT, 'invariante violada: evento de item sem simulation_block_items.last_mutation_id correspondente (por identidade, mesmo bloco, mesmo usuário)')
  END;
END;
