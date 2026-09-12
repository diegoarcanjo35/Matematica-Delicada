/* Modelo de elemento visual — Sprint 23, seção 3 da ordem.

   Estrutura de PRÉVIA — vive dentro do payload do lote de import (mesma
   coluna TEXT/JSON `question_import_batches.payload` já usada desde a
   Sprint 18/19/22, sem migration). Deliberadamente NUNCA carrega os bytes
   da imagem (`pngBytes`) neste tipo — só metadado técnico leve (posição,
   hash, status). Os bytes reais são gerados sob demanda:
     - no preview, só para a RESPOSTA HTTP (nunca gravados no payload
       persistido — ver `PdfPreviewResult` em questionPdfImportService.ts);
     - no apply, re-derivados do zero a partir dos PDFs reenviados (mesmo
       princípio de "nunca confia no preview persistido como fonte de
       verdade" já usado para texto/gabarito nesta sprint 22). */

export type VisualElementKind = "raster" | "vector_diagram";

export type VisualExtractionStatus =
  | "extracted" // raster: pixels decodificados com sucesso, PNG gerável.
  | "detected_not_extractable" // vetor: detectado, mas nunca "extraído" automaticamente (seção 6 da ordem — sempre força revisão); ou raster cujo objeto nunca resolveu.
  | "ambiguous" // raster com formato/kind não reconhecido (ex.: máscara de imagem) — nunca tratado como sucesso.
  | "ignored_decorative"; // mesmo fingerprint/hash repetido estruturalmente em muitas páginas (seção 5 da ordem) — excluído da questão.

export type VisualPlacementCandidate = "statement" | "option_A" | "option_B" | "option_C" | "option_D" | "option_E" | "unknown";

export interface RawVisualElement {
  /** Estável DENTRO de uma extração (nunca persistido como referência
   *  externa) — usado só para correlacionar seleção do editor no preview
   *  com o reprocessamento no apply. */
  id: string;
  pageNumber: number;
  kind: VisualElementKind;
  /** Bounding box em espaço de página PDF (pontos), eixo Y crescendo para
   *  cima (convenção nativa do PDF — mesma usada por `PdfTextLine.y` em
   *  pdfEnemExtractor.ts). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Só para `kind==='raster'` — o objId do XObject no pdfjs-dist (nunca
   *  estável entre re-extrações do MESMO pdfjs-dist, mas útil para
   *  depuração/auditoria local). */
  sourceObjectId?: string;
  mime?: "image/png";
  byteLength?: number;
  /** SHA-256 hex dos pixels decodificados (raster) OU fingerprint FNV-1a
   *  hex das coordenadas locais do traçado (vetor) — usado para detecção
   *  de repetição estrutural (seção 5/6 da ordem), nunca para
   *  identificação criptográfica forte de conteúdo vetorial. */
  hash: string;
  extractionStatus: VisualExtractionStatus;
  placementCandidate: VisualPlacementCandidate;
  warnings: string[];
  /** Só em memória, durante a extração/preview — NUNCA serializado no
   *  payload persistido em `question_import_batches` (ver
   *  `toPersistableVisualElement` em questionPdfImportService.ts). Usado
   *  para (a) a resposta HTTP do preview (thumbnail inline) e (b) o
   *  upload real no apply, via o MESMO pipeline de `addQuestionImage`
   *  (questionMediaService.ts) já usado pelo resto do Banco de Questões. */
  pngBytes?: Uint8Array;
}

/** Seção 16 da ordem — limites explícitos por página/questão/lote,
 *  aplicados ANTES de qualquer alocação de buffer de imagem. Nunca
 *  hardcodados "no meio do código" — todos aqui, com justificativa. */
export const MAX_RASTER_ELEMENTS_PER_PAGE = 40; // generoso para qualquer página real (o PDF oficial testado tem no máximo 7 numa única página).
export const MAX_VECTOR_CANDIDATES_PER_PAGE = 500; // proteção contra um PDF hostil com dezenas de milhares de constructPath.
export const MAX_TOTAL_VISUAL_BYTES_PER_BATCH = 15 * 1024 * 1024; // 15MB de PNGs somados — bem acima de qualquer caderno real, mas finito.
