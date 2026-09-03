-- CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR.
--
-- Sprint 14 v1.0 — contas e vínculos técnicos fictícios, exclusivamente para
-- validar o Painel do Professor (migration 0019). NÃO são contas reais, NÃO
-- representam professores/alunos reais, e não podem ser interpretadas como
-- dado real por nenhuma tela (todo `name` começa com "[PROVISÓRIO]").
--
-- Diferente de diagnostic-fixtures.local.sql/schedule-fixtures.local.sql
-- (que só semeiam CONTEÚDO, nunca usuários), este arquivo também cria
-- USUÁRIOS fixos, porque a ordem da Sprint 14 (seção 9) proíbe
-- explicitamente qualquer API — pública OU de desenvolvimento — que crie um
-- vínculo professor-aluno. Sem uma rota para criar o vínculo em cima de
-- contas dinâmicas (como o resto do projeto faz via /api/auth/signup), o
-- único jeito de ter um vínculo determinístico para testar é semear TANTO os
-- usuários quanto o vínculo, os dois com IDs fixos, aqui.
--
-- A senha de todas as contas de fixture é a mesma, só para uso local:
--   fixture-teacher-local-only-1
-- (hash PBKDF2-HMAC-SHA256/100000 pré-computado com
-- worker/src/lib/crypto.ts:hashPassword, salt fixo zerado — não é segredo
-- real, nunca usado fora do ambiente local). Login via API normal
-- (POST /api/auth/login) com o e-mail e esta senha.
-- ATUALIZADO: regenerado a 100000 iterações (de 600000) porque
-- worker/src/lib/crypto.ts:verifyPassword agora rejeita qualquer hash acima
-- de PBKDF2_MAX_SUPPORTED_ITERATIONS (teto real do runtime Workers em
-- produção) — mesma senha em texto puro, mesmo salt zerado.
--
-- Cenários cobertos (ordem seção 9):
--   professor A (fixture-teacher-a) -> aluno 1 (fixture-student-1): ativo
--   professor A (fixture-teacher-a) -> aluno 2 (fixture-student-2): ativo
--   professor B (fixture-teacher-b) -> aluno 3 (fixture-student-3): ativo
--   professor B (fixture-teacher-b) -> aluno 1 (fixture-student-1): INATIVO
--     (prova que um vínculo inativo nunca concede acesso, mesmo quando o
--     MESMO aluno tem um vínculo ativo com outro professor)
--   professor C (fixture-teacher-c): sem NENHUM vínculo — "professor sem alunos"
--   aluno 4 (fixture-student-4): sem NENHUM vínculo — "aluno sem professor"
--
-- Só é aplicado manualmente contra o D1 LOCAL:
--   npm run db:seed:teacher:local
-- (usa wrangler.local.jsonc + --local — nunca o D1 remoto, ordem seção 27).
-- INSERT OR IGNORE em tudo: reaplicar contra um D1 local que já tem estas
-- linhas nunca duplica nem falha.
--
-- Espelhado (mesmos IDs, formato TypeScript) em
-- worker/testing/teacherFixtures.ts, usado pelos testes unitários com o
-- FakeD1Database — os dois arquivos precisam ser mantidos em sincronia
-- manualmente ao alterar o conteúdo de fixture.

INSERT OR IGNORE INTO users (id, name, email, email_normalized, password_hash, status, email_confirmed_at)
VALUES
  ('fixture-teacher-a', '[PROVISÓRIO] Professora A (Fixture Técnica)', 'fixture-professora-a@local.teste', 'fixture-professora-a@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-teacher-b', '[PROVISÓRIO] Professor B (Fixture Técnica)', 'fixture-professor-b@local.teste', 'fixture-professor-b@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-teacher-c', '[PROVISÓRIO] Professora C, sem alunos (Fixture Técnica)', 'fixture-professora-c@local.teste', 'fixture-professora-c@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-student-1', '[PROVISÓRIO] Aluno 1 (Fixture Técnica)', 'fixture-aluno-1@local.teste', 'fixture-aluno-1@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-student-2', '[PROVISÓRIO] Aluna 2 (Fixture Técnica)', 'fixture-aluno-2@local.teste', 'fixture-aluno-2@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-student-3', '[PROVISÓRIO] Aluno 3 (Fixture Técnica)', 'fixture-aluno-3@local.teste', 'fixture-aluno-3@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now')),
  ('fixture-student-4', '[PROVISÓRIO] Aluna 4, sem professor (Fixture Técnica)', 'fixture-aluno-4@local.teste', 'fixture-aluno-4@local.teste', 'pbkdf2-sha256-v1$100000$AAAAAAAAAAAAAAAAAAAAAA$KzzMpMWIP6f6INq1Qp01P4z6sCUF30RhcW35Sn6Z9EY', 'active', datetime('now'));

-- Perfil mínimo (só a série, para exercitar "série, se já disponível" na
-- lista/detalhe) para o aluno 1 apenas — os demais ficam sem perfil, para
-- também exercitar o estado "série indisponível".
INSERT OR IGNORE INTO student_profiles (user_id, current_grade, status)
VALUES ('fixture-student-1', '3º ano do Ensino Médio', 'not_started');

-- RBAC (migrations/0008): garante que a linha de 'teacher' existe em
-- `roles` (idempotente — mesmo padrão de worker/src/routes/dev.ts) antes de
-- concedê-la às três contas de professor.
INSERT OR IGNORE INTO roles (id, name) VALUES ('role-teacher', 'teacher');

INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by)
VALUES
  ('fixture-user-role-teacher-a', 'fixture-teacher-a', 'role-teacher', NULL),
  ('fixture-user-role-teacher-b', 'fixture-teacher-b', 'role-teacher', NULL),
  ('fixture-user-role-teacher-c', 'fixture-teacher-c', 'role-teacher', NULL);

-- Vínculos (migrations/0019) — ver cenários no cabeçalho deste arquivo.
INSERT OR IGNORE INTO teacher_student_access (id, teacher_id, student_id, status, created_at, updated_at)
VALUES
  ('fixture-bond-a-1', 'fixture-teacher-a', 'fixture-student-1', 'active', datetime('now'), datetime('now')),
  ('fixture-bond-a-2', 'fixture-teacher-a', 'fixture-student-2', 'active', datetime('now'), datetime('now')),
  ('fixture-bond-b-3', 'fixture-teacher-b', 'fixture-student-3', 'active', datetime('now'), datetime('now')),
  ('fixture-bond-b-1-inactive', 'fixture-teacher-b', 'fixture-student-1', 'inactive', datetime('now'), datetime('now'));
