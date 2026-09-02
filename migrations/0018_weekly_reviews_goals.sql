-- Sprint 13 v1.0 — Relatório Semanal e Metas Realistas. Puramente aditiva
-- sobre o schema das Sprints 1-12 (0001-0017): só CREATE TABLE/INDEX/TRIGGER
-- IF NOT EXISTS, nenhum ALTER TABLE, nenhuma migration anterior é editada. A
-- Sprint 14 deve começar sua própria migration em `0019` — nunca reaproveitar
-- ou renumerar 0001-0018.
--
-- O RELATÓRIO semanal (seção 4.1 da ordem) permanece 100% DERIVADO EM
-- LEITURA sobre o schema já existente das Sprints 3-12 (question_attempts,
-- error_notebook_entries, error_review_events, daily_training_*,
-- simulation_block_*, schedule_activity_*) — nenhuma tabela nova de
-- relatório/snapshot é criada aqui (seção 6 da ordem: "criar somente
-- estruturas necessárias para metas; o relatório permanece derivado em
-- leitura"). Ver worker/src/repositories/weeklyReviewRepository.ts.
--
-- Só as METAS semanais (seção 4.3) precisam de estado persistido real —
-- três tabelas, mesma classe de mecanismo de atomicidade já comprovada em
-- migrations/0013 (Player), 0014 (Caderno de Erros), 0016 (Treino Diário) e
-- 0017 (Simulados em Blocos): núcleo com `version`/`last_mutation_id` +
-- evento append-only cujo `id` é o próprio `mutationId`, com um trigger que
-- aborta a transação inteira se a identidade não bater ANTES do commit.
--
-- ---------------------------------------------------------------------------
-- weekly_study_goals — uma linha por meta semanal EXPLICITAMENTE aplicada
-- (nunca uma prévia — seção 4.3 da ordem: "o preview nunca escreve"; só
-- POST /api/weekly-goals/apply grava esta tabela). `week_start` é a data
-- CIVIL (YYYY-MM-DD) da SEGUNDA-FEIRA da semana-alvo, no fuso do aluno NO
-- MOMENTO DO APPLY — mesma convenção de `daily_training_lists.training_date`/
-- `simulation_blocks.block_date` (migrations/0016, 0017). `timezone` é
-- carimbado pelo mesmo motivo (uma meta já aplicada nunca muda de "semana"
-- retroativamente se o aluno trocar de fuso depois).
--
-- `available_days` é uma coluna ADICIONAL além do mínimo da seção 6.1 da
-- ordem (a ordem permite campos além do mínimo listado, mesmo precedente já
-- usado por `simulation_block_items.estimated_minutes`/daily_training_items
-- em sprints anteriores): um carimbo (snapshot JSON, mesmo formato de
-- `student_profiles.available_days`) dos dias disponíveis usados como base
-- da meta no momento do apply — pela MESMA razão técnica de `timezone`: o
-- progresso factual da meta (seção 4.4, "dias com atividade versus dias
-- disponíveis") precisa de um denominador ESTÁVEL, que nunca muda
-- retroativamente se o aluno editar a disponibilidade do onboarding depois
-- de aplicar a meta.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weekly_study_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  week_start TEXT NOT NULL,
  timezone TEXT NOT NULL,
  available_days TEXT NOT NULL DEFAULT '[]',
  target_minutes INTEGER NOT NULL CHECK (target_minutes > 0),
  target_questions INTEGER NOT NULL CHECK (target_questions > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  -- Concorrência otimista — mesma convenção do resto do projeto desde a
  -- Sprint 5.
  version INTEGER NOT NULL DEFAULT 1,
  -- Identidade da MUTAÇÃO ESPECÍFICA que gravou esta linha por último —
  -- mesmo papel de simulation_blocks.last_mutation_id (migrations/0017).
  last_mutation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  abandoned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_weekly_study_goals_user ON weekly_study_goals (user_id);
CREATE INDEX IF NOT EXISTS idx_weekly_study_goals_user_week ON weekly_study_goals (user_id, week_start);

-- Seção 6.1 da ordem: "garantir no banco no máximo uma meta active por
-- usuário e week_start" — mesmo padrão comprovado em migrations/0005, 0013,
-- 0014, 0016 e 0017: um índice único PARCIAL, restrito a status = 'active'.
-- Diferente de simulation_blocks (no máximo UM bloco ativo por aluno, sem
-- escopo de data), aqui é por (user_id, week_start) — um aluno PODE ter
-- metas ativas para semanas DIFERENTES ao mesmo tempo (ex.: corrigir a meta
-- da semana corrente e já aplicar a da próxima), nunca duas para a MESMA
-- semana.
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_study_goals_one_active_per_week
  ON weekly_study_goals (user_id, week_start)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- weekly_goal_patterns — os padrões prioritários (no máximo 3) de UMA meta,
-- persistidos atomicamente junto com ela no apply/patch (seção 9 da ordem).
-- Sem coluna `id` própria de negócio nenhuma referência externa aponta para
-- esta tabela; `id` existe só pela mesma convenção TEXT PRIMARY KEY do resto
-- do schema, nunca usado como identidade de mutação (isso é
-- `weekly_goal_events.id`).
--
-- "No máximo 3 padrões, sem padrão duplicado, sem posição duplicada" (seção
-- 6.2/8 da ordem) é garantido NO BANCO, não só no algoritmo de seleção em
-- JS: `priority_position` é restrito a 1..3 pelo próprio CHECK, e o índice
-- único (goal_id, priority_position) permite no máximo 3 linhas por meta
-- por construção (só existem 3 valores válidos de posição) — nenhuma
-- coluna de contagem redundante é necessária.
-- ---------------------------------------------------------------------------
-- `mutation_id` (PO v1.1, correção A): identidade da MUTAÇÃO DA META
-- (`weekly_study_goals.last_mutation_id`/`weekly_goal_events.id` da mesma
-- operação) que inseriu ESTA linha de padrão pela última vez — mesmo papel
-- de `last_mutation_id` no núcleo, mas aqui carimbado no INSERT (nunca
-- atualizado depois: uma troca de coleção sempre passa por
-- DELETE-tudo+INSERT-do-zero no mesmo lote, nunca um UPDATE de linha
-- existente). Ver o trigger consolidado abaixo, que usa esta coluna para
-- provar, por identidade e ANTES do commit, que "o DELETE da coleção
-- antiga realmente aconteceu" e "o INSERT da coleção nova tem exatamente a
-- contagem esperada" são sempre o MESMO fato — fecha a lacuna descrita na
-- nota abaixo (nenhuma migration anterior tocada; só uma coluna nova em
-- 0018, que ainda não foi aplicada em lugar nenhum).
CREATE TABLE IF NOT EXISTS weekly_goal_patterns (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES weekly_study_goals (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  pattern_id TEXT NOT NULL REFERENCES patterns (id),
  priority_position INTEGER NOT NULL CHECK (priority_position BETWEEN 1 AND 3),
  mutation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_weekly_goal_patterns_goal ON weekly_goal_patterns (goal_id);
CREATE INDEX IF NOT EXISTS idx_weekly_goal_patterns_user ON weekly_goal_patterns (user_id);

-- Padrão único dentro da mesma meta (seção 6.2 da ordem: "impedir padrão
-- duplicado").
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_goal_patterns_goal_pattern
  ON weekly_goal_patterns (goal_id, pattern_id);

-- Posição única dentro da mesma meta (seção 6.2 da ordem: "impedir posição
-- duplicada") — combinado com o CHECK acima (1..3), limita esta meta a no
-- máximo 3 linhas por construção do próprio índice, sem precisar de uma
-- coluna de contagem redundante em weekly_study_goals.
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_goal_patterns_goal_position
  ON weekly_goal_patterns (goal_id, priority_position);

-- ---------------------------------------------------------------------------
-- weekly_goal_events — histórico append-only de mutações REAIS da meta
-- (seção 6.3/10 da ordem). Nunca armazena texto livre, resposta ou conteúdo
-- sensível — só os fatos técnicos mínimos (tipo, meta, semana, versão,
-- quando). `from_status`/`to_status` são nulos para `goal_created` (não há
-- transição de status nesse evento — a meta nasce direto em `active`) e
-- preenchidos para `goal_updated` (PATCH que não muda status:
-- from_status = to_status = 'active', registrado mesmo assim para manter o
-- histórico de mutações de conteúdo), `goal_completed` e `goal_abandoned`.
-- `goal_version` é a versão RESULTANTE da meta depois desta mutação (mesmo
-- papel de `schedule_activity_events`, mas carimbado explicitamente em vez
-- de exigir um JOIN para descobrir).
-- ---------------------------------------------------------------------------
-- `patterns_expected_count` (PO v1.1, correção A): NULO quando ESTA mutação
-- específica não tocou weekly_goal_patterns (PATCH sem `patternIds`,
-- goal_completed, goal_abandoned — a coleção de padrões fica exatamente
-- como estava, por construção nenhuma verificação é feita aqui); 0..3
-- quando tocou (apply sempre grava a coleção do zero; PATCH com
-- `patternIds` sempre remove tudo e reinsere do zero) — a contagem REAL de
-- padrões que devem existir, tomados como pertencentes a ESTA mutação
-- especificamente, depois dela. Ver o trigger abaixo.
CREATE TABLE IF NOT EXISTS weekly_goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES weekly_study_goals (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'goal_created', 'goal_updated', 'goal_completed', 'goal_abandoned'
  )),
  from_status TEXT CHECK (from_status IN ('active', 'completed', 'abandoned')),
  to_status TEXT CHECK (to_status IN ('active', 'completed', 'abandoned')),
  goal_version INTEGER NOT NULL,
  patterns_expected_count INTEGER CHECK (patterns_expected_count IS NULL OR patterns_expected_count BETWEEN 0 AND 3),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_weekly_goal_events_goal ON weekly_goal_events (goal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_weekly_goal_events_user ON weekly_goal_events (user_id);

-- ---------------------------------------------------------------------------
-- Atomicidade real (seção 6.4/9 da ordem) — mesma classe de mecanismo
-- "marcador incondicional + RAISE(ABORT) por identidade, ANTES do commit"
-- já comprovada nas migrations 0009-0014, 0016 e 0017. Cada INSERT em
-- weekly_goal_events é INCONDICIONAL (nunca um `WHERE EXISTS` que pode
-- silenciosamente afetar zero linhas) e usa como seu próprio `id` o MESMO
-- `mutationId` gravado em weekly_study_goals.last_mutation_id pelo
-- INSERT/UPDATE pareado, no MESMO lote — a própria linha de evento já SERVE
-- como marcador. `goal_version` do evento precisa bater exatamente com a
-- versão REAL da meta depois da escrita (prova, ANTES do commit, que "a meta
-- mudou de versão" e "o evento registra a versão certa" são sempre o MESMO
-- fato, nunca dois fatos que um bug poderia separar).
--
-- PO v1.1 (correção A) — o parágrafo acima (v1.0) argumentava que "0 a 3
-- padrões são igualmente válidos... sem precisar de uma contagem redundante
-- checada pelo trigger" e concluía que db.batch() bastava. Isso é VERDADEIRO
-- só para o caso "statement lança exceção" (INSERT que viola
-- goal_id+pattern_id/goal_id+priority_position — aí o próprio db.batch()
-- reverte tudo). NÃO cobre o caso adversarial pedido pela PO nesta rodada:
-- um DELETE/UPDATE GUARDADO por WHERE (como
-- `buildDeleteGoalPatternsStatement`, `WHERE goal_id = ? AND user_id = ?`)
-- pode afetar ZERO linhas SEM lançar nenhum erro (mesmo comportamento do
-- SQLite/D1 real para qualquer UPDATE/DELETE cujo WHERE não bate) — nesse
-- caso o núcleo (`weekly_study_goals`) e o evento
-- (`weekly_goal_events`) mudam de versão normalmente, o bloco acima passa
-- (ele só olha para o núcleo/evento, nunca para weekly_goal_patterns), e a
-- coleção de padrões fica com uma mistura silenciosa de linhas antigas e
-- novas — provado adversarialmente em
-- worker/testing/weeklyReviewAtomicity.test.ts ("Correção A v1.1"). O bloco
-- abaixo fecha essa lacuna: quando uma mutação de fato TOCA a coleção de
-- padrões (`patterns_expected_count IS NOT NULL` — apply sempre toca; PATCH
-- só quando `patternIds` é informado), exige por IDENTIDADE (nunca por
-- contagem isolada, que dois mutations concorrentes poderiam confundir
-- entre si) que (a) nenhuma linha de `weekly_goal_patterns` deste `goal_id`
-- sobreviva com um `mutation_id` DIFERENTE do evento atual (prova que o
-- DELETE da coleção antiga realmente aconteceu — nunca ficou "pela
-- metade") e (b) a contagem de linhas carimbadas com ESTE `mutation_id`
-- bate exatamente com o valor declarado pela aplicação. Adaptação ao
-- domínio, nunca cópia mecânica de 0009-0012: lá a validação é por
-- `version_stamp` da versão editorial; aqui é por `mutation_id` da mutação
-- da meta, porque weekly_goal_patterns não tem (nem precisa de) um
-- `version` próprio — cada substituição é sempre "apaga tudo, insere do
-- zero", nunca uma edição parcial de linha existente.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_weekly_goal_events_require_identity
AFTER INSERT ON weekly_goal_events
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM weekly_study_goals
      WHERE id = NEW.goal_id AND user_id = NEW.user_id AND last_mutation_id = NEW.id AND version = NEW.goal_version
    )
    THEN RAISE(ABORT, 'invariante violada: evento de meta sem weekly_study_goals.last_mutation_id/version correspondente (por identidade)')
  END;

  SELECT CASE
    WHEN NEW.patterns_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM weekly_goal_patterns WHERE goal_id = NEW.goal_id AND mutation_id != NEW.id)
       OR (SELECT COUNT(*) FROM weekly_goal_patterns WHERE goal_id = NEW.goal_id AND mutation_id = NEW.id) != NEW.patterns_expected_count
     )
    THEN RAISE(ABORT, 'invariante violada: weekly_goal_patterns não reflete por identidade a mutação desta atualização (coleção órfã de mutação anterior ou contagem divergente da esperada)')
  END;
END;
