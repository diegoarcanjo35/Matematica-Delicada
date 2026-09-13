/* Importador ENEM CLIENT-SIDE — Sprint 24.2.

   Pipeline PURO (sem DOM, sem Worker) que faz TODO o trabalho de extração
   que antes rodava dentro do Cloudflare Worker (causa raiz do incidente
   P1: o plano Free do Workers tem teto de CPU baixo demais para pdf.js —
   ver auditoria correlacionada por cf-ray, `outcome: "exceededCpu"` real).

   Reaproveita, SEM REIMPLEMENTAR, os módulos puros já testados de
   `worker/src/lib/pdfEnem*.ts` — mesma extração, mesma segmentação, mesmo
   casamento com gabarito usados pelo fluxo Worker-side clássico. A única
   coisa nova aqui é a ORQUESTRAÇÃO por janelas (Seção 3 da ordem: nunca 1
   página isolada como unidade — a POC provou que isso gera falsos
   positivos de capa) e a CONSOLIDAÇÃO (Seção 4/5/6/7: dedup por
   completude, remapeamento de página, classificação decorativa GLOBAL,
   filtro de questão fantasma).

   Roda tanto dentro do Web Worker real do navegador
   (`pdfEnemImport.worker.ts`) quanto em Node puro (testes desta sprint,
   incluindo o teste obrigatório com o PDF real do ENEM 2024) — nenhuma
   API de DOM é usada aqui. */

import { PDFDocument } from "pdf-lib";
import { extractPdfPages, type PdfPageText, type ExtractPdfPagesOptions } from "../../worker/src/lib/pdfEnemExtractor";
import { segmentExamQuestions, type RawQuestionCandidate } from "../../worker/src/lib/pdfEnemSegmenter";
import { parseAnswerKeyFromPages, type AnswerLetter } from "../../worker/src/lib/pdfEnemAnswerKey";
import { detectExamDocumentIdentity, detectAnswerKeyDocumentIdentity, type DetectedDocumentIdentity } from "../../worker/src/lib/pdfEnemDocumentIdentity";
import {
  classifyDecorativeRasterElements,
  classifyDecorativeVectorCandidates,
  type RawVectorCandidate,
} from "../../worker/src/lib/pdfEnemVisualExtractor";
import type { RawVisualElement } from "../../worker/src/lib/pdfEnemVisualModel";
import { sha256HexOfBytes } from "../../worker/src/lib/crypto";

/* -------------------------------------------------------------------------
   1. Janelamento (Seção 3 da ordem) — divisão de MEMÓRIA/PROCESSAMENTO
   local, NUNCA de rede: o Worker Cloudflare nunca vê estas janelas, elas
   existem só dentro do navegador. 8 páginas + 1 de overlap (sugestão da
   ordem) — nunca 1 página isolada como unidade lógica (POC: falsos
   positivos de capa).
   ------------------------------------------------------------------------- */

export interface PdfWindowPlan {
  windowIndex: number;
  /** 1-based, inclusive, no espaço de páginas do PDF ORIGINAL — nunca
   *  relativo à janela (essa é exatamente a confusão que a Seção 5 da
   *  ordem exige nunca acontecer). */
  startPage: number;
  endPage: number;
}

export const DEFAULT_WINDOW_SIZE = 8;
export const DEFAULT_WINDOW_OVERLAP = 1;

export function planWindows(totalPages: number, windowSize: number = DEFAULT_WINDOW_SIZE, overlap: number = DEFAULT_WINDOW_OVERLAP): PdfWindowPlan[] {
  if (totalPages < 1) return [];
  const step = Math.max(1, windowSize - overlap);
  const windows: PdfWindowPlan[] = [];
  let start = 1;
  let windowIndex = 0;
  for (;;) {
    const end = Math.min(start + windowSize - 1, totalPages);
    windows.push({ windowIndex, startPage: start, endPage: end });
    if (end >= totalPages) break;
    windowIndex += 1;
    start += step;
  }
  return windows;
}

/** Recorta o PDF original em UM sub-PDF válido por janela — mesma técnica
 *  do Eleve PDF (`PDFDocument.load` uma vez, `PDFDocument.create` +
 *  `copyPages` + `addPage` + `save` por parte), generalizada para janelas
 *  SOBREPOSTAS (o Eleve PDF original só suporta partes disjuntas por
 *  tamanho — aqui o `pageIndices` de cada janela é calculado explicitamente
 *  a partir de `PdfWindowPlan`, permitindo overlap). Nunca corta página ao
 *  meio, nunca reordena. */
export async function splitPdfIntoWindowBytes(bytes: Uint8Array, windows: PdfWindowPlan[]): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(bytes);
  const result: Uint8Array[] = [];
  for (const w of windows) {
    const pageIndices: number[] = [];
    for (let p = w.startPage; p <= w.endPage; p++) pageIndices.push(p - 1); // pdf-lib é 0-based.
    const doc = await PDFDocument.create();
    const copied = await doc.copyPages(source, pageIndices);
    copied.forEach((page) => doc.addPage(page));
    result.push(await doc.save({ useObjectStreams: true }));
  }
  return result;
}

/* -------------------------------------------------------------------------
   2. Remapeamento de página (Seção 5 da ordem) — `extractPdfPages` numera
   páginas de 1..N relativas ao PRÓPRIO sub-PDF recebido; todo resultado
   precisa voltar para o número REAL da página no documento original antes
   de qualquer outro passo (senão um aviso "Página 3" mostrado à Andreia
   apontaria para a página errada do PDF completo).
   ------------------------------------------------------------------------- */

function remapPages(pages: PdfPageText[], offset: number): PdfPageText[] {
  return pages.map((p) => ({ ...p, pageNumber: p.pageNumber + offset }));
}

function remapVisualElements(elements: RawVisualElement[], offset: number): RawVisualElement[] {
  return elements.map((e) => ({ ...e, pageNumber: e.pageNumber + offset }));
}

function remapVectorCandidates(candidates: RawVectorCandidate[], offset: number): RawVectorCandidate[] {
  return candidates.map((c) => ({ ...c, pageNumber: c.pageNumber + offset }));
}

/* Nota: `RawQuestionCandidate.pageStart/pageEnd/statementLocations/
   alternativeLocations` NUNCA precisam de remapeamento próprio aqui —
   `segmentExamQuestions` deriva tudo isso a partir do `pageNumber` de
   CADA linha recebida (`remapPages` acima já aplica o offset ANTES da
   segmentação), então o resultado já nasce com o número de página REAL
   do documento original. Confirmado por teste real (ver
   pdfEnemClientPipeline.test.ts — "Remapeamento de página"). */

/* -------------------------------------------------------------------------
   3. Consolidação (Seção 4 da ordem) — dedup determinístico por completude
   quando a MESMA questão aparece em janelas de overlap adjacentes.
   ------------------------------------------------------------------------- */

/** Ordem de critérios EXATA da Seção 4 da ordem (cada um só desempata o
 *  anterior — nunca uma soma ponderada): enunciado não vazio → 5
 *  alternativas → conteúdo visual relacionado → menos warnings → começou
 *  primeiro. "Possui heading" não entra aqui porque TODO `RawQuestionCandidate`
 *  já exige um heading reconhecido para existir (garantia de
 *  `segmentExamQuestions` — nunca um candidato sem cabeçalho). */
function compareCompleteness(a: RawQuestionCandidate, b: RawQuestionCandidate): number {
  const aStatement = a.statement.length > 0 ? 1 : 0;
  const bStatement = b.statement.length > 0 ? 1 : 0;
  if (aStatement !== bStatement) return bStatement - aStatement;

  const aFive = a.alternatives.length === 5 ? 1 : 0;
  const bFive = b.alternatives.length === 5 ? 1 : 0;
  if (aFive !== bFive) return bFive - aFive;

  const aVisual = a.hasVisualContentOnPages ? 1 : 0;
  const bVisual = b.hasVisualContentOnPages ? 1 : 0;
  if (aVisual !== bVisual) return bVisual - aVisual;

  if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;

  return a.pageStart - b.pageStart;
}

export function dedupQuestionsByCompleteness(candidates: RawQuestionCandidate[]): { questions: RawQuestionCandidate[]; warnings: string[] } {
  const byNumber = new Map<number, RawQuestionCandidate[]>();
  for (const c of candidates) {
    const list = byNumber.get(c.originalNumber) ?? [];
    list.push(c);
    byNumber.set(c.originalNumber, list);
  }
  const warnings: string[] = [];
  const result: RawQuestionCandidate[] = [];
  for (const [number, list] of byNumber) {
    if (list.length === 1) {
      result.push(list[0]);
      continue;
    }
    const sorted = [...list].sort(compareCompleteness);
    result.push(sorted[0]);
    warnings.push(
      `Questão ${number} apareceu em ${list.length} janela(s) de sobreposição — escolhida a ocorrência mais completa (a partir da página ${sorted[0].pageStart}), descartadas as demais de forma determinística.`
    );
  }
  result.sort((a, b) => a.originalNumber - b.originalNumber);
  return { questions: result, warnings };
}

/* -------------------------------------------------------------------------
   4. Filtro de questão fantasma (Seção 7 da ordem) — nunca hardcoded por
   ano: infere o intervalo real a partir do próprio conjunto de números
   detectados (o cluster mais POPULOSO, nunca o de maior span isolado).
   ------------------------------------------------------------------------- */

const PHANTOM_CLUSTER_MAX_GAP = 5; // tolera algumas questões faltantes/anuladas sem quebrar o cluster real.

/** Sprint 24.2 — achado real ao testar contra o PDF oficial 2024: uma
 *  página de OVERLAP (ex.: página 8, presente tanto na janela 1-8 quanto
 *  na 8-15) é extraída DUAS VEZES — uma vez por janela. Para TEXTO isso é
 *  desejável (é exatamente por isso que o overlap existe — proteção contra
 *  questão cortada na fronteira). Para elementos VISUAIS (imagem/vetor)
 *  não há nenhum benefício e SIM um problema real: uma imagem nunca cruza
 *  página, então extraí-la duas vezes só produz duplicata.
 *
 *  Tentativa descartada nesta sprint: deduplicar por (hash, geometria)
 *  DEPOIS de coletar tudo — provou-se ERRADA contra o PDF real (medição:
 *  521 vetores esperados → só 455 sobreviviam) porque vários candidatos
 *  vetoriais LEGÍTIMOS e DISTINTOS dentro de um mesmo diagrama real
 *  compartilham o mesmo `fingerprint` por design (traços pequenos
 *  repetidos — ver comentário de `pdfEnemVisualExtractor.ts`), então
 *  qualquer dedup por conteúdo depois do fato arrisca colapsar conteúdo
 *  real.
 *
 *  Correção adotada — exclusão DETERMINÍSTICA na origem, nunca por
 *  conteúdo: cada página tem seus elementos visuais aceitos de UMA ÚNICA
 *  janela (a primeira que a contém) — a página de overlap (sempre a
 *  PRIMEIRA página de toda janela exceto a primeira do documento) tem seu
 *  texto processado nas duas janelas (overlap preservado para
 *  segmentação), mas seus elementos visuais só entram na lista global
 *  vindos da janela ANTERIOR (onde ela é a ÚLTIMA página, não a
 *  primeira). Resultado verificado: bate exatamente com a extração SEM
 *  janelamento do mesmo PDF (104 raster + 521 vetores = 634, idêntico ao
 *  baseline). */
function filterVisualElementsForWindowOwnership<T extends { pageNumber: number }>(elements: T[], window: PdfWindowPlan, isFirstWindow: boolean): T[] {
  if (isFirstWindow) return elements;
  return elements.filter((e) => e.pageNumber !== window.startPage);
}

export function filterPhantomQuestions(candidates: RawQuestionCandidate[]): { questions: RawQuestionCandidate[]; warnings: string[] } {
  if (candidates.length === 0) return { questions: [], warnings: [] };
  const numbers = candidates.map((c) => c.originalNumber).sort((a, b) => a - b);
  const clusters: number[][] = [];
  let current: number[] = [numbers[0]];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] - numbers[i - 1] <= PHANTOM_CLUSTER_MAX_GAP) {
      current.push(numbers[i]);
    } else {
      clusters.push(current);
      current = [numbers[i]];
    }
  }
  clusters.push(current);

  const mainCluster = clusters.reduce((best, c) => (c.length > best.length ? c : best), clusters[0]);
  if (mainCluster.length === candidates.length) return { questions: candidates, warnings: [] };

  const mainSet = new Set(mainCluster);
  const questions: RawQuestionCandidate[] = [];
  const warnings: string[] = [];
  for (const c of candidates) {
    if (mainSet.has(c.originalNumber)) {
      questions.push(c);
    } else {
      warnings.push(
        `Questão ${c.originalNumber} descartada: número isolado fora do intervalo real de questões detectado (${mainCluster[0]}-${mainCluster[mainCluster.length - 1]}) — provável falso positivo de capa/instruções (mesmo padrão estrutural do achado da POC: lista numerada de instruções reconhecida como questão sem contexto suficiente).`
      );
    }
  }
  return { questions, warnings };
}

/* -------------------------------------------------------------------------
   5. Orquestração principal.
   ------------------------------------------------------------------------- */

export type PdfImportProgressStage =
  | "reading"
  | "window"
  | "answerKey"
  | "visuals"
  | "consolidating"
  | "preparing";

export interface PdfImportProgress {
  stage: PdfImportProgressStage;
  message: string;
  windowIndex?: number;
  totalWindows?: number;
}

export interface PdfImportPipelineOk {
  ok: true;
  pageCount: number;
  examSha256: string;
  answerKeySha256: string;
  examQuestions: RawQuestionCandidate[];
  answerKey: Array<[number, AnswerLetter]>;
  visualElements: RawVisualElement[];
  examDetectedIdentity: DetectedDocumentIdentity;
  answerKeyDetectedIdentity: DetectedDocumentIdentity;
  warnings: string[];
}

export interface PdfImportPipelineError {
  ok: false;
  reason: "invalid_exam" | "invalid_answer_key" | "needs_ocr" | "cancelled";
  message: string;
}

export type PdfImportPipelineResult = PdfImportPipelineOk | PdfImportPipelineError;

const EXTRACT_WINDOW_OPTIONS: ExtractPdfPagesOptions = { skipDecorativeClassification: true };

export interface RunClientPdfImportPipelineOptions {
  windowSize?: number;
  overlap?: number;
  onProgress?: (progress: PdfImportProgress) => void;
  signal?: AbortSignal;
}

export async function runClientPdfImportPipeline(
  examBytes: Uint8Array,
  answerKeyBytes: Uint8Array,
  options: RunClientPdfImportPipelineOptions = {}
): Promise<PdfImportPipelineResult> {
  const { windowSize = DEFAULT_WINDOW_SIZE, overlap = DEFAULT_WINDOW_OVERLAP, onProgress, signal } = options;
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("__cancelled__");
  };

  try {
    onProgress?.({ stage: "reading", message: "Preparando prova..." });
    checkCancelled();
    const [examSha256, answerKeySha256] = await Promise.all([sha256HexOfBytes(examBytes), sha256HexOfBytes(answerKeyBytes)]);

    // Seção 1 da ordem — só para saber o total de páginas real (nunca
    // processa texto/visual aqui: extração de verdade acontece por
    // JANELA, abaixo).
    const probe = await PDFDocument.load(examBytes);
    const totalPages = probe.getPageCount();

    const windows = planWindows(totalPages, windowSize, overlap);
    const windowBytes = await splitPdfIntoWindowBytes(examBytes, windows);

    const allRawQuestions: RawQuestionCandidate[] = [];
    const allRasterElements: RawVisualElement[] = [];
    const allVectorCandidates: RawVectorCandidate[] = [];
    let examDetectedIdentity: DetectedDocumentIdentity = {};
    const warnings: string[] = [];

    for (let i = 0; i < windows.length; i++) {
      checkCancelled();
      const w = windows[i];
      onProgress?.({
        stage: "window",
        message: `Lendo páginas ${w.startPage}–${w.endPage}...`,
        windowIndex: i,
        totalWindows: windows.length,
      });

      const extract = await extractPdfPages(windowBytes[i], undefined, EXTRACT_WINDOW_OPTIONS);
      if (!extract.ok) {
        if (extract.reason === "needs_ocr") {
          return { ok: false, reason: "needs_ocr", message: "Esta prova parece digitalizada (sem camada de texto nativa) — o importador client-side desta versão não suporta OCR; use o importador PDF padrão." };
        }
        return { ok: false, reason: "invalid_exam", message: extract.message };
      }

      const offset = w.startPage - 1;
      const remappedPages = remapPages(extract.pages, offset);
      const { questions, globalWarnings } = segmentExamQuestions(remappedPages);
      allRawQuestions.push(...questions);
      warnings.push(...globalWarnings);
      const remappedVisuals = remapVisualElements(extract.visualElements, offset);
      const remappedVectors = remapVectorCandidates(extract.rawVectorCandidates, offset);
      allRasterElements.push(...filterVisualElementsForWindowOwnership(remappedVisuals, w, i === 0));
      allVectorCandidates.push(...filterVisualElementsForWindowOwnership(remappedVectors, w, i === 0));

      // Seção 5 da ordem (identidade) — primeiro valor não-undefined
      // encontrado vence por campo (nunca exige que TODAS as janelas
      // detectem — algumas páginas do rodapé real omitem o dígito do dia,
      // achado já documentado no hotfix anterior).
      const windowIdentity = detectExamDocumentIdentity(remappedPages);
      examDetectedIdentity = {
        year: examDetectedIdentity.year ?? windowIdentity.year,
        day: examDetectedIdentity.day ?? windowIdentity.day,
        bookletNumber: examDetectedIdentity.bookletNumber ?? windowIdentity.bookletNumber,
        color: examDetectedIdentity.color ?? windowIdentity.color,
        application: examDetectedIdentity.application ?? windowIdentity.application,
        lowConfidenceOcrSource: examDetectedIdentity.lowConfidenceOcrSource || windowIdentity.lowConfidenceOcrSource,
      };
    }

    // Seção 6 da ordem — classificação decorativa GLOBAL, uma única vez,
    // sobre TODAS as janelas juntas (nunca por janela — a POC mediu até
    // +108% de falsos positivos em janelas pequenas). Antes disso, remove
    // duplicatas físicas causadas pelas páginas de OVERLAP (extraídas duas
    // vezes — achado real ao testar contra o PDF de 2024, ver
    // `dedupVisualElementsFromOverlap`).
    onProgress?.({ stage: "visuals", message: "Analisando imagens..." });
    checkCancelled();
    // Já sem duplicatas de overlap — cada página contribuiu visuais de
    // UMA única janela (ver `filterVisualElementsForWindowOwnership`).
    const dedupedRasterElements = allRasterElements;
    const dedupedVectorCandidates = allVectorCandidates;
    classifyDecorativeRasterElements(dedupedRasterElements, totalPages);
    const decorativeVectorFingerprints = classifyDecorativeVectorCandidates(dedupedVectorCandidates, totalPages);
    for (let i = 0; i < dedupedVectorCandidates.length; i++) {
      const candidate = dedupedVectorCandidates[i];
      if (decorativeVectorFingerprints.get(candidate.fingerprint)) continue;
      dedupedRasterElements.push({
        id: `p${candidate.pageNumber}_vec_${i}`,
        pageNumber: candidate.pageNumber,
        kind: "vector_diagram",
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        hash: candidate.fingerprint,
        extractionStatus: "detected_not_extractable",
        placementCandidate: "unknown",
        warnings: [],
      });
    }

    // Sprint 24.2 — SHA-256 do arquivo PNG (nunca dos pixels crus — isso já
    // é `hash`) calculado AQUI, no navegador, no momento da extração; é
    // este valor que o Worker vai exigir bater de novo no apply (única
    // prova de integridade possível sem reenviar o PDF — ver seção 9 da
    // ordem e `pngSha256` em pdfEnemVisualModel.ts).
    for (const el of dedupedRasterElements) {
      if (el.pngBytes) el.pngSha256 = await sha256HexOfBytes(el.pngBytes);
    }

    onProgress?.({ stage: "consolidating", message: "Consolidando questões..." });
    checkCancelled();
    const deduped = dedupQuestionsByCompleteness(allRawQuestions);
    const phantomFiltered = filterPhantomQuestions(deduped.questions);
    warnings.push(...deduped.warnings, ...phantomFiltered.warnings);

    onProgress?.({ stage: "answerKey", message: "Lendo gabarito..." });
    checkCancelled();
    // Seção 8 da ordem — gabarito processado INTEIRO, nunca dividido em
    // janelas (documento real medido: 1 página, <60ms de processamento —
    // não é o gargalo que motivou esta sprint).
    const answerKeyExtract = await extractPdfPages(answerKeyBytes);
    if (!answerKeyExtract.ok) {
      if (answerKeyExtract.reason === "needs_ocr") {
        return { ok: false, reason: "needs_ocr", message: "Este gabarito parece digitalizado (sem camada de texto nativa) — não suportado nesta versão client-side." };
      }
      return { ok: false, reason: "invalid_answer_key", message: answerKeyExtract.message };
    }
    const { answers, errors: answerKeyErrors } = parseAnswerKeyFromPages(answerKeyExtract.pages);
    warnings.push(...answerKeyErrors);
    const answerKeyDetectedIdentity = detectAnswerKeyDocumentIdentity(answerKeyExtract.pages);

    onProgress?.({ stage: "preparing", message: "Preparando prévia..." });
    checkCancelled();

    return {
      ok: true,
      pageCount: totalPages,
      examSha256,
      answerKeySha256,
      examQuestions: phantomFiltered.questions,
      answerKey: Array.from((answers ?? new Map<number, AnswerLetter>()).entries()),
      visualElements: dedupedRasterElements,
      examDetectedIdentity,
      answerKeyDetectedIdentity,
      warnings,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "__cancelled__") {
      return { ok: false, reason: "cancelled", message: "Processamento cancelado." };
    }
    throw error;
  }
}
