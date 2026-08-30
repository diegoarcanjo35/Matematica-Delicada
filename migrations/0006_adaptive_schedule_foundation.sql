-- Sprint 5 v1.0 — motor técnico do cronograma adaptativo (Documento Mestre,
-- seção 11). Aditiva e não destrutiva: só CREATE TABLE/INDEX IF NOT EXISTS.
-- Nenhuma alteração nas tabelas das Sprints 1-4.
--
-- IMPORTANTE: assim como a migration 0004, esta migration só cria a
-- ESTRUTURA. O CONTEÚDO (atividades técnicas fictícias) nunca é inserido por
-- uma migration — o seed vive em scripts/fixtures/schedule-fixtures.local.sql,
-- aplicado manualmente e apenas com --local (gate em runtime via
-- worker/src/env.ts:isLocalScheduleFixturesAllowed, independente disso).
--
-- Esta sprint entrega o MOTOR de agenda, não a priorização pedagógica real —
-- nenhuma tabela/campo aqui carrega índice pedagógico, nota TRI ou
-- recomendação definitiva (seção 2 da ordem).

-- Definição de uma atividade (reutilizável — várias atribuições concretas
-- podem apontar para a mesma definição, ex.: "revisão espaçada" recorrente).
CREATE TABLE IF NOT EXISTS schedule_activities (
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
  -- Por que esta atividade foi recomendada/atribuída — mostrado ao aluno
  -- ("Por que esta atividade?"). Nesta sprint, só pode descrever
  -- disponibilidade configurada — nunca inferência pedagógica (seção 2).
  explanation TEXT NOT NULL,
  completion_mode TEXT NOT NULL CHECK (completion_mode IN ('manual', 'automatic', 'external_evidence')),
  origin TEXT NOT NULL CHECK (origin IN ('system', 'teacher', 'diagnostic', 'review')),
  -- Referência opcional a um recurso futuro (vídeo, questão, lista) — texto
  -- livre de propósito, sem FK: as entidades reais (banco de questões, vídeos)
  -- ainda não existem nesta sprint (seção 5 da ordem: "sem FK inventada para
  -- entidade inexistente").
  resource_ref TEXT,
  -- Se a atividade pode ser dispensada pelo aluno (seção 7: "dispensada
  -- somente quando a atividade permitir").
  dismissible INTEGER NOT NULL DEFAULT 1 CHECK (dismissible IN (0, 1)),
  is_local_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_local_fixture IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_activities_type ON schedule_activities (type);

-- Atribuição concreta de uma atividade a um aluno numa data planejada.
-- status é o estado PERSISTIDO — 'overdue' nunca é escrito automaticamente
-- aqui (ver worker/src/services/scheduleService.ts e docs/CRONOGRAMA.md,
-- seção "Estado persistido × estado efetivo"): uma atribuição not_started/
-- in_progress cuja planned_date já passou é tratada como efetivamente
-- atrasada só na LEITURA, nunca por uma escrita silenciosa em background.
-- 'overdue' continua um valor legal no CHECK (fidelidade ao Documento
-- Mestre, seção 11.3) para não fechar a porta a uma futura persistência
-- explícita, mas nenhum caminho de código desta sprint o escreve.
CREATE TABLE IF NOT EXISTS schedule_activity_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  activity_id TEXT NOT NULL REFERENCES schedule_activities (id),
  planned_date TEXT, -- data civil YYYY-MM-DD no fuso configurado do aluno; NULL = pendente/sem data (não coube na capacidade)
  position INTEGER, -- ordem no dia; NULL enquanto planned_date for NULL
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'overdue', 'rescheduled', 'dismissed', 'blocked')),
  started_at TEXT,
  completed_at TEXT,
  dismissed_at TEXT,
  blocked_at TEXT,
  rescheduled_at TEXT,
  -- Motivo técnico da última transição — nunca texto sensível/pedagógico
  -- (ex.: "manual_start", "manual_complete", "manual_dismiss",
  -- "rescheduled_to_next_available_day", "no_capacity_in_horizon").
  last_transition_reason TEXT,
  -- Vínculo com a atribuição anterior quando esta nasceu de um reagendamento
  -- — a anterior nunca é apagada, só marcada 'rescheduled' (histórico).
  rescheduled_from_id TEXT REFERENCES schedule_activity_assignments (id),
  -- Controle de concorrência otimista: toda mutação exige a versão atual e
  -- incrementa; versão desatualizada é conflito, nunca sobrescrita (seção 11).
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_assignments_user_date
  ON schedule_activity_assignments (user_id, planned_date);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_user_status
  ON schedule_activity_assignments (user_id, status);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_activity
  ON schedule_activity_assignments (activity_id);

-- Uma atividade concreta não pode ocupar duas posições no mesmo dia do mesmo
-- aluno (seção 5 da ordem) — único parcial, só quando a atribuição tem data
-- (pendentes sem data, com planned_date/position NULL, nunca colidem entre
-- si: SQLite trata NULL como distinto em índices únicos).
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_assignments_user_date_position
  ON schedule_activity_assignments (user_id, planned_date, position)
  WHERE planned_date IS NOT NULL;

-- Histórico imutável de transições — append-only, nunca UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS schedule_activity_events (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES schedule_activity_assignments (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_events_assignment ON schedule_activity_events (assignment_id);
CREATE INDEX IF NOT EXISTS idx_schedule_events_user ON schedule_activity_events (user_id);

-- Preferência mínima de fuso horário do aluno para o cálculo de "hoje"
-- (seção 9 da ordem) — tabela própria em vez de coluna em student_profiles
-- para não tocar o schema da Sprint 3.
CREATE TABLE IF NOT EXISTS schedule_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Prévias de plano (POST /api/schedule/plan/preview) — token opaco com prazo
-- de validade; aplicar (POST /api/schedule/plan/apply) exige que a prévia
-- pertença ao mesmo usuário, não tenha expirado, não tenha sido aplicada
-- ainda (idempotência: reaplicar a mesma prévia não duplica atribuições) e
-- que a disponibilidade/atividades pendentes usadas para gerá-la não tenham
-- mudado (input_snapshot) — seção 11 da ordem.
CREATE TABLE IF NOT EXISTS schedule_plan_previews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  payload TEXT NOT NULL, -- JSON: lista de { activityId, plannedDate, position, estimatedMinutes }
  unplaceable_activity_ids TEXT NOT NULL DEFAULT '[]', -- JSON: atividades que não couberam no horizonte
  input_snapshot TEXT NOT NULL, -- JSON: disponibilidade + IDs pendentes usados para gerar a prévia
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedule_plan_previews_user ON schedule_plan_previews (user_id);
