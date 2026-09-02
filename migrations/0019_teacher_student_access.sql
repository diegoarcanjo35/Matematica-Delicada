-- Sprint 14 v1.0 — vínculo autorizado professor↔aluno (ordem seção 7).
-- Aditiva e não destrutiva: só CREATE TABLE/INDEX IF NOT EXISTS. Nenhuma
-- alteração nas tabelas das Sprints 1-13 (0001-0018).
--
-- Reutiliza o RBAC já existente (roles/user_roles, migration 0008): o valor
-- 'teacher' já fazia parte do CHECK de roles.name desde a Sprint 7, apenas
-- nunca tinha sido usado até agora — esta migration NÃO cria um segundo
-- sistema de papéis nem altera roles/user_roles. A autorização de professor
-- combina três fatores (ordem seção 6): sessão válida + user_roles.name =
-- 'teacher' + linha ATIVA nesta tabela para o par (professor, aluno).
--
-- Esta tabela é o mecanismo REAL de vínculo (não é conteúdo de fixture só
-- para teste, ao contrário de diagnostic_questions/schedule_activities/
-- patterns/questions): por isso não tem coluna is_local_fixture nem gate de
-- runtime em env.ts. O caráter "só local" desta sprint está inteiramente em
-- COMO as linhas de demonstração são inseridas (só por
-- scripts/fixtures/teacher-fixtures.local.sql, aplicado manualmente contra o
-- D1 local — nunca por nenhum endpoint HTTP, nunca automaticamente por GET,
-- nunca contra D1 remoto — ordem seção 9/27) e em elas usarem nomes/e-mails
-- claramente marcados como fixture técnica. A administração real de vínculos
-- (criar/desfazer via UI) fica para uma sprint futura (ordem seção 9/26).
--
-- Não copia nenhum dado pessoal do aluno para a relação (só os dois IDs) e
-- não guarda nenhum snapshot pedagógico (nenhuma métrica/contagem é
-- persistida aqui — tudo é lido em tempo real dos serviços já existentes).
--
-- Histórico é preservado por INATIVAÇÃO (status <- 'inactive'), nunca por
-- DELETE: o índice único (teacher_id, student_id) abaixo já impede um
-- segundo vínculo duplicado para o mesmo par, então uma futura gestão real
-- de vínculos só precisa fazer UPDATE de status na mesma linha, nunca
-- inserir uma segunda.

CREATE TABLE IF NOT EXISTS teacher_student_access (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES users (id),
  student_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (teacher_id != student_id)
);

-- Impede vínculo duplicado do mesmo professor com o mesmo aluno (unicidade
-- do PAR, independentemente de status — reativar um vínculo é um UPDATE
-- nesta mesma linha, nunca um novo INSERT).
CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_student_access_pair
  ON teacher_student_access (teacher_id, student_id);

-- Índices por professor e por aluno (seção 7 da ordem), já incluindo
-- `status` para que a checagem de autorização (professor + aluno + ativo) e
-- a listagem de alunos vinculados de um professor sejam sempre buscas
-- diretas por índice, nunca uma varredura completa da tabela.
CREATE INDEX IF NOT EXISTS idx_teacher_student_access_teacher
  ON teacher_student_access (teacher_id, status);
CREATE INDEX IF NOT EXISTS idx_teacher_student_access_student
  ON teacher_student_access (student_id, status);
