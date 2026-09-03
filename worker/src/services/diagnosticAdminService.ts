/* Serviço administrativo do Diagnóstico — Sprint 16 v1.2, seção 2 da
   ordem. Autorização SEMPRE nesta ordem, em toda função exportada: 1)
   sessão válida (a rota já garante — worker/src/routes/admin.ts); 2) papel
   `admin` (requireAdminRole, reaproveitado de adminService.ts — nenhum
   segundo mecanismo de RBAC). `adminId` só é usado para checar o papel e
   registrar o ATOR na auditoria, nunca como fonte de verdade sobre
   permissão do alvo (mesmo contrato de adminService.ts).

   Contrato de mutação — CREATE: `mutationId` (UUID do cliente) é usado
   DIRETAMENTE como `diagnostic_questions.id` (nunca um id interno gerado à
   parte). Uma segunda chamada com o MESMO mutationId colide na PRIMARY
   KEY — o catch abaixo relê a linha e decide entre sucesso idempotente
   (conteúdo já reflete exatamente o que esta chamada pediria) e conflito
   real (mesmo mutationId reaproveitado para um conteúdo diferente). DELETE:
   idempotente por natureza (nunca há conteúdo que possa divergir num
   DELETE) — `meta.changes` decide "removida agora" vs "já não existia". */

import { requireAdminRole } from "./adminService";
import {
  buildDeleteHelpLayersStatement,
  buildDeleteOptionsStatement,
  buildDeleteQuestionStatement,
  buildDeleteRecognitionOptionsStatement,
  buildInsertHelpLayerStatement,
  buildInsertOptionStatement,
  buildInsertQuestionStatement,
  buildInsertRecognitionOptionStatement,
  findRealQuestion,
  listHelpLayerContentForQuestions,
  listRealQuestionsOrdered,
  nextRealPosition,
  type AdminDiagnosticQuestionRow,
} from "../repositories/diagnosticAdminRepository";
import { listOptionsForQuestions, listRecognitionOptionsForQuestions } from "../repositories/diagnosticRepository";
import { buildAuditEventStatement } from "../repositories/auditRepository";
import { isValidMutationId } from "../lib/questionsValidation";
import { validateDiagnosticHelpLayers, validateDiagnosticOptionSet, validateDiagnosticPrompt } from "../lib/diagnosticAdminValidation";

export interface DiagnosticAdminOptionDto {
  text: string;
  isCorrect: boolean;
}

export interface DiagnosticAdminQuestionDto {
  id: string;
  prompt: string;
  position: number;
  options: DiagnosticAdminOptionDto[];
  recognitionOptions: DiagnosticAdminOptionDto[];
  helpLayers: Partial<Record<1 | 2 | 3 | 4, string>>;
  createdAt: string;
  updatedAt: string;
}

function toDto(
  question: AdminDiagnosticQuestionRow,
  options: Array<{ question_id: string; text: string; is_correct: number }>,
  recognitionOptions: Array<{ question_id: string; text: string; is_correct: number }>,
  helpLayers: Array<{ question_id: string; layer: number; content: string }>
): DiagnosticAdminQuestionDto {
  const helpMap: Partial<Record<1 | 2 | 3 | 4, string>> = {};
  for (const row of helpLayers) {
    if (row.question_id === question.id) (helpMap as Record<number, string>)[row.layer] = row.content;
  }
  return {
    id: question.id,
    prompt: question.prompt,
    position: question.position,
    options: options.filter((o) => o.question_id === question.id).map((o) => ({ text: o.text, isCorrect: o.is_correct === 1 })),
    recognitionOptions: recognitionOptions.filter((o) => o.question_id === question.id).map((o) => ({ text: o.text, isCorrect: o.is_correct === 1 })),
    helpLayers: helpMap,
    createdAt: question.created_at,
    updatedAt: question.updated_at,
  };
}

export type ListResult = { ok: true; questions: DiagnosticAdminQuestionDto[] } | { ok: false; forbidden: true };

export async function listQuestions(db: D1Database, adminId: string): Promise<ListResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };

  const questions = await listRealQuestionsOrdered(db);
  const ids = questions.map((q) => q.id);
  const [options, recognitionOptions, helpLayers] = await Promise.all([
    listOptionsForQuestions(db, ids),
    listRecognitionOptionsForQuestions(db, ids),
    listHelpLayerContentForQuestions(db, ids),
  ]);

  const dtos = questions.map((question) => toDto(question, options, recognitionOptions, helpLayers));
  return { ok: true, questions: dtos };
}

export interface CreateQuestionInput {
  prompt: unknown;
  options: unknown;
  recognitionOptions: unknown;
  helpLayers: unknown;
  mutationId: unknown;
}

export type CreateQuestionResult =
  | { ok: true; changed: boolean; questionId: string }
  | { ok: false; forbidden: true }
  | { ok: false; conflict: true }
  | { ok: false; fieldErrors: Record<string, string> };

function optionSetsEqual(a: DiagnosticAdminOptionDto[], b: { text: string; isCorrect: boolean }[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item.text === b[index].text && item.isCorrect === b[index].isCorrect);
}

export async function createQuestion(db: D1Database, adminId: string, input: CreateQuestionInput): Promise<CreateQuestionResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };

  if (!isValidMutationId(input.mutationId)) return { ok: false, fieldErrors: { mutationId: "mutationId é obrigatório e precisa ser um UUID válido." } };
  const mutationId = input.mutationId;

  const promptResult = validateDiagnosticPrompt(input.prompt);
  if (!promptResult.ok) return { ok: false, fieldErrors: { prompt: promptResult.error! } };

  const optionsResult = validateDiagnosticOptionSet(input.options, "Alternativas", false);
  if (!optionsResult.ok) return { ok: false, fieldErrors: { options: optionsResult.error! } };

  const recognitionResult = validateDiagnosticOptionSet(input.recognitionOptions, "Opções de reconhecimento", true);
  if (!recognitionResult.ok) return { ok: false, fieldErrors: { recognitionOptions: recognitionResult.error! } };

  const helpLayersResult = validateDiagnosticHelpLayers(input.helpLayers);
  if (!helpLayersResult.ok) return { ok: false, fieldErrors: { helpLayers: helpLayersResult.error! } };

  const prompt = promptResult.value!;
  const options = optionsResult.value!;
  const recognitionOptions = recognitionResult.value!;
  const helpLayers = helpLayersResult.value!;

  const position = await nextRealPosition(db);
  const statements = [
    buildInsertQuestionStatement(db, { id: mutationId, prompt, position }),
    ...options.map((option, index) =>
      buildInsertOptionStatement(db, { id: `${mutationId}-opt-${index}`, questionId: mutationId, position: index, text: option.text, isCorrect: option.isCorrect })
    ),
    ...recognitionOptions.map((option, index) =>
      buildInsertRecognitionOptionStatement(db, { id: `${mutationId}-rec-${index}`, questionId: mutationId, position: index, text: option.text, isCorrect: option.isCorrect })
    ),
    ...helpLayers.map((layer) => buildInsertHelpLayerStatement(db, { questionId: mutationId, layer: layer.layer, content: layer.content })),
    buildAuditEventStatement(db, { id: mutationId, eventType: "admin_diagnostic_question_created", userId: adminId, metadata: { questionId: mutationId } }),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    // Retry idempotente (mesmo mutationId): a questão já existe. Conteúdo
    // idêntico -> sucesso sem nova escrita; conteúdo diferente -> conflito
    // controlado (mutationId nunca pode significar duas coisas).
    const existing = await findRealQuestion(db, mutationId);
    if (!existing) throw error;
    const [existingOptions, existingRecognition] = await Promise.all([
      listOptionsForQuestions(db, [mutationId]),
      listRecognitionOptionsForQuestions(db, [mutationId]),
    ]);
    const sameCore = existing.prompt === prompt;
    const sameOptions = optionSetsEqual(
      existingOptions.map((o) => ({ text: o.text, isCorrect: o.is_correct === 1 })),
      options
    );
    const sameRecognition = optionSetsEqual(
      existingRecognition.map((o) => ({ text: o.text, isCorrect: o.is_correct === 1 })),
      recognitionOptions
    );
    if (sameCore && sameOptions && sameRecognition) return { ok: true, changed: false, questionId: mutationId };
    return { ok: false, conflict: true };
  }

  return { ok: true, changed: true, questionId: mutationId };
}

export type DeleteQuestionResult = { ok: true; changed: boolean } | { ok: false; forbidden: true } | { ok: false; notFound: true };

/** Remove uma questão REAL (nunca uma fixture — o próprio DELETE guardado
 *  garante isso, ver diagnosticAdminRepository.ts) e todo o conteúdo
 *  associado (opções, opções de reconhecimento, camadas de ajuda), no
 *  MESMO db.batch() — nunca uma questão "órfã" sem alternativas por causa
 *  de uma falha parcial. */
export async function deleteQuestion(db: D1Database, adminId: string, questionId: string): Promise<DeleteQuestionResult> {
  if (!(await requireAdminRole(db, adminId))) return { ok: false, forbidden: true };

  const existing = await findRealQuestion(db, questionId);
  if (!existing) return { ok: false, notFound: true };

  const eventId = crypto.randomUUID();
  const result = await db.batch([
    buildDeleteHelpLayersStatement(db, questionId),
    buildDeleteRecognitionOptionsStatement(db, questionId),
    buildDeleteOptionsStatement(db, questionId),
    buildDeleteQuestionStatement(db, questionId),
    buildAuditEventStatement(db, { id: eventId, eventType: "admin_diagnostic_question_deleted", userId: adminId, metadata: { questionId } }),
  ]);

  const questionDeleteResult = result[3];
  if (questionDeleteResult.meta.changes !== 1) return { ok: true, changed: false };
  return { ok: true, changed: true };
}
