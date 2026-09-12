/* Casamento questão ↔ gabarito + dedupe — Sprint 22, seções 11/12/13/14 da
   ordem.

   Regra inegociável (seção 5/11): `correctAlternative` só pode vir do
   Map<número, letra> produzido por `pdfEnemAnswerKey.ts` — este módulo
   NUNCA deriva uma resposta de outra forma. Uma questão sem entrada no
   gabarito nunca fica "ready": vira `needsReview`, `canApply=false`. */

import type { RawQuestionCandidate } from "./pdfEnemSegmenter";
import type { AnswerLetter } from "./pdfEnemAnswerKey";
import type { ExamIdentity } from "./pdfEnemExamIdentity";
import { computeQuestionFingerprint } from "./fingerprint";

export type PdfEnemQuestionStatus = "ready" | "needs_review";
export type PdfEnemDuplicateStatus = "none" | "exact";

export interface PdfEnemPreviewQuestion {
  tempId: string;
  originalNumber: number;
  pageStart: number;
  pageEnd: number;
  statement: string;
  alternatives: Array<{ letter: "A" | "B" | "C" | "D" | "E"; text: string }>;
  correctAlternative: AnswerLetter | null;
  warnings: string[];
  status: PdfEnemQuestionStatus;
  duplicateStatus: PdfEnemDuplicateStatus;
  visualReviewRequired: boolean;
  /** Seção 14 da ordem — SEMPRE `null` nesta extração inicial; o parser
   *  nunca classifica padrão. Selecionado pelo editor na revisão, e
   *  revalidado (published, existente) no apply. */
  patternPrincipalId: string | null;
  canApply: boolean;
  code: string;
  fingerprint: string;
}

export interface BuildPreviewQuestionsResult {
  items: PdfEnemPreviewQuestion[];
  globalWarnings: string[];
}

function slugifyIdentityPart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

const QUESTION_CODE_MAX_LENGTH = 40;

/** Código determinístico, nunca digitado — deriva 1:1 da identidade do
 *  exame + número original (seção 12: o vínculo de identidade FAZ parte
 *  da chave; a mesma numeração em cadernos diferentes nunca colide).
 *
 *  O SUFIXO numérico (`-NNN`) é o único elemento que de fato distingue
 *  duas questões da MESMA prova — ele é reservado e escrito primeiro;
 *  só o PREFIXO descritivo (identidade do exame) é truncado para caber no
 *  limite de `questions.code` (bug real encontrado nesta sprint: truncar
 *  a string JÁ montada, sufixo incluso, podia cortar o "-NNN" inteiro e
 *  fazer duas questões diferentes colidirem no mesmo código — corrigido
 *  reservando o sufixo ANTES de calcular quanto sobra para o prefixo). */
export function buildPdfEnemQuestionCode(identity: ExamIdentity, originalNumber: number): string {
  const suffix = `-${String(originalNumber).padStart(3, "0")}`;
  const prefixBudget = QUESTION_CODE_MAX_LENGTH - suffix.length;
  const prefix = ["ENEM", String(identity.year), slugifyIdentityPart(identity.application), slugifyIdentityPart(identity.booklet)].join("-").slice(0, prefixBudget);
  return `${prefix}${suffix}`;
}

export async function buildPreviewQuestions(
  examQuestions: RawQuestionCandidate[],
  answerKey: Map<number, AnswerLetter>,
  identity: ExamIdentity,
  existingCodes: Set<string>,
  existingFingerprints: Set<string>
): Promise<BuildPreviewQuestionsResult> {
  const globalWarnings: string[] = [];
  const seenFingerprintsInBatch = new Map<string, number>(); // fingerprint -> originalNumber da primeira ocorrência

  const answeredNumbers = new Set(answerKey.keys());
  const examNumbers = new Set(examQuestions.map((q) => q.originalNumber));
  for (const n of answeredNumbers) {
    if (!examNumbers.has(n)) globalWarnings.push(`Gabarito traz resposta para a questão ${n}, que não foi reconhecida na prova.`);
  }

  const items: PdfEnemPreviewQuestion[] = [];
  for (const q of examQuestions) {
    const warnings = [...q.warnings];
    const structuralOk =
      q.warnings.length === 0 &&
      q.alternatives.length === 5 &&
      q.statement.length > 0 &&
      new Set(q.alternatives.map((a) => a.letter)).size === 5;

    const correctAlternative = answerKey.get(q.originalNumber) ?? null;
    if (correctAlternative === null) warnings.push("Gabarito ausente para esta questão.");

    const code = buildPdfEnemQuestionCode(identity, q.originalNumber);
    const fingerprint = await computeQuestionFingerprint(
      q.statement,
      q.alternatives.map((a) => ({ letter: a.letter, text: a.text, isCorrect: false }))
    );

    let duplicateStatus: PdfEnemDuplicateStatus = "none";
    if (existingCodes.has(code) || existingFingerprints.has(fingerprint)) {
      duplicateStatus = "exact";
      warnings.push("Esta questão já existe no banco (código ou enunciado equivalente).");
    } else if (seenFingerprintsInBatch.has(fingerprint)) {
      duplicateStatus = "exact";
      warnings.push(`Enunciado equivalente à questão ${seenFingerprintsInBatch.get(fingerprint)} deste mesmo PDF.`);
    } else {
      seenFingerprintsInBatch.set(fingerprint, q.originalNumber);
    }

    const visualReviewRequired = q.hasVisualContentOnPages;
    if (visualReviewRequired) warnings.push("Possível elemento visual não extraído automaticamente.");

    const status: PdfEnemQuestionStatus = structuralOk && correctAlternative !== null && duplicateStatus === "none" && !visualReviewRequired ? "ready" : "needs_review";
    const canApply = status === "ready";

    items.push({
      // Determinístico (nunca aleatório) — o apply precisa correlacionar a
      // seleção do editor (por originalNumber) com uma RE-SEGMENTAÇÃO
      // independente dos mesmos bytes; um tempId aleatório mudaria a cada
      // parse e nunca bateria entre preview e apply.
      tempId: String(q.originalNumber),
      originalNumber: q.originalNumber,
      pageStart: q.pageStart,
      pageEnd: q.pageEnd,
      statement: q.statement,
      alternatives: q.alternatives,
      correctAlternative,
      warnings,
      status,
      duplicateStatus,
      visualReviewRequired,
      patternPrincipalId: null,
      canApply,
      code,
      fingerprint,
    });
  }

  items.sort((a, b) => a.originalNumber - b.originalNumber);
  return { items, globalWarnings };
}
