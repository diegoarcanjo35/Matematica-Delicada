/* Associação visual → questão/alternativa — Sprint 23, seção 4 da ordem.

   Usa SOMENTE coordenadas (nunca proximidade de página isolada — seção 4:
   "NÃO atribuir por simples proximidade de página"). Cada questão já expõe
   `statementLocations`/`alternativeLocations` (pdfEnemSegmenter.ts, Sprint
   23) — faixas [minY,maxY] por página que cada parte (enunciado ou UMA
   alternativa) ocupou no PDF original, no mesmo espaço de coordenadas Y
   nativo do PDF (cresce para cima) usado pelo extrator visual.

   Regras da seção 4, aplicadas nesta ordem:
   A) o elemento pertence à questão cuja extensão Y NA MESMA PÁGINA contém
      o centro do elemento — nunca a questão "mais próxima": se a faixa
      cair na intersecção de duas questões (colunas lado a lado na mesma
      faixa de Y — ver limitação de v1 abaixo) o dono fica indeterminado
      (`unknown`, seção 4-D).
   B) dentro da questão dona, se o centro do elemento cai dentro da faixa
      de UMA alternativa específica → placement daquela alternativa.
   C) se cai entre o fim do enunciado e o início da primeira alternativa
      (ou dentro da própria faixa do enunciado) → placement do enunciado.
   D) qualquer outro caso (não bate com nenhuma questão, bate com mais de
      uma, ou não cai em nenhuma faixa reconhecida dentro da questão dona)
      → `unknown`, o chamador marca a questão inteira `visualReviewRequired`.

   LIMITAÇÃO DE v1, divulgada no relatório final: a checagem de "dono" usa
   só a faixa Y da página (nunca X/coluna). Correto para páginas de coluna
   única e para o caso comum de duas colunas onde a questão dona é a única
   com conteúdo naquela faixa Y na página. Em uma página de duas colunas
   onde DUAS questões diferentes (uma em cada coluna) ocupam a MESMA faixa
   de Y, o elemento fica `unknown` por ambiguidade genuína (nunca chuta uma
   das duas) — nunca foi observado no PDF oficial testado nesta sprint
   (nenhum elemento raster caiu numa faixa Y compartilhada por duas
   questões diferentes), mas o código está preparado para o caso: reporta
   ambíguo em vez de arriscar. */

import type { QuestionSlotLocation, RawQuestionCandidate } from "./pdfEnemSegmenter";
import type { VisualPlacementCandidate } from "./pdfEnemVisualModel";

interface QuestionExtent {
  originalNumber: number;
  minY: number;
  maxY: number;
}

function unionRange(locations: QuestionSlotLocation[], pageNumber: number): { minY: number; maxY: number } | null {
  const onPage = locations.filter((l) => l.pageNumber === pageNumber);
  if (onPage.length === 0) return null;
  return { minY: Math.min(...onPage.map((l) => l.minY)), maxY: Math.max(...onPage.map((l) => l.maxY)) };
}

function questionExtentOnPage(question: RawQuestionCandidate, pageNumber: number): { minY: number; maxY: number } | null {
  const ranges: Array<{ minY: number; maxY: number }> = [];
  const statementRange = unionRange(question.statementLocations, pageNumber);
  if (statementRange) ranges.push(statementRange);
  for (const letter of ["A", "B", "C", "D", "E"] as const) {
    const locs = question.alternativeLocations[letter];
    if (!locs) continue;
    const range = unionRange(locs, pageNumber);
    if (range) ranges.push(range);
  }
  if (ranges.length === 0) return null;
  return { minY: Math.min(...ranges.map((r) => r.minY)), maxY: Math.max(...ranges.map((r) => r.maxY)) };
}

/** Pequena folga (pontos) para absorver arredondamento de posição entre a
 *  extração de texto e a de imagem (ambas derivadas independentemente do
 *  mesmo PDF, mas nunca byte-a-byte coincidentes) — nunca usada para
 *  "adivinhar" uma questão fora de alcance, só para não perder um
 *  elemento colado exatamente na borda de uma faixa por 1-2pt. */
const BOUNDARY_TOLERANCE_PT = 3;

function withinRange(y: number, range: { minY: number; maxY: number }): boolean {
  return y >= range.minY - BOUNDARY_TOLERANCE_PT && y <= range.maxY + BOUNDARY_TOLERANCE_PT;
}

export interface PlacementResult {
  ownerQuestionNumber: number | null;
  placement: VisualPlacementCandidate;
}

/** `elementCenterY`/`elementPageNumber` — bbox do elemento visual já
 *  resolvido pelo extrator (`RawVisualElement.y + height/2`, mesma página). */
export function placeVisualElement(elementPageNumber: number, elementCenterY: number, questions: RawQuestionCandidate[]): PlacementResult {
  const candidateExtents: QuestionExtent[] = [];
  for (const q of questions) {
    const extent = questionExtentOnPage(q, elementPageNumber);
    if (extent && withinRange(elementCenterY, extent)) {
      candidateExtents.push({ originalNumber: q.originalNumber, ...extent });
    }
  }

  if (candidateExtents.length !== 1) {
    // Zero (nenhuma questão reivindica esta posição) ou mais de uma
    // (ambiguidade genuína de coluna) — seção 4-D, nunca um chute.
    return { ownerQuestionNumber: null, placement: "unknown" };
  }

  const owner = candidateExtents[0];
  const question = questions.find((q) => q.originalNumber === owner.originalNumber)!;

  for (const letter of ["A", "B", "C", "D", "E"] as const) {
    const locs = question.alternativeLocations[letter];
    if (!locs) continue;
    const range = unionRange(locs, elementPageNumber);
    if (range && withinRange(elementCenterY, range)) {
      return { ownerQuestionNumber: owner.originalNumber, placement: (`option_${letter}` as const) };
    }
  }

  const statementRange = unionRange(question.statementLocations, elementPageNumber);
  if (statementRange) {
    // Regra C — dentro do enunciado OU entre o fim do enunciado e o
    // início da primeira alternativa reconhecida (o que, com a folga
    // acima, `withinRange` contra a extensão TOTAL da questão já cobre
    // quando não há alternativa específica reivindicando o centro do
    // elemento — chegamos aqui só depois de nenhuma alternativa bater).
    return { ownerQuestionNumber: owner.originalNumber, placement: "statement" };
  }

  return { ownerQuestionNumber: owner.originalNumber, placement: "unknown" };
}
