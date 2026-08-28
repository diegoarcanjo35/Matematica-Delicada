-- Sprint 2 v1.1, correção E — substitui a tabela de eventos (que exigia
-- COUNT-então-INSERT, com janela de corrida) por um contador de janela fixa,
-- incrementado atomicamente numa única instrução (INSERT ... ON CONFLICT ...
-- DO UPDATE ... RETURNING), eliminando o check-then-act.
-- Reprodutível e não destrutiva para o restante do schema.

DROP TABLE IF EXISTS rate_limit_events;

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  scope TEXT NOT NULL,
  identifier_hash TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, identifier_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window ON rate_limit_counters (window_start);
