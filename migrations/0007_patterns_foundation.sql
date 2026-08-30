-- Sprint 6 v1.0 — fundação técnica da taxonomia de padrões recorrentes do
-- ENEM (Documento Mestre, seções 2, 5, 24, 36-40, 42-45). Aditiva e não
-- destrutiva: só CREATE TABLE/INDEX IF NOT EXISTS. Nenhuma alteração nas
-- tabelas das Sprints 1-5.
--
-- IMPORTANTE: assim como as migrations 0004/0006, esta migration só cria a
-- ESTRUTURA. O CONTEÚDO (os cinco padrões citados literalmente no Documento
-- Mestre) nunca é inserido por uma migration — o seed vive em
-- scripts/fixtures/patterns-fixtures.local.sql, aplicado manualmente e
-- apenas com --local (gate em runtime via
-- worker/src/env.ts:isLocalPatternFixturesAllowed, independente disso).
--
-- Esta sprint entrega a FUNDAÇÃO técnica da taxonomia, não a lista oficial
-- definitiva nem as fórmulas dos três índices (seção 3 da ordem).

-- Definição de um padrão — revisável: `code` e `slug` são identificadores
-- estáveis e únicos, mas nunca dependem de posição/ordem física na tabela.
CREATE TABLE IF NOT EXISTS patterns (
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
  -- Concorrência otimista futura (mesmo padrão de schedule_activity_assignments.version) —
  -- não há endpoint editorial nesta sprint, mas o campo já existe para quando houver.
  version INTEGER NOT NULL DEFAULT 1,
  is_local_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_local_fixture IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patterns_code ON patterns (code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patterns_slug ON patterns (slug);
CREATE INDEX IF NOT EXISTS idx_patterns_editorial_status ON patterns (editorial_status);

-- Estruturas multivaloradas (pistas, palavras/expressões, elementos visuais,
-- estratégias alternativas, conteúdos necessários, pré-requisitos,
-- erros/pegadinhas, tags) — uma única tabela de atributos com enum fechado
-- de tipo, em vez de 8 tabelas-filhas quase idênticas (cada uma seria só
-- pattern_id + position + texto). Decisão documentada em
-- docs/PADROES_ENEM.md, seção "Estruturas multivaloradas".
CREATE TABLE IF NOT EXISTS pattern_attributes (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  attribute_type TEXT NOT NULL CHECK (attribute_type IN (
    'frequent_clue',            -- pista frequente
    'recurring_phrase',         -- palavra/expressão recorrente
    'recurring_visual_element', -- elemento visual recorrente
    'alternative_strategy',     -- estratégia alternativa
    'required_content',         -- conteúdo matemático necessário
    'prerequisite_content',     -- pré-requisito
    'common_mistake',           -- erro/pegadinha frequente
    'tag'                       -- tag
  )),
  position INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pattern_attributes_lookup
  ON pattern_attributes (pattern_id, attribute_type, position);

-- Relação dirigida entre padrões — impede auto-relação (CHECK) e duplicidade
-- da mesma relação exata (UNIQUE). Duas relações de tipos diferentes entre
-- o mesmo par (ex.: A `related` B e B `prerequisite` A) são permitidas.
CREATE TABLE IF NOT EXISTS pattern_relations (
  id TEXT PRIMARY KEY,
  from_pattern_id TEXT NOT NULL REFERENCES patterns (id),
  to_pattern_id TEXT NOT NULL REFERENCES patterns (id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('related', 'prerequisite', 'often_confused_with')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (from_pattern_id != to_pattern_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_relations_unique
  ON pattern_relations (from_pattern_id, to_pattern_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_pattern_relations_to ON pattern_relations (to_pattern_id);

-- Progresso do aluno por padrão — PK composta garante uma única linha por
-- aluno+padrão (nunca duas). Os três índices aceitam NULL explicitamente:
-- a fórmula está pendente (seção 3 da ordem), então NUNCA calculamos um
-- valor fictício — NULL significa "ainda sem evidências suficientes",
-- nunca é convertido em zero em nenhuma camada.
CREATE TABLE IF NOT EXISTS student_pattern_progress (
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

CREATE INDEX IF NOT EXISTS idx_student_pattern_progress_user ON student_pattern_progress (user_id);
