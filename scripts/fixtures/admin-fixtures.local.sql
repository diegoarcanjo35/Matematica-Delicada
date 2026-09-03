-- CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR.
--
-- Sprint 15 v1.0 — conta administrativa técnica fictícia + um usuário comum
-- fictício, exclusivamente para validar a Área Administrativa (evidências
-- visuais/E2E). NÃO são contas reais (todo `name` começa com "[PROVISÓRIO]").
--
-- Reaproveita as contas de professor/aluno já semeadas por
-- scripts/fixtures/teacher-fixtures.local.sql (fixture-teacher-a,
-- fixture-student-1/2/3/4) para exercitar /admin/usuarios e /admin/vinculos
-- sem duplicar cenário — este arquivo deve ser aplicado DEPOIS daquele
-- (já é o caso em "npm run worker:preview").
--
-- A senha de todas as contas de fixture é a mesma, só para uso local:
--   fixture-teacher-local-only-1
-- (mesmo hash pré-computado de teacher-fixtures.local.sql — não é segredo
-- real, nunca usado fora do ambiente local). Login via API normal
-- (POST /api/auth/login).
-- ATUALIZADO: regenerado a 100000 iterações (de 600000), mesmo motivo e
-- mesma senha/salt documentados em teacher-fixtures.local.sql.
--
-- IMPORTANTE — este arquivo NÃO É o bootstrap administrativo do adendo
-- v1.1 (worker/src/services/adminBootstrapService.ts): é só uma fixture de
-- SQL bruto para o ambiente de desenvolvimento local, exatamente como
-- teacher-fixtures.local.sql já fazia para o papel `teacher` antes de
-- existir qualquer API/mecanismo real de concessão. O bootstrap real é
-- testado separadamente em worker/testing/adminBootstrap.test.ts, nunca
-- por este arquivo.
--
-- Só é aplicado manualmente contra o D1 LOCAL:
--   npm run db:seed:admin:local
-- (usa wrangler.local.jsonc + --local — nunca o D1 remoto, ordem seção 27).
-- INSERT OR IGNORE em tudo: reaplicar contra um D1 local que já tem estas
-- linhas nunca duplica nem falha.
--
-- Espelhado (mesmos IDs, formato TypeScript) em
-- worker/testing/adminFixtures.ts, usado pelos testes unitários com o
-- FakeD1Database.

INSERT OR IGNORE INTO users (id, name, email, email_normalized, password_hash, status, email_confirmed_at)
VALUES
  ('fixture-admin-1', '[PROVISÓRIO] Administradora 1 (Fixture Técnica)', 'fixture-admin-1@local.teste', 'fixture-admin-1@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-plain-user-1', '[PROVISÓRIO] Usuário Comum (Fixture Técnica)', 'fixture-plain-user-1@local.teste', 'fixture-plain-user-1@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now'));

-- RBAC (migrations/0008): garante que a linha de 'admin' existe em `roles`
-- (idempotente — mesmo padrão de worker/src/routes/dev.ts) antes de
-- concedê-la à conta administrativa fixa.
INSERT OR IGNORE INTO roles (id, name) VALUES ('role-admin', 'admin');

INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by)
VALUES ('fixture-user-role-admin-1', 'fixture-admin-1', 'role-admin', NULL);
