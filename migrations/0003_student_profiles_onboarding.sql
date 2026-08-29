-- Sprint 3 v1.0 — perfil/onboarding do aluno (Documento Mestre, seção 10.2).
-- Reprodutível e não destrutiva: só CREATE TABLE IF NOT EXISTS.
-- Nenhuma alteração destrutiva nas tabelas da Sprint 2.

CREATE TABLE IF NOT EXISTS student_profiles (
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
