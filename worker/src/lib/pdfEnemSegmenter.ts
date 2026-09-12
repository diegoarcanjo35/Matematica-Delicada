/* Segmentação de questões a partir do texto extraído do PDF da prova —
   Sprint 22, seções 7/8/9/10 da ordem.

   Puro e determinístico: mesma entrada (`PdfPageText[]`) sempre produz a
   mesma saída — pré-requisito para o apply poder re-extrair o MESMO PDF
   reenviado e comparar contra o preview (mesmo padrão de
   `applyPackage`/ZIP, seção 22 da ordem).

   Reconhece SOMENTE estrutura suficientemente clara (seção 8): número da
   questão + enunciado não vazio + exatamente 5 alternativas A-E, nesta
   ordem, sem duplicata. Qualquer desvio (4 ou 6 alternativas, letra
   duplicada, número fora do intervalo aceito, número duplicado na mesma
   prova) gera `needsReview=true` com um aviso explícito — NUNCA "conserta"
   silenciosamente (nunca reordena, nunca descarta uma alternativa
   "sobrando", nunca inventa uma alternativa faltante).

   Limitação DELIBERADA e divulgada (relatório final desta sprint): este
   parser reconhece o layout de UMA coluna de leitura por vez (a ordem em
   que `pdfEnemExtractor.ts` já devolve as linhas, por Y decrescente dentro
   de cada página). ENEM real frequentemente usa duas colunas por página —
   quando as colunas se intercalam de forma ambígua (uma linha de uma
   coluna aparece na mesma faixa de Y de outra), o resultado é reportado
   como aviso agregado, nunca uma correção silenciosa; o editor sempre
   revê a prévia antes de aplicar. */

import type { PdfPageText } from "./pdfEnemExtractor";

export const MIN_QUESTION_NUMBER = 1;
export const MAX_QUESTION_NUMBER = 200;
const EXPECTED_LETTERS = ["A", "B", "C", "D", "E"] as const;

const QUESTION_HEADING_RE = /^QUEST(?:ÃO|AO)\s+0*([1-9]\d{0,2})\b/i;
const QUESTION_INLINE_RE = /^0*([1-9]\d{0,2})\s*[.\-–)]\s+(.*)$/;
const ALTERNATIVE_RE = /^([A-E])\s*[.\-–)]\s+(.*)$/;

export interface RawQuestionCandidate {
  originalNumber: number;
  pageStart: number;
  pageEnd: number;
  statement: string;
  alternatives: Array<{ letter: (typeof EXPECTED_LETTERS)[number]; text: string }>;
  hasVisualContentOnPages: boolean;
  warnings: string[];
  /** Seção 7 da ordem — preservado só para auditoria da prévia (nunca
   *  gravado em `questions`). */
  rawLineCount: number;
}

export interface SegmentationResult {
  questions: RawQuestionCandidate[];
  globalWarnings: string[];
}

interface FlatLine {
  pageNumber: number;
  text: string;
  hasVisualContent: boolean;
}

function flattenPages(pages: PdfPageText[]): FlatLine[] {
  const flat: FlatLine[] = [];
  for (const page of pages) {
    for (const line of page.lines) {
      flat.push({ pageNumber: page.pageNumber, text: line.text, hasVisualContent: page.hasVisualContent });
    }
  }
  return flat;
}

function detectQuestionStart(text: string): { number: number; remainder: string } | null {
  const heading = text.match(QUESTION_HEADING_RE);
  if (heading) return { number: Number(heading[1]), remainder: text.slice(heading[0].length).trim() };
  const inline = text.match(QUESTION_INLINE_RE);
  if (inline) return { number: Number(inline[1]), remainder: inline[2] };
  return null;
}

/** Divide o bloco de linhas de UMA questão (já isolado pelo chamador) em
 *  enunciado + alternativas A-E. Nunca reordena; a primeira ocorrência de
 *  cada letra marca o início daquela alternativa; texto após a última
 *  letra reconhecida pertence a ela até o fim do bloco. */
function splitStatementAndAlternatives(lines: string[]): {
  statement: string;
  alternatives: Array<{ letter: (typeof EXPECTED_LETTERS)[number]; text: string }>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const statementLines: string[] = [];
  const alternatives: Array<{ letter: (typeof EXPECTED_LETTERS)[number]; text: string }> = [];
  let current: { letter: (typeof EXPECTED_LETTERS)[number]; parts: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(ALTERNATIVE_RE);
    if (match) {
      const letter = match[1] as (typeof EXPECTED_LETTERS)[number];
      if (current) alternatives.push({ letter: current.letter, text: current.parts.join(" ").trim() });
      current = { letter, parts: [match[2]] };
      continue;
    }
    if (current) current.parts.push(line);
    else statementLines.push(line);
  }
  if (current) alternatives.push({ letter: current.letter, text: current.parts.join(" ").trim() });

  const letters = alternatives.map((a) => a.letter);
  const distinctLetters = new Set(letters);
  if (letters.length !== distinctLetters.size) warnings.push("Letra de alternativa duplicada detectada.");
  if (alternatives.length !== 5) warnings.push(`Detectadas ${alternatives.length} alternativas (esperado exatamente 5).`);
  if (alternatives.some((a) => a.text.length === 0)) warnings.push("Uma ou mais alternativas ficaram com texto vazio.");
  const orderedCorrectly = letters.every((l, i) => i === 0 || l > letters[i - 1]);
  if (alternatives.length > 0 && (!orderedCorrectly || letters[0] !== "A")) {
    warnings.push("Alternativas fora da ordem A-E esperada.");
  }

  return { statement: statementLines.join(" ").replace(/\s+/g, " ").trim(), alternatives, warnings };
}

/** Seção 7/8 da ordem — pipeline puro: linhas já extraídas por página →
 *  blocos por questão → enunciado/alternativas. `pages` já vem na ordem
 *  de leitura de `pdfEnemExtractor.ts` (topo→rodapé por página, páginas em
 *  ordem crescente). */
export function segmentExamQuestions(pages: PdfPageText[]): SegmentationResult {
  const flat = flattenPages(pages);
  const globalWarnings: string[] = [];

  type Block = { number: number; pageStart: number; lines: string[]; pages: Set<number> };
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const line of flat) {
    const start = detectQuestionStart(line.text);
    if (start) {
      if (current) blocks.push(current);
      current = { number: start.number, pageStart: line.pageNumber, lines: start.remainder ? [start.remainder] : [], pages: new Set([line.pageNumber]) };
      continue;
    }
    if (current) {
      current.lines.push(line.text);
      current.pages.add(line.pageNumber);
    }
    // Linhas ANTES da primeira questão detectada (capa, instruções) são
    // deliberadamente descartadas — nunca viram uma questão "número 0".
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    globalWarnings.push("Nenhuma questão numerada foi reconhecida neste PDF.");
    return { questions: [], globalWarnings };
  }

  const seenNumbers = new Map<number, number>(); // number -> count
  for (const b of blocks) seenNumbers.set(b.number, (seenNumbers.get(b.number) ?? 0) + 1);

  const questions: RawQuestionCandidate[] = blocks.map((block) => {
    const { statement, alternatives, warnings } = splitStatementAndAlternatives(block.lines);
    const pageNumbers = Array.from(block.pages).sort((a, b) => a - b);
    const hasVisualContentOnPages = pageNumbers.some((p) => flat.some((l) => l.pageNumber === p && l.hasVisualContent));

    if (block.number < MIN_QUESTION_NUMBER || block.number > MAX_QUESTION_NUMBER) {
      warnings.push(`Número de questão fora do intervalo aceito (${MIN_QUESTION_NUMBER}-${MAX_QUESTION_NUMBER}).`);
    }
    if ((seenNumbers.get(block.number) ?? 0) > 1) {
      warnings.push(`Número de questão ${block.number} aparece mais de uma vez neste PDF.`);
    }
    if (statement.length === 0) warnings.push("Enunciado vazio.");

    return {
      originalNumber: block.number,
      pageStart: pageNumbers[0],
      pageEnd: pageNumbers[pageNumbers.length - 1],
      statement,
      alternatives,
      hasVisualContentOnPages,
      warnings,
      rawLineCount: block.lines.length,
    };
  });

  return { questions, globalWarnings };
}
