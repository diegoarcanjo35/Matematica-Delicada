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
import { placeVisualElement } from "./pdfEnemVisualPlacement";
import type { RawVisualElement } from "./pdfEnemVisualModel";
import { detectSuspiciousMathText } from "./pdfEnemOcrModel";

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
  /** Sprint 23 — agora computado por ASSOCIAÇÃO REAL (posição) a elementos
   *  visuais, nunca mais o sinal grosseiro "a página tem algum traço"
   *  (Sprint 22). `true` quando há, associado a ESTA questão, qualquer
   *  elemento vetorial real (não-decorativo — seção 6, sempre bloqueia,
   *  mesmo sem bitmap) OU qualquer imagem raster que não extraiu/não
   *  posicionou com confiança (seção 11/12 — nunca aplicável
   *  automaticamente sem prova positiva de que TODO elemento relevante foi
   *  tratado). */
  visualReviewRequired: boolean;
  /** Sprint 23 — `true` quando a questão tem pelo menos UMA imagem raster
   *  extraída com sucesso e posicionada (nunca `unknown`) associada a ela.
   *  Mesmo assim a questão NUNCA fica `ready` sozinha: a seção 11 exige
   *  confirmação explícita do editor (placement + alt text) antes do
   *  apply — ver `PdfApplySelectionEntry.visualConfirmations` em
   *  questionPdfImportService.ts. */
  hasPendingVisualConfirmation: boolean;
  /** Elementos visuais ASSOCIADOS a esta questão (raster extraído ou
   *  vetorial não-extraível) — metadado leve, NUNCA inclui `pngBytes` aqui
   *  (ver `toPersistableVisualElement`/resposta HTTP separada em
   *  questionPdfImportService.ts). */
  visualElements: RawVisualElement[];
  /** Seção 14 da ordem — SEMPRE `null` nesta extração inicial; o parser
   *  nunca classifica padrão. Selecionado pelo editor na revisão, e
   *  revalidado (published, existente) no apply. */
  patternPrincipalId: string | null;
  canApply: boolean;
  code: string;
  fingerprint: string;
  /** Sprint 24, seção 15 da ordem — `true` quando qualquer parte desta
   *  questão veio de OCR (cabeçalho, enunciado ou alternativa) — a UI
   *  mostra "Texto reconhecido por OCR" de forma neutra (nunca um score
   *  técnico). Confiança baixa em elemento crítico já vira `warnings`. */
  hasOcrText: boolean;
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

/** Sprint 23 — associa CADA elemento visual (já classificado como
 *  decorativo/não-decorativo pelo extrator) à questão dona, por posição
 *  (`placeVisualElement`), agrupando por `originalNumber`. Elementos
 *  `ignored_decorative` nunca entram no mapa (nunca associados a
 *  nenhuma questão — seção 5 da ordem). Roda UMA vez para o documento
 *  inteiro (nunca por questão), reaproveitado por preview e apply. */
function groupVisualElementsByOwner(allVisualElements: RawVisualElement[], examQuestions: RawQuestionCandidate[]): Map<number, RawVisualElement[]> {
  const byOwner = new Map<number, RawVisualElement[]>();
  for (const element of allVisualElements) {
    if (element.extractionStatus === "ignored_decorative") continue;
    const centerY = element.y + element.height / 2;
    const { ownerQuestionNumber, placement } = placeVisualElement(element.pageNumber, centerY, examQuestions);
    if (ownerQuestionNumber === null) continue;
    const placed: RawVisualElement = { ...element, placementCandidate: placement };
    const list = byOwner.get(ownerQuestionNumber) ?? [];
    list.push(placed);
    byOwner.set(ownerQuestionNumber, list);
  }
  return byOwner;
}

export async function buildPreviewQuestions(
  examQuestions: RawQuestionCandidate[],
  answerKey: Map<number, AnswerLetter>,
  identity: ExamIdentity,
  existingCodes: Set<string>,
  existingFingerprints: Set<string>,
  allVisualElements: RawVisualElement[] = [],
  /** Sprint 24, seção 14 da ordem — páginas onde OCR detectou conteúdo com
   *  formato de tabela (`pdfEnemOcrFusion.ts:looksTabularOcrRegion`). Toda
   *  questão que toca uma dessas páginas nunca fica `ready` automaticamente
   *  — tabela complexa exige revisão manual, nunca "achatada" em texto. */
  tabularPageNumbers: number[] = []
): Promise<BuildPreviewQuestionsResult> {
  const globalWarnings: string[] = [];
  const seenFingerprintsInBatch = new Map<string, number>(); // fingerprint -> originalNumber da primeira ocorrência

  const answeredNumbers = new Set(answerKey.keys());
  const examNumbers = new Set(examQuestions.map((q) => q.originalNumber));
  for (const n of answeredNumbers) {
    if (!examNumbers.has(n)) globalWarnings.push(`Gabarito traz resposta para a questão ${n}, que não foi reconhecida na prova.`);
  }

  const visualsByOwner = groupVisualElementsByOwner(allVisualElements, examQuestions);
  const tabularPages = new Set(tabularPageNumbers);

  const items: PdfEnemPreviewQuestion[] = [];
  for (const q of examQuestions) {
    const warnings = [...q.warnings];

    // Seção 14 da ordem — qualquer página tocada por esta questão com
    // formato de tabela reconhecido por OCR bloqueia `ready`/`canApply`
    // PERMANENTEMENTE (mesma força de `visualReviewRequired` abaixo) —
    // nunca "achatada" em texto e considerada pronta.
    let hasTabularContent = false;
    for (let page = q.pageStart; page <= q.pageEnd; page++) {
      if (tabularPages.has(page)) {
        warnings.push(`Conteúdo com formato de tabela reconhecido por OCR na página ${page} — revisão manual necessária, nunca aplicado automaticamente.`);
        hasTabularContent = true;
        break;
      }
    }

    // Seção 11 da ordem — só quando esta questão tem texto OCR: aponta
    // suspeita estrutural de símbolo matemático perdido (nunca corrige).
    // Mais fraco que `hasTabularContent`: força revisão (`status`), mas
    // nunca impede o apply em si — o editor pode confirmar o texto OCR
    // como está ou corrigi-lo via `reviewedStatement`/`reviewedAlternatives`.
    let hasMathSuspicion = false;
    if (q.hasOcrText) {
      const suspectTexts = [q.statement, ...q.alternatives.map((a) => a.text)];
      const suspects = new Set<string>();
      for (const text of suspectTexts) {
        for (const s of detectSuspiciousMathText(text)) suspects.add(s);
      }
      for (const s of suspects) warnings.push(`Possível símbolo matemático perdido pelo OCR: ${s}.`);
      hasMathSuspicion = suspects.size > 0;
    }
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

    // Sprint 23, seções 6/11/12 da ordem — associação real por posição
    // (nunca mais "a página tem algum traço"). Um elemento vetorial real
    // (não-decorativo) SEMPRE bloqueia, mesmo sem nenhum bitmap. Uma
    // imagem raster com falha de extração/posicionamento ambíguo também
    // bloqueia — só uma imagem raster `extracted` com placement conhecido
    // vira `hasPendingVisualConfirmation` (bloqueia `ready` automático,
    // mas pode ser confirmada pelo editor antes do apply — nunca bloqueada
    // permanentemente como o caso vetorial).
    const ownedVisuals = visualsByOwner.get(q.originalNumber) ?? [];
    const hasUnresolvedVisual = ownedVisuals.some(
      (v) => v.kind === "vector_diagram" || v.extractionStatus !== "extracted" || v.placementCandidate === "unknown"
    );
    const hasPendingVisualConfirmation = !hasUnresolvedVisual && ownedVisuals.some((v) => v.kind === "raster" && v.extractionStatus === "extracted");
    const visualReviewRequired = hasUnresolvedVisual;
    if (visualReviewRequired) {
      warnings.push("Conteúdo visual detectado (imagem ou diagrama vetorial) que não pôde ser extraído/posicionado com confiança — crie esta questão manualmente com a imagem anexada.");
    } else if (hasPendingVisualConfirmation) {
      warnings.push(`${ownedVisuals.length} imagem(ns) extraída(s) automaticamente — revise o posicionamento e preencha o texto alternativo antes de aplicar.`);
    }

    const status: PdfEnemQuestionStatus =
      structuralOk &&
      correctAlternative !== null &&
      duplicateStatus === "none" &&
      !visualReviewRequired &&
      !hasPendingVisualConfirmation &&
      !hasTabularContent &&
      !hasMathSuspicion
        ? "ready"
        : "needs_review";
    // `canApply` seção 11 — pendência de confirmação visual e suspeita de
    // símbolo matemático NUNCA impedem o apply em si (o editor confirma/
    // corrige no próprio fluxo, seção 8/10/16 da ordem); só
    // `visualReviewRequired` (vetor/raster não resolvido) e
    // `hasTabularContent` (seção 14 — tabela nunca aplicada automaticamente)
    // bloqueiam de fato. `status==='ready'` continua controlando o rótulo
    // exibido/o comportamento padrão de seleção — `canApply` é o que a
    // rota realmente usa para permitir a seleção.
    const canApply = structuralOk && correctAlternative !== null && duplicateStatus === "none" && !visualReviewRequired && !hasTabularContent;

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
      hasPendingVisualConfirmation,
      visualElements: ownedVisuals,
      patternPrincipalId: null,
      canApply,
      code,
      fingerprint,
      hasOcrText: q.hasOcrText,
    });
  }

  items.sort((a, b) => a.originalNumber - b.originalNumber);
  return { items, globalWarnings };
}
