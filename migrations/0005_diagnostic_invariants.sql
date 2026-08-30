-- Sprint 4 v1.2 — invariante: no máximo uma diagnostic_attempts com
-- status = 'in_progress' por user_id, garantido no BANCO (não só na
-- aplicação). Aditiva: não reescreve nem toca a migration 0004 já publicada.
--
-- Sem isto, duas chamadas concorrentes de criação (ou de reinício) podiam
-- ambas ler "nenhuma tentativa ativa" e ambas inserir uma tentativa
-- in_progress, deixando o usuário com duas tentativas simultaneamente
-- "em andamento" — nenhuma tabela impedia isso estruturalmente.
--
-- Índice único parcial (suportado nativamente por SQLite/D1): a restrição só
-- se aplica a linhas com status = 'in_progress'; tentativas completed/
-- abandoned (qualquer quantidade, de qualquer usuário) nunca são afetadas —
-- histórico continua intacto e sem limite de quantidade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnostic_attempts_one_active_per_user
  ON diagnostic_attempts (user_id)
  WHERE status = 'in_progress';
