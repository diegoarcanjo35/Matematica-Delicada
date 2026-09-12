/* OCR client-side (browser) — Sprint 24/24.1, seções 1/2/3/4/5/19/20/21/22
   da ordem.

   Feasibility spike (Sprint 24, Seção 1): OCR roda EXCLUSIVAMENTE no
   navegador da editora, nunca no Cloudflare Worker — `tesseract.js`
   (Apache-2.0, engine C++ Tesseract embarcado em WASM) depende de um Web
   Worker de verdade para não travar a aba, e o runtime do Worker (workerd)
   não suporta `new Worker()` aninhado nem tem memória/CPU-time dedicados o
   bastante para um engine OCR completo. Nenhum serviço pago, nenhuma API
   externa, nenhuma IA externa — só a biblioteca local, carregada sob
   demanda (nunca no bundle principal — só quando pelo menos uma página
   precisar de OCR, via `import()` dinâmico em `EditorialImportsPage.tsx`).

   Sprint 24.1 — SELF-HOST de TODOS os assets do OCR (nunca jsdelivr/unpkg/
   GitHub raw em runtime). Investigação do CÓDIGO REAL da versão instalada
   (`node_modules/tesseract.js@7.0.0`, nunca assumido) confirmou três
   recursos que o tesseract.js buscaria externamente por padrão:
     - `workerPath` → default `https://cdn.jsdelivr.net/npm/tesseract.js@v.../dist/worker.min.js`
       (`src/worker/browser/defaultOptions.js`);
     - `corePath` → default `https://cdn.jsdelivr.net/npm/tesseract.js-core@v...`,
       resolvendo para um de vários `tesseract-core*.wasm.js` via detecção
       de SIMD (`src/worker-script/browser/getCore.js`);
     - `langPath` → default `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int`
       (`src/worker-script/index.js`, comentário explícito no código-fonte:
       "If langPath if not explicitly set by the user, the jsdelivr CDN is
       used").
   Os três agora são passados EXPLICITAMENTE abaixo, apontando para
   `/tesseract/...` — arquivos copiados de `node_modules` (dependências
   pinadas `tesseract.js-core`/`@tesseract.js-data/por` no package.json,
   nunca um download ad hoc) para `public/tesseract/` por
   `scripts/prepare-tesseract-assets.mjs`, que roda como `prebuild`/`predev`
   (nunca um passo manual esquecível) — servidos pelo MESMO origin do
   Matemática Delicada, dentro do bundle publicado.

   Núcleo escolhido: `tesseract-core-lstm` (LSTM simples, SEM detecção de
   SIMD) — um `corePath` terminado em `.js` é usado DIRETAMENTE pelo
   tesseract.js, sem nenhuma ramificação condicional nem fetch de feature
   detection; troca uma otimização de performance por comportamento 100%
   determinístico e same-origin em qualquer navegador.

   Renderização: `pdfjs-dist` (já dependência do projeto, usado também no
   Worker) — aqui no BUILD DE NAVEGADOR de verdade, com Web Worker real
   (bundlado pelo Vite via `new URL(...)`, mesmo origin), diferente do
   "fake worker" síncrono usado em `worker/src/lib/pdfEnemExtractor.ts`.

   Coordenadas: `PdfTextLine.y`/`x` (usados por todo o pipeline de
   segmentação/fusão) seguem a convenção NATIVA do PDF (origem no canto
   INFERIOR esquerdo, Y cresce para cima). O canvas de renderização usa a
   convenção de TELA (origem no canto SUPERIOR esquerdo, Y cresce para
   baixo). Toda conversão de coordenada feita aqui (`canvasBboxToPdfPoint`)
   é responsável por essa inversão — nunca deixada para o worker fazer. */

import * as pdfjsLib from "pdfjs-dist";
import { createWorker, type Worker as TesseractWorker } from "tesseract.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

/** Sprint 24.1 — caminhos EXPLÍCITOS, same-origin, nunca os defaults do
 *  tesseract.js (que apontam para jsdelivr — ver comentário do arquivo).
 *  `langPath` é tratado como DIRETÓRIO pelo tesseract.js (nunca um
 *  arquivo `.js`) — ele mesmo monta `${langPath}/${lang}.traineddata.gz`. */
const TESSERACT_WORKER_PATH = "/tesseract/worker.min.js";
const TESSERACT_CORE_PATH = "/tesseract/tesseract-core-lstm.wasm.js";
const TESSERACT_LANG_PATH = "/tesseract";

export interface ClientOcrLine {
  x: number;
  y: number;
  text: string;
  confidencePercent: number;
}

export interface ClientOcrPageResult {
  pageNumber: number;
  lines: ClientOcrLine[];
}

export interface OcrProgressEvent {
  pageNumber: number;
  pageIndex: number;
  totalPages: number;
  message: string;
}

/* Seção 19 da ordem — limites obrigatórios, fail-closed. `OCR_MAX_PAGES_PER_BATCH`
   espelha (nunca excede) `MAX_OCR_PAGES_PER_BATCH` de
   `worker/src/lib/pdfEnemOcrModel.ts` — o worker revalida de qualquer
   forma (seção 19: "nunca confia só no lado do cliente"), mas o cliente
   nunca deveria sequer TENTAR enviar mais que isso. */
export const OCR_MAX_PAGES_PER_BATCH = 40;
/** Escala inicial de renderização (1 = 72 DPI, base do PDF) — 2 ≈ 144 DPI,
 *  suficiente para OCR de texto impresso de prova sem gerar imagens
 *  gigantescas. Reduzida automaticamente (nunca aumentada) se a página
 *  exceder os limites de dimensão/pixels abaixo. */
export const OCR_RENDER_SCALE = 2;
export const OCR_MAX_DIMENSION_PX = 3000;
export const OCR_MAX_PIXELS = 6_000_000;
/** Seção 19 — nunca deixa uma única página travar o processo inteiro. */
export const OCR_PAGE_TIMEOUT_MS = 45_000;
/** Sprint 24.1, seção 19 — teto para o CARREGAMENTO do engine (worker+core
 *  WASM+traineddata), descoberto como uma lacuna real durante o teste
 *  adversarial de rede desta sprint: só `recognize()` tinha um teto antes
 *  disso. Maior que `OCR_PAGE_TIMEOUT_MS` porque inclui baixar e
 *  descomprimir ~4MB de assets na primeira chamada. */
export const OCR_WORKER_LOAD_TIMEOUT_MS = 60_000;

export class OcrCancelledError extends Error {
  constructor() {
    super("Reconhecimento de OCR cancelado pelo usuário.");
    this.name = "OcrCancelledError";
  }
}

/** Menor escala ainda aceitável para OCR — abaixo disso o texto renderizado
 *  fica ilegível o bastante para o engine nunca produzir nada confiável;
 *  preferível falhar a página do que gastar CPU num resultado inútil. */
const OCR_MIN_RENDER_SCALE = 0.2;

/** Seção 5 da ordem — reduz a escala de renderização (nunca aumenta)
 *  quando a página excederia os limites de dimensão/pixels — proteção
 *  contra um PDF hostil com `MediaBox` absurdo. `null` quando NENHUMA
 *  escala dentro do piso mínimo aceitável respeita os limites — a página
 *  é grande demais para renderizar com segurança, e a seção 5 exige
 *  fail-closed aqui (nunca uma imagem gigantesca, nunca um resultado
 *  ilegível silenciosamente aceito). Função pura, testável sem pdf.js/
 *  canvas real. */
export function boundedRenderScale(pageWidthPt: number, pageHeightPt: number, initialScale = OCR_RENDER_SCALE): number | null {
  let scale = initialScale;
  while (scale >= OCR_MIN_RENDER_SCALE) {
    const width = pageWidthPt * scale;
    const height = pageHeightPt * scale;
    if (width <= OCR_MAX_DIMENSION_PX && height <= OCR_MAX_DIMENSION_PX && width * height <= OCR_MAX_PIXELS) return scale;
    scale -= 0.25;
  }
  return null;
}

/** Converte a bounding box de UMA linha reconhecida (espaço de pixel do
 *  canvas, origem superior-esquerda) para o ponto (x,y) no espaço nativo
 *  do PDF (origem inferior-esquerda, Y cresce para cima) — mesma
 *  convenção de `PdfTextLine`/`FlatLine` usada pelo resto do pipeline
 *  (seção 9 da ordem: "alimentar o MESMO pipeline", nunca um sistema de
 *  coordenadas paralelo). `y1` (base da caixa) é usado como referência —
 *  aproxima a linha de base do texto nativo com precisão suficiente para
 *  a associação espacial de `pdfEnemOcrFusion.ts`. */
export function canvasBboxToPdfPoint(bbox: { x0: number; y1: number }, scale: number, pageHeightPt: number): { x: number; y: number } {
  return { x: bbox.x0 / scale, y: pageHeightPt - bbox.y1 / scale };
}

interface RasterizedPage {
  canvas: HTMLCanvasElement;
  scale: number;
  pageHeightPt: number;
}

async function rasterizePage(page: pdfjsLib.PDFPageProxy): Promise<RasterizedPage> {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = boundedRenderScale(baseViewport.width, baseViewport.height);
  if (scale === null) {
    throw new Error("Página excede os limites seguros de renderização para OCR — dimensões da página fora do esperado.");
  }
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível criar contexto de canvas para renderizar a página.");
  const renderTask = page.render({ canvasContext: ctx, viewport, canvas });
  await renderTask.promise;
  return { canvas, scale, pageHeightPt: baseViewport.height };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Seção 4/5/9 da ordem — roda OCR (no navegador) SÓ nas páginas
 *  informadas (marcadas `needs_ocr`/`text_layer_partial` pelo worker numa
 *  chamada de preview anterior — nunca o documento inteiro por padrão,
 *  seção 2). Devolve linhas já em coordenadas de página PDF nativas,
 *  prontas para serem enviadas ao worker (`examOcrPages`/
 *  `answerKeyOcrPages` em `editorialClient.ts`) e fundidas com o texto
 *  nativo (`pdfEnemOcrFusion.ts`).
 *
 *  Seção 21/22 — `onProgress` é chamado antes de cada página (mensagem
 *  humana, nunca um score técnico); `signal` permite cancelamento real —
 *  ao abortar, o worker do Tesseract é terminado imediatamente (nunca
 *  deixa CPU rodando à toa), e qualquer `recognize()` em andamento rejeita
 *  com `OcrCancelledError`. */
export async function runOcrOnPages(
  pdfBytes: Uint8Array,
  pageNumbers: number[],
  options: { onProgress?: (event: OcrProgressEvent) => void; signal?: AbortSignal } = {}
): Promise<ClientOcrPageResult[]> {
  if (pageNumbers.length === 0) return [];
  if (pageNumbers.length > OCR_MAX_PAGES_PER_BATCH) {
    throw new Error(`OCR de ${pageNumbers.length} páginas excede o limite de ${OCR_MAX_PAGES_PER_BATCH} por lote.`);
  }
  if (options.signal?.aborted) throw new OcrCancelledError();

  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  let worker: TesseractWorker | null = null;

  const abortHandler = () => {
    void worker?.terminate();
  };
  options.signal?.addEventListener("abort", abortHandler);

  try {
    // Sprint 24.1, seção 19 da ordem — lacuna real encontrada no smoke em
    // navegador desta sprint: o carregamento do PDF (spawn do Worker do
    // pdf.js + handshake) não tinha NENHUM teto — uma falha rara de
    // inicialização do Worker travaria `runOcrOnPages` para sempre, mesmo
    // com os tetos de `createWorker`/`recognize()` já existentes. Agora
    // DENTRO do try/finally — mesmo um timeout aqui ainda libera
    // `loadingTask` corretamente.
    const doc = await withTimeout(loadingTask.promise, OCR_WORKER_LOAD_TIMEOUT_MS, "Tempo limite excedido ao carregar o PDF para OCR.");
    // Seção 19 da ordem — nunca deixa uma página travar o processo
    // inteiro: sem este teto, uma falha de carregamento do worker/core/
    // traineddata (ex.: rede instável, aba em segundo plano) travaria
    // `runOcrOnPages` indefinidamente — `recognize()` já tinha esse teto,
    // a fase de `createWorker()` (carregamento do engine) não tinha.
    worker = await withTimeout(
      createWorker("por", 1, {
        workerPath: TESSERACT_WORKER_PATH,
        corePath: TESSERACT_CORE_PATH,
        langPath: TESSERACT_LANG_PATH,
      }),
      OCR_WORKER_LOAD_TIMEOUT_MS,
      "Tempo limite excedido ao carregar o motor de OCR."
    );
    const results: ClientOcrPageResult[] = [];

    for (let index = 0; index < pageNumbers.length; index++) {
      if (options.signal?.aborted) throw new OcrCancelledError();
      const pageNumber = pageNumbers[index];
      options.onProgress?.({
        pageNumber,
        pageIndex: index,
        totalPages: pageNumbers.length,
        message: `Reconhecendo texto — página ${index + 1} de ${pageNumbers.length}…`,
      });

      const page = await doc.getPage(pageNumber);
      try {
        const { canvas, scale, pageHeightPt } = await rasterizePage(page);
        let recognized;
        try {
          recognized = await withTimeout(
            worker.recognize(canvas, {}, { blocks: true } as never),
            OCR_PAGE_TIMEOUT_MS,
            `Tempo limite de OCR excedido na página ${pageNumber}.`
          );
        } catch (error) {
          if (options.signal?.aborted) throw new OcrCancelledError();
          throw error;
        }
        if (options.signal?.aborted) throw new OcrCancelledError();

        const lines: ClientOcrLine[] = [];
        for (const block of recognized.data.blocks ?? []) {
          for (const paragraph of block.paragraphs) {
            for (const line of paragraph.lines) {
              const text = line.text.trim();
              if (!text) continue;
              const point = canvasBboxToPdfPoint(line.bbox, scale, pageHeightPt);
              lines.push({ x: point.x, y: point.y, text, confidencePercent: line.confidence });
            }
          }
        }
        results.push({ pageNumber, lines });
      } finally {
        page.cleanup();
      }
    }

    return results;
  } finally {
    options.signal?.removeEventListener("abort", abortHandler);
    await worker?.terminate().catch(() => undefined);
    await loadingTask.destroy();
  }
}
