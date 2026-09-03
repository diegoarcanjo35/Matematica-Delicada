/* Repositório administrativo do Diagnóstico — Sprint 16 v1.2, seção 2 da
   ordem. Separado de diagnosticRepository.ts (leitura/escrita do FLUXO DO
   ALUNO — tentativas, respostas, ajuda) por desenho: mesma disciplina de
   isolamento entre "leitura pedagógica" e "gestão administrativa" pedida
   explicitamente para Padrões (seção 4 da ordem), aplicada aqui também por
   consistência — nenhuma função deste arquivo é alcançável pelo fluxo do
   aluno, e nenhuma função de diagnosticRepository.ts escreve conteúdo.

   Toda escrita aqui SEMPRE grava `is_local_fixture = 0` — este pipeline
   nunca cria fixture (seção 2 da ordem: "sem fixture"). O `id` da questão é
   SEMPRE o `mutationId` da requisição (nunca gerado internamente): é essa
   identidade, e não o conteúdo, que torna um retry de CREATE genuinamente
   idempotente — uma segunda tentativa com o MESMO mutationId colide na
   PRIMARY KEY de diagnostic_questions, nunca cria uma segunda questão (ver
   worker/src/services/diagnosticAdminService.ts). */

import { listRealQuestionsOrdered, type DiagnosticQuestionRow } from "./diagnosticRepository";

/** Sprint 16 v1.3 — `listRealQuestionsOrdered` passou a viver em
 *  diagnosticRepository.ts (fonte de verdade única, também usada pelo
 *  fluxo do aluno via `createAttempt` fora do dev local com fixtures —
 *  ver diagnosticService.ts) e é só reexportada aqui, para não duplicar a
 *  consulta em dois arquivos. */
export { listRealQuestionsOrdered };

export type AdminDiagnosticQuestionRow = DiagnosticQuestionRow;

export async function findRealQuestion(db: D1Database, id: string): Promise<AdminDiagnosticQuestionRow | null> {
  const row = await db
    .prepare("SELECT * FROM diagnostic_questions WHERE id = ? AND is_local_fixture = 0")
    .bind(id)
    .first<AdminDiagnosticQuestionRow>();
  return row ?? null;
}

/** Próxima posição de apresentação — sempre ao final do conjunto REAL
 *  atual (fixtures locais, se existirem no mesmo banco de desenvolvimento,
 *  nunca contam para este cálculo). */
export async function nextRealPosition(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(position), -1) as maxPosition FROM diagnostic_questions WHERE is_local_fixture = 0")
    .first<{ maxPosition: number }>();
  return (row?.maxPosition ?? -1) + 1;
}

export function buildInsertQuestionStatement(db: D1Database, params: { id: string; prompt: string; position: number }): D1PreparedStatement {
  return db
    .prepare("INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES (?, ?, ?, 0)")
    .bind(params.id, params.prompt, params.position);
}

export function buildInsertOptionStatement(
  db: D1Database,
  params: { id: string; questionId: string; position: number; text: string; isCorrect: boolean }
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO diagnostic_question_options (id, question_id, position, text, is_correct) VALUES (?, ?, ?, ?, ?)")
    .bind(params.id, params.questionId, params.position, params.text, params.isCorrect ? 1 : 0);
}

export function buildInsertRecognitionOptionStatement(
  db: D1Database,
  params: { id: string; questionId: string; position: number; text: string; isCorrect: boolean }
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO diagnostic_question_recognition_options (id, question_id, position, text, is_correct) VALUES (?, ?, ?, ?, ?)")
    .bind(params.id, params.questionId, params.position, params.text, params.isCorrect ? 1 : 0);
}

export interface HelpLayerContentRow {
  question_id: string;
  layer: number;
  content: string;
}

/** Conteúdo completo (não só question_id/layer) das camadas de ajuda de um
 *  conjunto de questões — diagnosticRepository.ts:listHelpLayersForQuestions
 *  devolve só a existência (question_id/layer), suficiente para o fluxo do
 *  aluno (que já sabe o que quer abrir); a listagem administrativa precisa
 *  do TEXTO para exibir/editar. */
export async function listHelpLayerContentForQuestions(db: D1Database, questionIds: string[]): Promise<HelpLayerContentRow[]> {
  if (questionIds.length === 0) return [];
  const placeholders = questionIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT question_id, layer, content FROM diagnostic_question_help_layers WHERE question_id IN (${placeholders}) ORDER BY question_id, layer ASC`)
    .bind(...questionIds)
    .all<HelpLayerContentRow>();
  return result.results ?? [];
}

export function buildInsertHelpLayerStatement(
  db: D1Database,
  params: { questionId: string; layer: number; content: string }
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO diagnostic_question_help_layers (question_id, layer, content) VALUES (?, ?, ?)")
    .bind(params.questionId, params.layer, params.content);
}

/** DELETE guardado por `is_local_fixture = 0` na PRÓPRIA condição — nunca
 *  remove uma fixture local através deste pipeline, mesmo por engano de
 *  id. `meta.changes === 0` distingue "já não existia"/"era fixture" de
 *  "removida agora" para o serviço decidir idempotência. */
export function buildDeleteQuestionStatement(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("DELETE FROM diagnostic_questions WHERE id = ? AND is_local_fixture = 0").bind(id);
}

export function buildDeleteOptionsStatement(db: D1Database, questionId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM diagnostic_question_options WHERE question_id = ?").bind(questionId);
}

export function buildDeleteRecognitionOptionsStatement(db: D1Database, questionId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM diagnostic_question_recognition_options WHERE question_id = ?").bind(questionId);
}

export function buildDeleteHelpLayersStatement(db: D1Database, questionId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM diagnostic_question_help_layers WHERE question_id = ?").bind(questionId);
}
