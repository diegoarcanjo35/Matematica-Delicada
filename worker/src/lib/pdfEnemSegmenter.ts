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
/* Sprint 22.1 — o PDF oficial real do ENEM NÃO usa pontuação entre a
   letra e o texto da alternativa (ex.: linha própria "A", depois o texto
   — nunca "A."). A pontuação continua aceita OPCIONALMENTE (compatível
   com outros formatos), mas nunca exigida. */
const ALTERNATIVE_RE = /^([A-E])(?:\s*[.\-–)])?\s+(.+)$/;

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

/** `allowInline` — Sprint 22.1: o fallback "N." inline SÓ é considerado
 *  quando o documento inteiro não usa NENHUMA vez o formato explícito
 *  "QUESTÃO N" (decidido uma única vez por `segmentExamQuestions`, ver
 *  `hasAnyHeadingStyle` abaixo). Bug real encontrado no PDF oficial: sem
 *  essa guarda, a lista numerada de instruções da capa ("1. Este
 *  CADERNO...", "2. Confira..." etc.) era reconhecida como questões 1-8
 *  espúrias — o mesmo padrão inline que detecta "91." também casa "1."
 *  de uma lista de instruções comum. */
function detectQuestionStart(text: string, allowInline: boolean): { number: number; remainder: string } | null {
  const heading = text.match(QUESTION_HEADING_RE);
  if (heading) return { number: Number(heading[1]), remainder: text.slice(heading[0].length).trim() };
  if (!allowInline) return null;
  const inline = text.match(QUESTION_INLINE_RE);
  if (inline) return { number: Number(inline[1]), remainder: inline[2] };
  return null;
}

/** Divide o bloco de linhas de UMA questão (já isolado pelo chamador) em
 *  enunciado + alternativas A-E. Nunca reordena.
 *
 *  Sprint 22.1 — `ALTERNATIVE_RE` teve a pontuação tornada opcional (o
 *  PDF oficial real não usa "A.", só "A" numa linha própria), o que por
 *  si só abriria risco real de falso-positivo: uma frase comum do
 *  enunciado começando com "A " (artigo) ou "E " (conjunção) casaria a
 *  regex. A defesa é SEQUENCIAL, nunca so-textual: só aceitamos uma nova
 *  alternativa quando a letra casada é EXATAMENTE a próxima esperada na
 *  sequência A→B→C→D→E (a primeira aceita precisa ser "A"; depois de "A"
 *  só "B" é aceito como próxima alternativa, nunca "C"/"D"/"E" fora de
 *  ordem, nunca "A" de novo). Qualquer linha que comece com uma letra
 *  A-E fora da sequência esperada é tratada como CONTINUAÇÃO de texto
 *  (enunciado ou alternativa em andamento), nunca uma nova alternativa —
 *  cinco frases reais começarem, em sequência, exatamente com "A", "B",
 *  "C", "D" e "E" isolados é praticamente impossível em português
 *  corrido. */
function splitStatementAndAlternatives(lines: string[]): {
  statement: string;
  alternatives: Array<{ letter: (typeof EXPECTED_LETTERS)[number]; text: string }>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const statementLines: string[] = [];
  const alternatives: Array<{ letter: (typeof EXPECTED_LETTERS)[number]; text: string }> = [];
  let current: { letter: (typeof EXPECTED_LETTERS)[number]; parts: string[] } | null = null;
  let nextExpectedIndex = 0; // índice em EXPECTED_LETTERS da próxima letra aceitável

  for (const line of lines) {
    const match = line.match(ALTERNATIVE_RE);
    const letter = match ? (match[1] as (typeof EXPECTED_LETTERS)[number]) : null;
    if (letter && nextExpectedIndex < EXPECTED_LETTERS.length && letter === EXPECTED_LETTERS[nextExpectedIndex]) {
      if (current) alternatives.push({ letter: current.letter, text: current.parts.join(" ").trim() });
      current = { letter, parts: [match![2]] };
      nextExpectedIndex += 1;
      continue;
    }
    // A letra casada é a MESMA da alternativa em andamento (nunca uma
    // letra fora de sequência qualquer, que quase sempre é só uma
    // palavra comum do português) — sinal real de duplicidade, nunca
    // silenciosamente ignorado nem tratado como nova alternativa.
    if (letter && current && letter === current.letter) {
      warnings.push("Letra de alternativa duplicada detectada.");
      current.parts.push(match![2]);
      continue;
    }
    if (current) current.parts.push(line);
    else statementLines.push(line);
  }
  if (current) alternatives.push({ letter: current.letter, text: current.parts.join(" ").trim() });

  // Duplicata (mesma letra da alternativa em andamento) já foi detectada
  // e avisada dentro do laço acima. Construção por sequência estrita
  // A→B→C→D→E torna "fora de ordem"/letras distintas-mas-desordenadas
  // estruturalmente impossíveis aqui — só resta checar a CONTAGEM e
  // texto vazio.
  if (alternatives.length !== 5) warnings.push(`Detectadas ${alternatives.length} alternativas (esperado exatamente 5).`);
  if (alternatives.some((a) => a.text.length === 0)) warnings.push("Uma ou mais alternativas ficaram com texto vazio.");

  return { statement: statementLines.join(" ").replace(/\s+/g, " ").trim(), alternatives, warnings };
}

/** Seção 7/8 da ordem — pipeline puro: linhas já extraídas por página →
 *  blocos por questão → enunciado/alternativas. `pages` já vem na ordem
 *  de leitura de `pdfEnemExtractor.ts` (topo→rodapé por página, páginas em
 *  ordem crescente). */
export function segmentExamQuestions(pages: PdfPageText[]): SegmentationResult {
  const flat = flattenPages(pages);
  const globalWarnings: string[] = [];

  // Sprint 22.1 — decidido UMA vez para o documento inteiro: se alguma
  // linha já usa o formato explícito "QUESTÃO N", o fallback inline "N."
  // fica desligado para todo o parse (evita casar a lista numerada de
  // instruções da capa como se fossem questões).
  const hasAnyHeadingStyle = flat.some((line) => QUESTION_HEADING_RE.test(line.text));

  type Block = { number: number; pageStart: number; lines: string[]; pages: Set<number> };
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const line of flat) {
    const start = detectQuestionStart(line.text, !hasAnyHeadingStyle);
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
