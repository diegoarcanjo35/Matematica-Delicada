-- Sprint 7 v1.3 — invariante CORE+HISTÓRICO indivisível, imposto no BANCO,
-- nunca só checado em JS depois do commit.
--
-- Contexto (auditoria por inspeção direta do código v1.2): `db.batch()` é
-- UMA transação que já está COMMITADA quando o JavaScript volta a inspecionar
-- `meta.changes` de cada statement. Um statement condicionado
-- (`WHERE EXISTS(...) AND NOT EXISTS(...)`) que deveria inserir uma linha de
-- `question_history` mas silenciosamente afeta 0 linhas (sem lançar exceção)
-- não é mais pego a tempo por uma checagem em JS: o UPDATE central de
-- `questions` já foi persistido, sem o histórico correspondente — uma
-- inconsistência real e não recuperável, não só uma resposta HTTP ruim.
--
-- Mecanismo: SQLite `RAISE(ABORT, ...)` dentro de um trigger aborta o
-- statement corrente; como todo o lote de `db.batch()` roda dentro de UMA
-- transação (BEGIN...COMMIT), qualquer exceção lançada por QUALQUER
-- statement do lote (incluindo uma disparada por este trigger) já reverte a
-- transação INTEIRA antes de qualquer commit — garantia nativa do FakeD1
-- (backeado por node:sqlite real, mesmo motor SQL do D1) e do D1 real.
--
-- Ordem exigida no código que usa este trigger (worker/src/services/
-- questionService.ts): a linha de `question_history` (a "consequência")
-- precisa ser inserida ANTES do UPDATE em `questions` (a "causa") no MESMO
-- lote, guardada pela versão ATUAL (pré-mutação) da questão — não pela
-- versão resultante. Assim, quando o UPDATE central roda por último e de
-- fato muda `version`, o histórico correspondente já deveria existir
-- (inserido momentos antes, na mesma transação). Se não existir — o guard
-- condicional do INSERT de histórico falhou por algum motivo inesperado —
-- este trigger aborta a transação inteira antes que qualquer commit ocorra.
--
-- Aditiva e não destrutiva: só CREATE TRIGGER IF NOT EXISTS. Nenhuma
-- alteração em tabelas existentes. Escopo: só dispara quando `version`
-- REALMENTE muda (`WHEN NEW.version != OLD.version`) — nunca em um UPDATE
-- que não mexe em version, e nunca em INSERT (criação de questão nova, cujo
-- histórico inicial não tem o componente "NOT EXISTS de retry" que motiva
-- esta correção — ver docs/BANCO_QUESTOES.md, seção "Validação do lote").
CREATE TRIGGER IF NOT EXISTS trg_questions_require_history_after_update
AFTER UPDATE ON questions
FOR EACH ROW
WHEN NEW.version != OLD.version
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM question_history
      WHERE question_id = NEW.id AND version = NEW.version
    )
    THEN RAISE(ABORT, 'invariante violada: questions.version mudou sem question_history correspondente')
  END;
END;
