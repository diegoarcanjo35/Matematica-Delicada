/* Validação do pipeline administrativo do Diagnóstico — Sprint 16 v1.2,
   seção 2 da ordem. Mesma convenção do resto do projeto
   (questionsValidation.ts/scheduleValidation.ts): enums/limites técnicos e
   validação de parâmetro vivem só aqui; rota/serviço só chamam isto.

   Deliberadamente MAIS simples que questionsValidation.ts (Banco de
   Questões): sem DNA, sem gabarito com explicação por alternativa, sem
   fingerprint/duplicidade, sem workflow de revisão — a ordem pede
   explicitamente "sem workflow editorial complexo" para este pipeline. */

import type { FieldValidationResult } from "./diagnosticValidation";

function ok<T>(value: T): FieldValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): FieldValidationResult<T> {
  return { ok: false, error };
}

export const DIAGNOSTIC_PROMPT_MAX_LENGTH = 2000;
export const DIAGNOSTIC_OPTION_TEXT_MAX_LENGTH = 300;
export const DIAGNOSTIC_HELP_CONTENT_MAX_LENGTH = 4000;
export const DIAGNOSTIC_OPTIONS_MIN = 2;
export const DIAGNOSTIC_OPTIONS_MAX = 6;

export function validateDiagnosticPrompt(value: unknown): FieldValidationResult<string> {
  if (typeof value !== "string") return fail("O enunciado é obrigatório.");
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail("O enunciado não pode ser vazio.");
  if (value.length > DIAGNOSTIC_PROMPT_MAX_LENGTH) return fail(`O enunciado não pode passar de ${DIAGNOSTIC_PROMPT_MAX_LENGTH} caracteres.`);
  return ok(value);
}

export interface DiagnosticOptionInput {
  text: string;
  isCorrect: boolean;
}

/** Valida um conjunto de alternativas de múltipla escolha — a mesma
 *  invariante ("entre MIN e MAX itens, exatamente um correto") vale tanto
 *  para as alternativas da questão quanto para as opções de reconhecimento
 *  (a única diferença entre as duas é permitir 0 itens — "sem pergunta de
 *  reconhecimento configurada", seção 41 da migration 0004). `allowEmpty`
 *  cobre exatamente essa diferença, sem duplicar a função. */
export function validateDiagnosticOptionSet(value: unknown, fieldLabel: string, allowEmpty: boolean): FieldValidationResult<DiagnosticOptionInput[]> {
  if (!Array.isArray(value)) return fail(`${fieldLabel} inválido.`);
  if (value.length === 0 && allowEmpty) return ok([]);
  if (value.length < DIAGNOSTIC_OPTIONS_MIN || value.length > DIAGNOSTIC_OPTIONS_MAX) {
    return fail(`${fieldLabel} precisa ter entre ${DIAGNOSTIC_OPTIONS_MIN} e ${DIAGNOSTIC_OPTIONS_MAX} itens.`);
  }

  const parsed: DiagnosticOptionInput[] = [];
  let correctCount = 0;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return fail(`${fieldLabel}: item inválido.`);
    const item = raw as Record<string, unknown>;
    const text = item.text;
    if (typeof text !== "string" || text.trim().length === 0) return fail(`${fieldLabel}: texto de uma opção não pode ser vazio.`);
    if (text.length > DIAGNOSTIC_OPTION_TEXT_MAX_LENGTH) return fail(`${fieldLabel}: texto de uma opção excede o tamanho máximo.`);
    const isCorrect = item.isCorrect;
    if (typeof isCorrect !== "boolean") return fail(`${fieldLabel}: indicação de correta inválida.`);
    if (isCorrect) correctCount++;
    parsed.push({ text, isCorrect });
  }
  if (correctCount !== 1) return fail(`${fieldLabel} precisa ter exatamente uma opção correta.`);
  return ok(parsed);
}

export interface DiagnosticHelpLayerInput {
  layer: 1 | 2 | 3 | 4;
  content: string;
}

/** Camadas de ajuda são OPCIONAIS (seção 2 da ordem: "sem workflow
 *  editorial complexo") — um mapa parcial (ou ausente) é aceito; cada
 *  camada informada precisa ser 1-4 e ter conteúdo não vazio. */
export function validateDiagnosticHelpLayers(value: unknown): FieldValidationResult<DiagnosticHelpLayerInput[]> {
  if (value === undefined || value === null) return ok([]);
  if (typeof value !== "object" || Array.isArray(value)) return fail("Camadas de ajuda inválidas.");

  const parsed: DiagnosticHelpLayerInput[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const layer = Number(key);
    if (!Number.isInteger(layer) || layer < 1 || layer > 4) return fail("Camada de ajuda inválida.");
    if (typeof raw !== "string" || raw.trim().length === 0) return fail(`Conteúdo da camada ${layer} não pode ser vazio.`);
    if (raw.length > DIAGNOSTIC_HELP_CONTENT_MAX_LENGTH) return fail(`Conteúdo da camada ${layer} excede o tamanho máximo.`);
    parsed.push({ layer: layer as 1 | 2 | 3 | 4, content: raw });
  }
  return ok(parsed);
}
