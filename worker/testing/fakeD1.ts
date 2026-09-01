import { DatabaseSync } from "node:sqlite";

/* Sprint 2 v1.3 — seam de teste para provar atomicidade real no D1.
   Este projeto não tem miniflare/@cloudflare/vitest-pool-workers instalado,
   então não há como rodar um D1 local dentro do Vitest. Em vez de mockar
   .run()/.batch() com contagem de chamadas (o que provaria só que as
   funções foram chamadas, não que o banco fica consistente), este fake
   embute um SQLite real (node:sqlite, nativo do Node — sem dependência
   nova) e implementa db.batch() como uma transação BEGIN/COMMIT/ROLLBACK
   verdadeira, incluindo rollback completo quando qualquer statement falha —
   o mesmo comportamento documentado da API D1 real
   (https://developers.cloudflare.com/d1/worker-api/d1-database/).

   Vive inteiramente fora de worker/src/ (não é varrido por
   `tsc -p worker/tsconfig.json`, que restringe `types` a
   @cloudflare/workers-types e não conhece node:sqlite) e nunca é importado
   por código de produção — não entra no bundle do Worker. Nenhum
   comportamento de falha foi adicionado ao código de produção: a injeção de
   falha (failNextMatching) só existe aqui. */

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  email_confirmed_at TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  user_agent TEXT
);

CREATE TABLE email_confirmation_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE student_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  current_grade TEXT,
  enem_year INTEGER,
  goal_type TEXT,
  goal_value INTEGER,
  current_correct_estimate INTEGER,
  available_days TEXT,
  daily_minutes INTEGER,
  difficulties TEXT,
  time_preference TEXT,
  accessibility_needs TEXT,
  diagnostic_choice TEXT,
  current_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'not_started',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE diagnostic_questions (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE diagnostic_question_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE diagnostic_question_recognition_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE diagnostic_question_help_layers (
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  content TEXT NOT NULL,
  PRIMARY KEY (question_id, layer)
);

CREATE TABLE diagnostic_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'abandoned')),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE diagnostic_attempt_questions (
  attempt_id TEXT NOT NULL REFERENCES diagnostic_attempts (id),
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  position INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE diagnostic_responses (
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

CREATE TABLE diagnostic_help_opens (
  attempt_id TEXT NOT NULL REFERENCES diagnostic_attempts (id),
  question_id TEXT NOT NULL REFERENCES diagnostic_questions (id),
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id, layer)
);

-- Sprint 4 v1.2 (migration 0005) — no máximo uma tentativa in_progress por
-- usuário, garantido no banco.
CREATE UNIQUE INDEX idx_diagnostic_attempts_one_active_per_user
  ON diagnostic_attempts (user_id)
  WHERE status = 'in_progress';

-- Sprint 5 v1.0 (migration 0006) — motor do cronograma adaptativo.
CREATE TABLE schedule_activities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (
    'diagnostico', 'reconhecimento', 'estudo_de_padrao', 'conteudo_de_base',
    'aula_video', 'treino_de_questoes', 'correcao_de_erro', 'revisao_espacada',
    'lista_do_professor', 'simulado', 'live', 'leitura_de_resumo'
  )),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
  completion_criteria TEXT NOT NULL,
  explanation TEXT NOT NULL,
  completion_mode TEXT NOT NULL CHECK (completion_mode IN ('manual', 'automatic', 'external_evidence')),
  origin TEXT NOT NULL CHECK (origin IN ('system', 'teacher', 'diagnostic', 'review')),
  resource_ref TEXT,
  dismissible INTEGER NOT NULL DEFAULT 1 CHECK (dismissible IN (0, 1)),
  is_local_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_local_fixture IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_activity_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  activity_id TEXT NOT NULL REFERENCES schedule_activities (id),
  planned_date TEXT,
  position INTEGER,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'overdue', 'rescheduled', 'dismissed', 'blocked')),
  started_at TEXT,
  completed_at TEXT,
  dismissed_at TEXT,
  blocked_at TEXT,
  rescheduled_at TEXT,
  last_transition_reason TEXT,
  rescheduled_from_id TEXT REFERENCES schedule_activity_assignments (id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_schedule_assignments_user_date_position
  ON schedule_activity_assignments (user_id, planned_date, position)
  WHERE planned_date IS NOT NULL;

CREATE TABLE schedule_activity_events (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES schedule_activity_assignments (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_plan_previews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  payload TEXT NOT NULL,
  unplaceable_activity_ids TEXT NOT NULL DEFAULT '[]',
  input_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  applied_at TEXT
);

-- Sprint 6 v1.0 (migration 0007) — fundação da taxonomia de padrões ENEM.
-- Espelho manual do DDL de migrations/0007_patterns_foundation.sql; os dois
-- precisam ser mantidos em sincronia (worker/testing/migration0007.test.ts
-- executa o SQL REAL da migration, então uma divergência de constraint é
-- pega lá).
CREATE TABLE patterns (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  recognition_phrase TEXT NOT NULL,
  description TEXT NOT NULL,
  main_strategy TEXT NOT NULL,
  introductory_example TEXT NOT NULL,
  strategic_summary TEXT NOT NULL,
  editorial_status TEXT NOT NULL DEFAULT 'draft' CHECK (editorial_status IN (
    'draft', 'in_review', 'changes_requested', 'approved', 'published', 'archived'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  is_local_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_local_fixture IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_patterns_code ON patterns (code);
CREATE UNIQUE INDEX idx_patterns_slug ON patterns (slug);
CREATE INDEX idx_patterns_editorial_status ON patterns (editorial_status);

CREATE TABLE pattern_attributes (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  attribute_type TEXT NOT NULL CHECK (attribute_type IN (
    'frequent_clue',
    'recurring_phrase',
    'recurring_visual_element',
    'alternative_strategy',
    'required_content',
    'prerequisite_content',
    'common_mistake',
    'tag'
  )),
  position INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pattern_attributes_lookup
  ON pattern_attributes (pattern_id, attribute_type, position);

CREATE TABLE pattern_relations (
  id TEXT PRIMARY KEY,
  from_pattern_id TEXT NOT NULL REFERENCES patterns (id),
  to_pattern_id TEXT NOT NULL REFERENCES patterns (id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('related', 'prerequisite', 'often_confused_with')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_pattern_id != to_pattern_id)
);

CREATE UNIQUE INDEX idx_pattern_relations_unique
  ON pattern_relations (from_pattern_id, to_pattern_id, relation_type);
CREATE INDEX idx_pattern_relations_to ON pattern_relations (to_pattern_id);

CREATE TABLE student_pattern_progress (
  user_id TEXT NOT NULL REFERENCES users (id),
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  last_practiced_at TEXT,
  next_review_at TEXT,
  raw_evidence_count INTEGER NOT NULL DEFAULT 0,
  recognition_index REAL,
  resolution_index REAL,
  mastery_index REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, pattern_id)
);

CREATE INDEX idx_student_pattern_progress_user ON student_pattern_progress (user_id);

-- Sprint 7 v1.0 (migration 0008) — Banco de Questões e Importação Editorial.
-- Espelho manual do DDL de migrations/0008_question_bank_editorial.sql; os
-- dois precisam ser mantidos em sincronia.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (name IN ('student', 'teacher', 'editor', 'admin', 'support', 'commercial')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_roles_name ON roles (name);

CREATE TABLE user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by TEXT REFERENCES users (id)
);
CREATE UNIQUE INDEX idx_user_roles_unique ON user_roles (user_id, role_id);
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

CREATE TABLE questions (
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Sprint 7 v1.6 (migration 0012) - identidade da mutacao que fez esta questao avancar de versao pela ultima vez.
  last_mutation_id TEXT
);
CREATE UNIQUE INDEX idx_questions_code ON questions (code);
CREATE INDEX idx_questions_fingerprint ON questions (fingerprint);
CREATE INDEX idx_questions_editorial_status ON questions (editorial_status);
CREATE INDEX idx_questions_autor ON questions (autor_id);

CREATE TABLE question_alternatives (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  letter TEXT NOT NULL CHECK (letter IN ('A', 'B', 'C', 'D', 'E')),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  is_correct INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0, 1)),
  distractor_explanation TEXT,
  position INTEGER NOT NULL,
  -- Sprint 7 v1.4 (migration 0010) - carimbo da versao de questions que
  -- esta linha corresponde; ver nota extensa em migrations/0010_editorial_bidirectional_invariants.sql.
  version_stamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_question_alternatives_letter ON question_alternatives (question_id, letter);
CREATE INDEX idx_question_alternatives_question ON question_alternatives (question_id);

CREATE TABLE question_images (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  asset_ref TEXT NOT NULL,
  alt_text TEXT NOT NULL DEFAULT '',
  caption TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  titular_direitos TEXT,
  base_licenca TEXT,
  version_stamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_question_images_question ON question_images (question_id, position);

CREATE TABLE question_patterns (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  role TEXT NOT NULL CHECK (role IN ('principal', 'secundario')),
  version_stamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_question_patterns_unique ON question_patterns (question_id, pattern_id);
CREATE UNIQUE INDEX idx_question_patterns_one_principal ON question_patterns (question_id) WHERE role = 'principal';
CREATE INDEX idx_question_patterns_pattern ON question_patterns (pattern_id);

CREATE TABLE question_tags (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions (id),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  position INTEGER NOT NULL DEFAULT 0,
  version_stamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_question_tags_unique ON question_tags (question_id, content);
CREATE INDEX idx_question_tags_question ON question_tags (question_id, position);

CREATE TABLE question_dna (
  question_id TEXT PRIMARY KEY REFERENCES questions (id),
  pista TEXT NOT NULL DEFAULT '',
  estrategia TEXT NOT NULL DEFAULT '',
  pegadinha TEXT NOT NULL DEFAULT '',
  conteudo_apoio TEXT NOT NULL DEFAULT '',
  resolucao TEXT NOT NULL DEFAULT '',
  atalho TEXT,
  aprendizado_erro TEXT NOT NULL DEFAULT '',
  version_stamp INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE question_history (
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
CREATE INDEX idx_question_history_question ON question_history (question_id, created_at);

CREATE TABLE question_import_batches (
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
CREATE INDEX idx_question_import_batches_user ON question_import_batches (user_id);

CREATE TABLE question_import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES question_import_batches (id),
  row_number INTEGER NOT NULL,
  code TEXT NOT NULL,
  question_id TEXT REFERENCES questions (id)
);
CREATE INDEX idx_question_import_items_batch ON question_import_items (batch_id);

-- Sprint 7 v1.3 (migration 0009) — invariante CORE+HISTÓRICO indivisível.
-- Espelho manual do DDL de migrations/0009_editorial_batch_invariants.sql —
-- os dois precisam ser mantidos em sincronia.
CREATE TRIGGER trg_questions_require_history_after_update
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

-- Sprint 7 v1.4 (migration 0010) — invariante BIDIRECIONAL núcleo<->histórico<->coleções.
-- Espelho manual do DDL de migrations/0010_editorial_bidirectional_invariants.sql —
-- os dois precisam ser mantidos em sincronia.
CREATE TABLE editorial_mutation_checks (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  alternatives_expected_count INTEGER,
  dna_expected_count INTEGER,
  patterns_expected_count INTEGER,
  tags_expected_count INTEGER,
  images_expected_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- O trigger trg_editorial_mutation_checks_bidirectional de 0010 NAO e
-- criado aqui - equivalente a ele ter sido DROPado por 0012 no banco real
-- (substituido pelo trigger consolidado por identidade, mais abaixo).

-- Sprint 7 v1.5 (migration 0011) - recibo de mutacao por colecao, fecha o buraco de 0010 para colecoes esvaziadas.
-- Espelho manual do DDL de migrations/0011_editorial_collection_mutation_receipts.sql -
-- os dois precisam ser mantidos em sincronia.
CREATE TABLE question_collection_mutation_receipts (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_question_collection_mutation_receipts_lookup ON question_collection_mutation_receipts (question_id, collection, expected_version);

-- Sprint 7 v1.6 (migration 0012) - identidade da mutacao, substitui o trigger de recibos de 0011 por um baseado em identidade.
-- Espelho manual do DDL de migrations/0012_editorial_mutation_identity.sql -
-- os dois precisam ser mantidos em sincronia. O trigger de recibos de 0011
-- (trg_editorial_mutation_checks_collection_receipts) NAO e criado aqui -
-- equivalente a ele ter sido DROPado por 0012 no banco real.
CREATE TRIGGER trg_editorial_mutation_checks_by_identity
AFTER INSERT ON editorial_mutation_checks
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN (
      EXISTS (SELECT 1 FROM question_history WHERE id = NEW.id)
    ) != (
      EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
    )
    THEN RAISE(ABORT, 'invariante violada: núcleo e histórico divergem para ESTA mutação especificamente (por identidade)')
  END;

  SELECT CASE
    WHEN NEW.alternatives_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_alternatives')
       AND (
         NEW.alternatives_expected_count = 0
         OR (SELECT COUNT(*) FROM question_alternatives WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.alternatives_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_alternatives (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.dna_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_dna')
       AND (
         NEW.dna_expected_count = 0
         OR (SELECT COUNT(*) FROM question_dna WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.dna_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_dna (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.patterns_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_patterns')
       AND (
         NEW.patterns_expected_count = 0
         OR (SELECT COUNT(*) FROM question_patterns WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.patterns_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_patterns (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.tags_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_tags')
       AND (
         NEW.tags_expected_count = 0
         OR (SELECT COUNT(*) FROM question_tags WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.tags_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_tags (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.images_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_images')
       AND (
         NEW.images_expected_count = 0
         OR (SELECT COUNT(*) FROM question_images WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.images_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_images (por identidade) divergem para ESTA mutação')
  END;
END;

-- Sprint 8 v1.1 (migration 0013) - Player de Questao: tentativas, reconhecimento, ajuda, revisao e denuncia.
-- Espelho manual do DDL de migrations/0013_question_player_attempts.sql -
-- os dois precisam ser mantidos em sincronia.
CREATE TABLE question_attempts (
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
  highest_help_layer INTEGER NOT NULL DEFAULT 0 CHECK (highest_help_layer BETWEEN 0 AND 4),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT,
  completed_at TEXT,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_question_attempts_user ON question_attempts (user_id);
CREATE INDEX idx_question_attempts_question ON question_attempts (question_id);
CREATE UNIQUE INDEX idx_question_attempts_one_active ON question_attempts (user_id, question_id, mode) WHERE status = 'in_progress';

CREATE TABLE question_answer_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  previous_alternative TEXT CHECK (previous_alternative IN ('A', 'B', 'C', 'D', 'E')),
  new_alternative TEXT CHECK (new_alternative IN ('A', 'B', 'C', 'D', 'E')),
  event_type TEXT NOT NULL CHECK (event_type IN ('selected', 'changed', 'confirmed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_question_answer_events_attempt ON question_answer_events (attempt_id, created_at);

CREATE TABLE question_recognition_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  clue TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT '',
  attempt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_question_recognition_events_attempt ON question_recognition_events (attempt_id, created_at);

CREATE TABLE question_help_events (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES question_attempts (id),
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 4),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_question_help_events_unique ON question_help_events (attempt_id, layer);

CREATE TABLE question_review_bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  question_id TEXT NOT NULL REFERENCES questions (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_question_review_bookmarks_unique ON question_review_bookmarks (user_id, question_id);

CREATE TABLE question_problem_reports (
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
CREATE INDEX idx_question_problem_reports_user ON question_problem_reports (user_id);
CREATE INDEX idx_question_problem_reports_question ON question_problem_reports (question_id);

-- Sprint 8 v1.2 (migration 0013, editada in place) - atomicidade real das
-- mutações do Player: cada INSERT de evento e incondicional, usando como
-- id o mesmo mutationId gravado em question_attempts.last_mutation_id
-- pelo UPDATE pareado no mesmo lote; o trigger AFTER INSERT aborta a
-- transação inteira se essa identidade não bater. Espelho manual do DDL de
-- migrations/0013_question_player_attempts.sql - os dois precisam ser
-- mantidos em sincronia.
CREATE TRIGGER trg_question_answer_events_require_attempt_identity
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

CREATE TRIGGER trg_question_recognition_events_require_attempt_identity
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

CREATE TRIGGER trg_question_help_events_require_attempt_identity
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

-- Sprint 9 v1.0 (migration 0014) - Caderno de Erros e Revisao Espacada.
-- Espelho manual do DDL de migrations/0014_error_notebook_spaced_review.sql -
-- os dois precisam ser mantidos em sincronia.
CREATE TABLE error_notebook_entries (
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
  student_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_understanding' CHECK (status IN (
    'pending_understanding', 'scheduled', 'due', 'in_review', 'corrected', 'archived'
  )),
  error_count INTEGER NOT NULL DEFAULT 1 CHECK (error_count >= 1),
  review_stage INTEGER NOT NULL DEFAULT 0 CHECK (review_stage >= 0),
  distinct_review_questions_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (distinct_review_questions_succeeded >= 0),
  first_error_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_reviewed_at TEXT,
  next_review_at TEXT NOT NULL DEFAULT (datetime('now', '+1 day')),
  corrected_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_error_notebook_entries_user_question ON error_notebook_entries (user_id, original_question_id);
CREATE INDEX idx_error_notebook_entries_user ON error_notebook_entries (user_id);
CREATE INDEX idx_error_notebook_entries_status ON error_notebook_entries (status);
CREATE INDEX idx_error_notebook_entries_next_review ON error_notebook_entries (next_review_at);
CREATE INDEX idx_error_notebook_entries_pattern ON error_notebook_entries (primary_pattern_id);

CREATE TABLE error_review_events (
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
CREATE INDEX idx_error_review_events_entry ON error_review_events (entry_id, created_at);
CREATE UNIQUE INDEX idx_error_review_events_attempt_unique ON error_review_events (attempt_id);

ALTER TABLE question_attempts ADD COLUMN error_entry_id TEXT REFERENCES error_notebook_entries (id);
CREATE INDEX idx_question_attempts_error_entry ON question_attempts (error_entry_id);
CREATE UNIQUE INDEX idx_question_attempts_one_active_review_per_entry
  ON question_attempts (error_entry_id)
  WHERE error_entry_id IS NOT NULL AND status = 'in_progress';

-- Sprint 9 v1.1 - triggers reescritos para serem autossuficientes (nunca
-- dependem de ordem relativa entre si nem do trigger de 0013). Espelho
-- manual do DDL de migrations/0014 - os dois precisam ser mantidos em
-- sincronia.
CREATE TRIGGER trg_question_answer_events_require_error_entry
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
    THEN RAISE(ABORT, 'invariante violada (autossuficiente): confirmacao incorreta sem entrada/atualizacao obrigatoria do Caderno de Erros (por identidade propria, mesmo usuario e mesma questao)')
  END;
END;

CREATE TRIGGER trg_question_answer_events_require_review_completion
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
    THEN RAISE(ABORT, 'invariante violada (autossuficiente): confirmacao de revisao sem error_review_events/atualizacao de entrada correspondentes (por identidade propria, mesmo usuario e mesma questao)')
  END;
END;
`;

export interface FakeD1RunResult {
  success: true;
  meta: { changes: number; last_row_id: number };
  results: [];
}

class FakeD1PreparedStatement {
  constructor(
    private readonly fakeDb: FakeD1Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.fakeDb, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const stmt = this.fakeDb.sqlite.prepare(this.sql);
    const row = stmt.get(...(this.params as never[]));
    return (row as T | undefined) ?? null;
  }

  async run(): Promise<FakeD1RunResult> {
    this.fakeDb.maybeThrowForSql(this.sql);
    const stmt = this.fakeDb.sqlite.prepare(this.sql);
    const info = stmt.run(...(this.params as never[]));
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      results: [],
    };
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    const stmt = this.fakeDb.sqlite.prepare(this.sql);
    const rows = stmt.all(...(this.params as never[]));
    return { success: true, results: rows as T[], meta: { changes: 0 } };
  }
}

export class FakeD1Database {
  readonly sqlite: DatabaseSync;
  private failOnce: RegExp | null = null;
  // Serializa batches concorrentes na ordem de chegada — replica o
  // comportamento de single-writer do SQLite/D1 e evita que duas transações
  // "fake" se interleavem por causa dos microtasks do async/await do JS.
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(SCHEMA);
  }

  /** Injeta uma falha forçada na PRÓXIMA statement cujo SQL bater com o
   *  padrão — consumida uma única vez. Só existe neste fake de teste. */
  failNextMatching(pattern: RegExp): void {
    this.failOnce = pattern;
  }

  maybeThrowForSql(sql: string): void {
    if (this.failOnce && this.failOnce.test(sql)) {
      this.failOnce = null;
      throw new Error("forced_failure_for_test");
    }
  }

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, sql);
  }

  batch(statements: FakeD1PreparedStatement[]): Promise<FakeD1RunResult[]> {
    const run = async (): Promise<FakeD1RunResult[]> => {
      this.sqlite.exec("BEGIN");
      try {
        const results: FakeD1RunResult[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    };
    const next = this.writeLock.then(run, run);
    this.writeLock = next.catch(() => undefined);
    return next;
  }
}
