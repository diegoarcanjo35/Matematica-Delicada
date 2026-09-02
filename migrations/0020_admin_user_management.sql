-- Sprint 15 v1.0/v1.1 — Administração Essencial + Bootstrap Administrativo
-- Seguro (ordem seção 7; adendo seções D/E). Aditiva e não destrutiva: só
-- CREATE TABLE/INDEX IF NOT EXISTS. Nenhuma alteração nas tabelas das
-- Sprints 1-14 (0001-0019).
--
-- DECISÃO DE SCHEMA (ordem seção 7 — "não criar tabela redundante só porque
-- a migration 0020 foi reservada"):
--
-- Administração Essencial (base v1.0) NÃO precisa de nenhuma tabela nova.
-- Tudo que as seções 9-13 da ordem pedem já é integralmente representável
-- com as estruturas existentes:
--   * usuários/papel/situação/data de criação -> users + roles + user_roles
--     (migration 0008, já usado por editor/teacher desde as Sprints 7/14);
--   * atribuir/remover papel -> INSERT/DELETE em user_roles, mesmo padrão de
--     worker/src/repositories/roleRepository.ts;
--   * vínculo professor<->aluno (criar/reativar/inativar) ->
--     teacher_student_access (migration 0019), cuja UNIQUE(teacher_id,
--     student_id) já força reativação por UPDATE em vez de novo INSERT
--     (documentado no cabeçalho de 0019 desde a Sprint 14);
--   * trilha de auditoria -> audit_log (migration 0001), que já aceita
--     qualquer event_type novo (TEXT sem CHECK) sem precisar de migration.
-- Nenhuma dessas operações precisa de uma coluna/tabela que hoje não exista.
--
-- Bootstrap Administrativo Seguro (adendo v1.1, seção E) PRECISA de uma
-- estrutura de estado persistente e específica: o sistema tem que conseguir
-- responder "o bootstrap já foi concluído?" de forma confiável e ATÔMICA
-- junto com as duas promoções a admin, sem inventar uma tabela genérica de
-- "system_settings" para um único uso. `admin_bootstrap_state` abaixo é
-- exatamente essa estrutura mínima, seguindo o modelo conceitual sugerido
-- pelo adendo (seção E: "chave única; estado de bootstrap; data da
-- conclusão; ator/processo responsável; versão").
--
-- Desenho do one-shot (documentado em detalhe em
-- worker/src/services/adminBootstrapService.ts e docs/ADMIN_ESSENCIAL.md):
-- esta tabela nasce SEMPRE VAZIA. "Bootstrap concluído" é representado pela
-- EXISTÊNCIA da única linha permitida (id = 'singleton', forçado pelo CHECK
-- abaixo — não uma coluna status mutável). A conclusão é um INSERT único,
-- nunca um UPDATE: a PRIMARY KEY faz o SQLite recusar (RAISE de violação de
-- UNIQUE, dentro da MESMA transação/db.batch() das duas promoções e dos
-- eventos de auditoria) qualquer segunda tentativa de concluir o bootstrap
-- — inclusive sob concorrência real (duas execuções simultâneas disputando
-- a mesma inserção). Isso evita o erro já documentado no projeto (Sprint 11)
-- de validar `meta.changes` em JavaScript DEPOIS de um db.batch() já
-- commitado: aqui a garantia real é uma constraint SQL que aborta a
-- transação inteira antes de qualquer commit parcial.
CREATE TABLE IF NOT EXISTS admin_bootstrap_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Identificador técnico do processo/mecanismo que concluiu o bootstrap —
  -- nunca uma identidade de sessão/ator alegada pelo cliente (não existe
  -- ator admin autenticado neste momento, por definição). Ver adendo seção H.
  completed_by TEXT NOT NULL,
  promoted_user_id_1 TEXT NOT NULL REFERENCES users (id),
  promoted_user_id_2 TEXT NOT NULL REFERENCES users (id),
  -- mutationId da requisição que concluiu o bootstrap — mesmo padrão de
  -- idempotência por IDENTIDADE já usado no resto do projeto (ver
  -- worker/src/services/weeklyReviewService.ts, dailyTrainingService.ts).
  mutation_id TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  CHECK (promoted_user_id_1 != promoted_user_id_2)
);

-- Proteção contra remoção do último administrador (ordem seção 12: "avaliar
-- proteção... se o modelo atual permitir identificar isso de forma segura,
-- implementar"). Documentado em detalhe em worker/src/repositories/
-- adminRepository.ts:countAdminRoleHolders e docs/ADMIN_ESSENCIAL.md: como
-- user_roles não tem coluna de status própria e users.status nunca varia na
-- prática hoje, "administrador ativo" é definido aqui como "existe uma
-- linha em user_roles apontando para o papel admin" — o único fato
-- observável e inequívoco disponível no modelo atual.
--
-- Implementado como TRIGGER (não como checagem em JavaScript antes do
-- DELETE) deliberadamente: é a única forma de tornar esta proteção IMUNE a
-- corrida real entre duas remoções concorrentes — o SQLite serializa
-- estatentos de escrita, então cada DELETE reavalia a contagem no momento
-- exato da SUA PRÓPRIA execução, depois de qualquer DELETE anterior já
-- commitado. Uma checagem "SELECT COUNT(...) antes do DELETE" em
-- JavaScript, ao contrário, teria uma janela TOCTOU explorável por duas
-- remoções simultâneas dos dois últimos admins (o mesmo problema geral
-- documentado nas lições de concorrência deste projeto desde a Sprint 11).
CREATE TRIGGER IF NOT EXISTS trg_user_roles_protect_last_admin
BEFORE DELETE ON user_roles
FOR EACH ROW
WHEN OLD.role_id = (SELECT id FROM roles WHERE name = 'admin')
 AND (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE role_id = OLD.role_id) <= 1
BEGIN
  SELECT RAISE(ABORT, 'invariante violada: não é possível remover o último administrador');
END;
