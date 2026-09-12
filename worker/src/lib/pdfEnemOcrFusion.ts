/* Fusão texto nativo + OCR — Sprint 24, seções 12/14 da ordem.

   Puro e determinístico (mesma entrada sempre produz a mesma saída — pré-
   requisito para apply poder re-derivar exatamente o que o preview
   mostrou, mesmo princípio já usado em toda a extração/segmentação desde a
   Sprint 22).

   Regra (seção 12): texto nativo é SEMPRE preferencial. OCR só preenche
   regiões da página onde não há linha nativa correspondente. Nunca
   concatena os dois cegamente (evita duplicar o mesmo conteúdo). Uma
   sobreposição espacial que não seja claramente "mesma linha" nem
   claramente "região vazia" fica marcada como ambígua — a linha OCR ainda
   entra (nunca descartamos conteúdo em silêncio), mas o retorno sinaliza a
   ambiguidade para o chamador poder gerar aviso (→ needs_review, nunca uma
   correção automática). `import type` — nunca um import de valor — evita
   ciclo em tempo de execução com pdfEnemExtractor.ts (que importa esta
   função). */

import type { PdfTextLine } from "./pdfEnemExtractor";
import type { OcrLineInput } from "./pdfEnemOcrModel";

/** Duas linhas na mesma faixa Y dentro desta tolerância são consideradas a
 *  MESMA linha física — nativo sempre vence, OCR é descartado (nunca dois
 *  textos para a mesma linha). Mesma ordem de grandeza da tolerância de
 *  agrupamento por Y usada em `pdfEnemExtractor.ts:groupItemsByY` (2pt),
 *  levemente maior para absorver o jitter típico da posição estimada por
 *  OCR (a bounding box do engine nunca é tão precisa quanto a posição
 *  vetorial exata do texto nativo). */
const SAME_LINE_TOLERANCE_PT = 4;

/** Além da tolerância de "mesma linha", mas ainda perto o bastante de uma
 *  linha nativa vizinha para não ter certeza se é conteúdo genuinamente
 *  novo ou uma variação de posição da MESMA linha — fica marcado ambíguo
 *  (nunca descartado, nunca aceito sem aviso). */
const AMBIGUOUS_BAND_PT = 10;

export interface FusedLine extends PdfTextLine {
  ambiguousFusion?: boolean;
}

export interface FusionResult {
  lines: FusedLine[];
  /** `true` quando pelo menos uma linha OCR caiu na faixa ambígua — o
   *  chamador deve gerar um aviso agregado para a página (nunca silencioso). */
  hasAmbiguousOverlap: boolean;
}

function nearestNativeDistance(y: number, nativeYs: number[]): number {
  let best = Infinity;
  for (const ny of nativeYs) {
    const d = Math.abs(ny - y);
    if (d < best) best = d;
  }
  return best;
}

/** Funde as linhas nativas (já extraídas, na ordem de leitura correta desta
 *  página) com as linhas OCR fornecidas pelo cliente para a MESMA página.
 *  Nunca reordena as linhas nativas entre si — só insere as linhas OCR
 *  aceitas na posição Y correspondente (mesma convenção de ordenação Y
 *  decrescente já usada por `groupItemsByY`). */
export function fusePageLines(nativeLines: PdfTextLine[], ocrLines: OcrLineInput[]): FusionResult {
  const nativeYs = nativeLines.map((l) => l.y);
  const fused: FusedLine[] = nativeLines.map((l) => ({ ...l, source: l.source ?? "native" }));
  let hasAmbiguousOverlap = false;

  for (const ocrLine of ocrLines) {
    const text = ocrLine.text.trim();
    if (text.length === 0) continue;
    const distance = nearestNativeDistance(ocrLine.y, nativeYs);

    if (distance <= SAME_LINE_TOLERANCE_PT) {
      // Seção 12 — sobreposição espacial forte: nativo já cobre esta linha,
      // OCR é descartado sem aviso (não é uma perda: o texto nativo é mais
      // confiável e já está presente).
      continue;
    }

    const ambiguous = distance <= AMBIGUOUS_BAND_PT;
    if (ambiguous) hasAmbiguousOverlap = true;

    fused.push({
      y: ocrLine.y,
      text,
      source: "ocr",
      confidencePercent: ocrLine.confidencePercent,
      ambiguousFusion: ambiguous,
    });
  }

  fused.sort((a, b) => b.y - a.y);
  return { lines: fused, hasAmbiguousOverlap };
}

/* Seção 14 da ordem — detecção (nunca correção) de possível TABELA em
   linhas de origem OCR: heurística estrutural (múltiplas "células"
   separadas por 2+ espaços, repetida em várias linhas), nunca uma lista de
   palavras/formatos específicos. Uma tabela real vira sempre needs_review
   — nunca "achatada" em texto linear e considerada pronta. */
const MIN_CELLS_FOR_TABULAR_ROW = 3;
const MIN_TABULAR_ROWS = 3;

function countCells(text: string): number {
  return text.split(/\s{2,}/).filter((cell) => cell.trim().length > 0).length;
}

export function looksTabularOcrRegion(ocrLines: OcrLineInput[]): boolean {
  const tabularRows = ocrLines.filter((l) => countCells(l.text) >= MIN_CELLS_FOR_TABULAR_ROW).length;
  return tabularRows >= MIN_TABULAR_ROWS;
}
