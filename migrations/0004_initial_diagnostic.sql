-- Sprint 4 v1.0 — motor técnico do diagnóstico inicial (Documento Mestre,
-- seções 3 e 4). Aditiva e não destrutiva: só CREATE TABLE IF NOT EXISTS.
-- Nenhuma alteração nas tabelas das Sprints 1-3. Sem tabela/campo para
-- fórmula TRI, domínio definitivo ou cronograma adaptativo — fora do
-- escopo desta sprint (seção 6 da ordem).
--
-- IMPORTANTE: esta migration só cria a ESTRUTURA. O CONTEÚDO (as 12
-- questões técnicas provisórias) nunca é inserido por uma migration —
-- migrations rodam também no D1 remoto quando autorizado no futuro, e o
-- conteúdo de fixture nunca pode chegar lá. O seed vive em
-- scripts/fixtures/diagnostic-fixtures.local.sql, aplicado manualmente e
-- apenas com --local (ver worker/src/env.ts:isLocalDiagnosticFixturesAllowed
-- para o gate em runtime, independente disso).

CREATE TABLE IF NOT EXISTS diagnostic_questions (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  -- Ordem de apresentação padrão do catálogo (mistura de padrões/dificuldades,
  -- Documento Mestre seção 4.2) — não é dificuldade nem taxonomia definitiva.
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_questions_position ON diagnostic_questions (position);

CREATE TABLE IF NOT EXISTS diagnostic_question_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnostic_options_question_position
  ON diagnostic_question_options (question_id, position);
CREATE INDEX IF NOT EXISTS idx_diagnostic_options_question
  ON diagnostic_question_options (question_id);

-- Configuração OPCIONAL de reconhecimento (Documento Mestre, seção 4.2:
-- "perguntas de reconhecimento antes ou durante parte das resoluções") — a
-- ausência de linhas para uma question_id significa "sem pergunta de
-- reconhecimento configurada para esta questão".
CREATE TABLE IF NOT EXISTS diagnostic_question_recognition_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnostic_recognition_question_position
  ON diagnostic_question_recognition_options (question_id, position);
CREATE INDEX IF NOT EXISTS idx_diagnostic_recognition_question
  ON diagnostic_question_recognition_options (question_id);

-- As quatro camadas de ajuda (Documento Mestre, seção 3.2).
CREATE TABLE IF NOT EXISTS diagnostic_question_help_layers (
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  content TEXT NOT NULL,
  PRIMARY KEY (question_id, layer)
);

CREATE TABLE IF NOT EXISTS diagnostic_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'abandoned')),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_attempts_user ON diagnostic_attempts (user_id);

-- Conjunto/ordem das questões de UMA tentativa — cada tentativa referencia
-- explicitamente suas questões (em vez de "todas as questões existentes"),
-- para que o conteúdo poder crescer/mudar no futuro sem invalidar tentativas
-- já em andamento ou concluídas.
CREATE TABLE IF NOT EXISTS diagnostic_attempt_questions (
  attempt_id TEXT NOT NULL REFERENCES diagnostic_attempts (id),
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  position INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnostic_attempt_questions_position
  ON diagnostic_attempt_questions (attempt_id, position);

-- Uma resposta por questão por tentativa (seção 6 da ordem). is_correct e
-- recognition_is_correct são SEMPRE calculados pelo Worker no momento da
-- gravação — nunca aceitos do cliente (seção 8 da ordem).
CREATE TABLE IF NOT EXISTS diagnostic_responses (
  attempt_id TEXT NOT NULL REFERENCES diagnostic_attempts (id),
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  selected_option_id TEXT REFERENCES diagnostic_question_options (id),
  is_dont_know INTEGER NOT NULL DEFAULT 0,
  is_correct INTEGER,
  recognition_option_id TEXT REFERENCES diagnostic_question_recognition_options (id),
  recognition_is_correct INTEGER,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_responses_question ON diagnostic_responses (question_id);

-- Registro das camadas de ajuda abertas — chave primária composta evita
-- duplicidade indevida ao reabrir a mesma camada (idempotente por natureza
-- do schema, seção 9 da ordem).
CREATE TABLE IF NOT EXISTS diagnostic_help_opens (
  attempt_id TEXT NOT NULL REFERENCES diagnostic_attempts (id),
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id, layer)
);

-- Eventos essenciais da tentativa (seção 6/11 da ordem): reaproveita a
-- tabela audit_log já existente (Sprint 2), com novos tipos de evento —
-- evita duplicar a responsabilidade de auditoria em duas tabelas paralelas.
-- Ver worker/src/repositories/auditRepository.ts.
