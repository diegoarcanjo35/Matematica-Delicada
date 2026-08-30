-- Sprint 7 v1.0 — fundação editorial do Banco de Questões (Documento Mestre,
-- seções 3, 9, 12, 13, 36-40, 42-45). Aditiva e não destrutiva: só
-- CREATE TABLE/INDEX IF NOT EXISTS. Nenhuma alteração nas tabelas das
-- Sprints 1-6. Nenhuma linha de conteúdo é inserida por esta migration — o
-- seed de fixtures técnicas vive em scripts/fixtures/questions-fixtures.local.sql
-- e o bootstrap de papéis locais em scripts/fixtures/roles-fixtures.local.sql,
-- os dois aplicados manualmente com --local e gateados em runtime por
-- worker/src/env.ts:isLocalEditorialFixturesAllowed.
--
-- Esta sprint NÃO entrega: player do aluno, tentativas/respostas, treino
-- diário, Caderno de Erros, cálculo dos três índices, upload remoto de
-- mídia/R2, questões oficiais reais, publicação em produção.

-- ---------------------------------------------------------------------------
-- RBAC mínimo real (seção 4 da ordem) — papéis modelados de forma extensível.
-- Nenhum papel é concedido por GET nem por cadastro comum; só pelo bootstrap
-- local gateado (seção 4.2) ou, em produção futura, por um fluxo
-- administrativo fora do escopo desta sprint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('student', 'teacher', 'editor', 'admin', 'support', 'commercial')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles (name);

CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Quem concedeu o papel — NULL apenas para o bootstrap técnico local
  -- (nenhum usuário "concedente" existe ainda nesse momento).
  granted_by TEXT REFERENCES users (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_unique ON user_roles (user_id, role_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles (user_id);

-- ---------------------------------------------------------------------------
-- questions (seção 5.1) — o registro editorial central. `version` é a mesma
-- concorrência otimista já usada em schedule_activity_assignments/patterns.
-- `fingerprint` é um hash técnico (calculado no serviço, nunca no banco) do
-- conteúdo normalizado, usado só para SINALIZAR possível duplicidade — nunca
-- uma constraint UNIQUE (uma colisão de hash não pode travar a criação de uma
-- questão legítima; a checagem de duplicidade acontece no serviço/import).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  enunciado TEXT NOT NULL,
  resolucao_comentada TEXT NOT NULL DEFAULT '',
  conteudo TEXT NOT NULL DEFAULT '',
  subconteudo TEXT NOT NULL DEFAULT '',
  habilidade TEXT NOT NULL DEFAULT '',
  competencia TEXT NOT NULL DEFAULT '',
  dificuldade TEXT NOT NULL CHECK (dificuldade IN ('facil', 'media', 'dificil')),
  origem TEXT NOT NULL CHECK (origem IN (
    'oficial', 'autoral', 'licenciada', 'diagnostico', 'reconhecimento', 'revisao_base'
  )),
  prova TEXT,
  ano INTEGER,
  tempo_estimado_segundos INTEGER,
  tipo_calculo TEXT NOT NULL DEFAULT 'misto' CHECK (tipo_calculo IN ('mental', 'escrito', 'misto')),
  necessita_calculadora INTEGER NOT NULL DEFAULT 0 CHECK (necessita_calculadora IN (0, 1)),
  editorial_status TEXT NOT NULL DEFAULT 'draft' CHECK (editorial_status IN (
    'draft', 'in_review', 'changes_requested', 'approved', 'published', 'archived'
  )),
  autor_id TEXT REFERENCES users (id),
  revisor_id TEXT REFERENCES users (id),
  titular_direitos TEXT,
  base_licenca TEXT,
  texto_atribuicao TEXT,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_local_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_local_fixture IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_code ON questions (code);
CREATE INDEX IF NOT EXISTS idx_questions_fingerprint ON questions (fingerprint);
CREATE INDEX IF NOT EXISTS idx_questions_editorial_status ON questions (editorial_status);
CREATE INDEX IF NOT EXISTS idx_questions_autor ON questions (autor_id);

-- ---------------------------------------------------------------------------
-- question_alternatives (seção 5.2) — exatamente A-E, uma por letra
-- (UNIQUE), texto não vazio (CHECK). "Exatamente uma correta" e "exatamente
-- cinco linhas" NÃO são expressáveis num CHECK de linha única do SQLite/D1 —
-- impostos no serviço transacional (worker/src/services/questionService.ts)
-- e provados por teste (seção 5.2 da ordem).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_alternatives (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  letter TEXT NOT NULL CHECK (letter IN ('A', 'B', 'C', 'D', 'E')),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  is_correct INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0, 1)),
  distractor_explanation TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_alternatives_letter ON question_alternatives (question_id, letter);
CREATE INDEX IF NOT EXISTS idx_question_alternatives_question ON question_alternatives (question_id);

-- ---------------------------------------------------------------------------
-- question_images (seção 5.3) — metadados apenas; nenhum upload remoto nesta
-- sprint. `asset_ref` é sempre um caminho local do repositório (validado no
-- serviço — nunca uma URL externa arbitrária). `alt_text` pode nascer vazio
-- no rascunho, mas é exigido não-vazio ANTES de enviar para revisão
-- (validado no serviço, nunca aqui).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_images (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  asset_ref TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  caption TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  titular_direitos TEXT,
  base_licenca TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_images_question ON question_images (question_id, position);

-- ---------------------------------------------------------------------------
-- question_patterns (seção 5.4) — FK para patterns.id, nunca slug/code.
-- UNIQUE(question_id, pattern_id) impede o mesmo padrão como principal E
-- secundário simultaneamente (e impede duplicidade lisa e simples). O índice
-- único parcial abaixo impede mais de um padrão PRINCIPAL por questão.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_patterns (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  role TEXT NOT NULL CHECK (role IN ('principal', 'secundario')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_patterns_unique ON question_patterns (question_id, pattern_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_question_patterns_one_principal
  ON question_patterns (question_id)
  WHERE role = 'principal';
CREATE INDEX IF NOT EXISTS idx_question_patterns_pattern ON question_patterns (pattern_id);

-- ---------------------------------------------------------------------------
-- question_tags (seção 5.4) — relação multivalorada normalizada dedicada
-- (não a tabela genérica pattern_attributes da Sprint 6: aqui só existe UM
-- tipo de atributo multivalorado — tag —, então uma tabela genérica de
-- atributo/tipo seria over-engineering para um único caso; decisão
-- justificada em docs/BANCO_QUESTOES.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_tags (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_tags_unique ON question_tags (question_id, content);
CREATE INDEX IF NOT EXISTS idx_question_tags_question ON question_tags (question_id, position);

-- ---------------------------------------------------------------------------
-- question_dna (seção 5.5) — modelada separadamente, um-para-um com a
-- questão (PK = question_id). Componentes obrigatórios (todos exceto
-- `atalho`, que é opcional) são validados como não-vazios no serviço antes
-- de aprovação/publicação — nunca aqui, para permitir rascunho incompleto.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_dna (
  question_id TEXT PRIMARY KEY REFERENCES questions (id),
  pista TEXT NOT NULL DEFAULT '',
  estrategia TEXT NOT NULL DEFAULT '',
  pegadinha TEXT NOT NULL DEFAULT '',
  conteudo_apoio TEXT NOT NULL DEFAULT '',
  resolucao TEXT NOT NULL DEFAULT '',
  atalho TEXT,
  aprendizado_erro TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- question_history (seção 5.6) — append-only. NUNCA armazena o texto
-- integral da questão/resolução (só o estado/versão e metadados técnicos
-- fechados). Nenhum UPDATE/DELETE é emitido contra esta tabela por nenhum
-- código de produção (convenção verificada por teste).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_history (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  user_id TEXT REFERENCES users (id),
  action TEXT NOT NULL CHECK (action IN (
    'created', 'updated', 'submitted_review', 'changes_requested',
    'approved', 'published', 'archived', 'import_applied', 'import_undone'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL,
  version INTEGER NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_history_question ON question_history (question_id, created_at);

-- ---------------------------------------------------------------------------
-- Importação CSV (seção 8) — registro técnico leve de lote/prévia, com
-- expiração. `payload` guarda as linhas JÁ VALIDADAS (nunca o CSV bruto) —
-- nunca conteúdo de log; só o necessário para reaplicar o mesmo apply.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_import_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'applied', 'undone', 'expired')),
  row_count INTEGER NOT NULL,
  valid_row_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  undone_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_question_import_batches_user ON question_import_batches (user_id);

CREATE TABLE IF NOT EXISTS question_import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES question_import_batches (id),
  row_number INTEGER NOT NULL,
  code TEXT NOT NULL,
  question_id TEXT REFERENCES questions (id)
);

CREATE INDEX IF NOT EXISTS idx_question_import_items_batch ON question_import_items (batch_id);
