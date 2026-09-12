/* Extração de texto de PDF — Sprint 22, seção 3/4/7 da ordem.

   Biblioteca: `pdfjs-dist` (Mozilla, Apache-2.0, mantida — usada pelo
   próprio visualizador de PDF do Firefox). Build escolhido:
   `pdfjs-dist/legacy/build/pdf.mjs` — o mesmo usado por scripts Node, com
   fallback automático para um "fake worker" (execução síncrona na mesma
   thread) quando não há suporte a Worker dedicado real.

   Feasibility spike desta sprint (rodado localmente via `wrangler dev`,
   runtime workerd real — nunca só Node) provou que o build "legacy" NÃO
   funciona de imediato dentro de um Cloudflare Worker: `PDFWorker` só
   ativa o fallback de fake worker automaticamente quando `isNodeJS` é
   verdadeiro (workerd não é detectado como Node — não expõe `process`
   sem a flag `nodejs_compat`, que este projeto não usa). Sem o fallback,
   `getDocument()` lança `No "GlobalWorkerOptions.workerSrc" especificado`
   e, mesmo definindo um valor qualquer, tentaria abrir um `new
   Worker(...)` real (workerd não suporta Worker aninhado).

   A correção comprovada (sem fork nem patch do pacote): importar
   `pdfjs-dist/legacy/build/pdf.worker.mjs` (o módulo que faria o trabalho
   dentro de um Web Worker de verdade) no MESMO módulo — seu efeito
   colateral de carregamento é registrar `globalThis.pdfjsWorker =
   {WorkerMessageHandler}`. `PDFWorker._setupFakeWorkerGlobal` checa esse
   global ANTES de tentar qualquer `import()` dinâmico via `workerSrc` —
   encontrando-o, roda o parser inteiro em memória, na mesma thread do
   Worker, sem nunca precisar de um Worker aninhado real. Setar
   `GlobalWorkerOptions.workerSrc` para qualquer string não-vazia (nunca
   resolvida de fato) só existe para o getter de `PDFWorker.workerSrc` não
   lançar antes de chegar a este caminho.

   `useWorkerFetch:false` evita qualquer tentativa de rede. Nenhuma opção
   usada aqui permite carregar recurso externo, seguir link ou executar
   JavaScript embutido do PDF (seção 25 da ordem) — esta API só lê
   texto/estrutura. */

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { extractPageVisualElements, classifyDecorativeRasterElements, classifyDecorativeVectorCandidates, type RawVectorCandidate } from "./pdfEnemVisualExtractor";
import type { RawVisualElement } from "./pdfEnemVisualModel";

pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.mjs";

export const PDF_MAX_BYTES = 40 * 1024 * 1024; // 40MB — generoso para um caderno ENEM completo escaneado com camada de texto.
export const PDF_MAX_PAGES = 220; // ENEM tem no máximo ~90 páginas por caderno; folga ampla, nunca ilimitado.
export const PDF_MAX_TEXT_ITEMS_PER_PAGE = 4000; // proteção contra PDF hostil com milhões de glifos por página.

/** Seção 4 da ordem — limiar mínimo de texto REAL, em caracteres não-
 *  espaço, ACUMULADO no documento inteiro (nunca dividido por página) —
 *  um gabarito real e legítimo pode ser muito curto (poucas dezenas de
 *  linhas "136 C") e nunca deve disparar falso-positivo de needs_ocr só
 *  por ser um documento pequeno. Um PDF puramente escaneado (imagem da
 *  página, sem OCR) produz ZERO ou pouquíssimos caracteres via
 *  `getTextContent()`, não importa quantas páginas tenha — esse é o sinal
 *  real. Nunca usado por questão — só para o veredito GLOBAL needs_ocr. */
const MIN_NON_WHITESPACE_CHARS_TOTAL = 10;

export interface PdfTextLine {
  y: number;
  text: string;
}

export interface PdfPageText {
  pageNumber: number;
  width: number;
  height: number;
  lines: PdfTextLine[];
  /** Seção 9/10 da ordem — presença de QUALQUER objeto de imagem/traçado
   *  vetorial não-trivial na página, detectada via `getOperatorList()`
   *  (nunca renderizada — não há canvas disponível no runtime do Worker).
   *  Usada só como SINAL para marcar `visual_review_required`, nunca para
   *  extrair a imagem em si (ver relatório final: extração automática de
   *  imagem fica fora do escopo desta sprint). */
  hasVisualContent: boolean;
}

export type PdfExtractResult =
  | { ok: true; pageCount: number; pages: PdfPageText[]; visualElements: RawVisualElement[] }
  | { ok: false; reason: "invalid" | "too_large" | "too_many_pages" | "needs_ocr"; message: string };

const VISUAL_OPS_TO_DETECT: number[] = [
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintImageMaskXObject,
  pdfjsLib.OPS.paintImageXObjectRepeat,
];

/** Agrupa `TextItem`s em linhas por proximidade vertical (arredondamento
 *  do baseline Y, `transform[5]`) — nunca por ordem bruta de chegada
 *  (colunas/blocos do PDF podem intercalar itens de linhas diferentes).
 *  Uma linha é a concatenação, em ordem X crescente, dos itens cujo Y
 *  arredondado coincide. Este agrupamento é DETERMINÍSTICO (mesmos bytes
 *  de entrada sempre produzem a mesma saída) — pré-requisito para o apply
 *  poder re-extrair e comparar com o preview (seção 7 da ordem).
 *
 *  Sprint 22.1 — corrigido após o smoke com o PDF oficial real do ENEM
 *  2019: o caderno de questões usa DUAS COLUNAS por página (confirmado
 *  na prova real), e a versão anterior (que só agrupava por Y, ignorando
 *  X além de ordenar dentro da própria linha) intercalava texto da coluna
 *  esquerda com o da direita sempre que as duas tinham uma linha na MESMA
 *  altura — o que é quase sempre o caso em texto corrido de duas colunas.
 *  `detectColumnGutter` procura um vão vazio real (nenhum item começa
 *  ali) no terço central da página; se encontrado, cada coluna é
 *  agrupada em linhas SEPARADAMENTE (mesmo algoritmo por Y de antes) e a
 *  ordem de leitura final é coluna esquerda inteira (topo→rodapé) seguida
 *  da coluna direita inteira — nunca misturado por Y global. Páginas sem
 *  vão central detectável (capa/instruções, que usam largura cheia)
 *  continuam no modo de coluna única anterior — nunca forçamos um corte
 *  onde não existe. */
function groupItemsByY(items: Array<{ x: number; y: number; str: string }>): PdfTextLine[] {
  const buckets = new Map<number, Array<{ x: number; str: string }>>();
  for (const item of items) {
    const y = item.y;
    let bucketKey = y;
    for (const existingKey of buckets.keys()) {
      if (Math.abs(existingKey - y) <= 2) {
        bucketKey = existingKey;
        break;
      }
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.push(item);
    else buckets.set(bucketKey, [item]);
  }
  const lines: PdfTextLine[] = [];
  for (const [y, parts] of buckets.entries()) {
    parts.sort((a, b) => a.x - b.x);
    const text = parts
      .map((p) => p.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) lines.push({ y, text });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

/** Procura o maior vão vazio de posições X no terço central da página —
 *  sinal de um gutter real entre duas colunas impressas. `null` quando
 *  nenhum vão suficientemente largo existe (página de coluna única).
 *  Nunca um corte fixo hardcoded — sempre derivado dos dados reais da
 *  própria página. */
function detectColumnGutter(xs: number[], pageWidth: number): number | null {
  if (xs.length < 10 || pageWidth <= 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  let bestGapMid: number | null = null;
  let bestGapSize = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    const mid = (sorted[i] + sorted[i - 1]) / 2;
    if (mid > pageWidth * 0.35 && mid < pageWidth * 0.65 && gap > bestGapSize) {
      bestGapSize = gap;
      bestGapMid = mid;
    }
  }
  return bestGapSize > pageWidth * 0.03 ? bestGapMid : null;
}

function groupItemsIntoLines(items: Array<{ str: string; transform: number[] }>, pageWidth: number): PdfTextLine[] {
  const flat = items.filter((i) => i.str).map((i) => ({ x: i.transform[4], y: Math.round(i.transform[5]), str: i.str }));
  const gutter = detectColumnGutter(flat.map((i) => i.x), pageWidth);
  if (gutter === null) return groupItemsByY(flat);

  const left = flat.filter((i) => i.x < gutter);
  const right = flat.filter((i) => i.x >= gutter);
  return [...groupItemsByY(left), ...groupItemsByY(right)];
}

export async function extractPdfPages(bytes: Uint8Array): Promise<PdfExtractResult> {
  if (bytes.byteLength === 0) return { ok: false, reason: "invalid", message: "Arquivo PDF vazio." };
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { ok: false, reason: "too_large", message: `PDF excede o limite de ${PDF_MAX_BYTES} bytes.` };
  }

  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    disableFontFace: true,
    // Seção 25 da ordem — nunca segue links/recursos remotos embutidos;
    // nunca executa JavaScript/ação/formulário do PDF. Esta API só lê
    // texto/estrutura (getTextContent/getOperatorList) — pdf.js nunca
    // executa JavaScript embutido do PDF por conta própria; isso exigiria
    // chamar uma API de scripting dedicada que este código nunca invoca.
    // (`isEvalSupported`, opção de versões anteriores do pdfjs-dist para
    // desligar avaliação dinâmica em fluxos de cor/fonte, foi removida da
    // API pública nesta versão 6.3 — não existe mais o que desligar.)
    stopAtErrors: false,
  });

  let doc: Awaited<typeof loadingTask.promise>;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    return { ok: false, reason: "invalid", message: `PDF inválido ou corrompido: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    if (doc.numPages > PDF_MAX_PAGES) {
      return { ok: false, reason: "too_many_pages", message: `PDF excede o limite de ${PDF_MAX_PAGES} páginas.` };
    }

    const pages: PdfPageText[] = [];
    let totalNonWhitespaceChars = 0;
    const rasterElements: RawVisualElement[] = [];
    const vectorCandidates: RawVectorCandidate[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const [content, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
        const items = (content.items as Array<{ str?: string; transform: number[] }>)
          .filter((i): i is { str: string; transform: number[] } => typeof i.str === "string")
          .slice(0, PDF_MAX_TEXT_ITEMS_PER_PAGE);
        const viewport = page.getViewport({ scale: 1 });
        const lines = groupItemsIntoLines(items, viewport.width);

        let hasVisualContent = false;
        for (const fn of operatorList.fnArray) {
          if (VISUAL_OPS_TO_DETECT.includes(fn)) {
            hasVisualContent = true;
            break;
          }
        }

        for (const line of lines) totalNonWhitespaceChars += line.text.replace(/\s/g, "").length;

        pages.push({ pageNumber, width: viewport.width, height: viewport.height, lines, hasVisualContent });

        // Sprint 23, seção 1 da ordem — extração visual roda NA MESMA
        // passada, usando o MESMO `page`/`operatorList` já obtidos acima,
        // ANTES de `page.cleanup()` (obrigatório: `page.objs` deixa de
        // funcionar depois do cleanup). Uma segunda chamada a
        // `doc.getPage()` funcionaria, mas reabrir o documento inteiro
        // (`getDocument()` de novo) NÃO — o `data` de entrada é
        // transferido/esvaziado pela primeira chamada (mesmo bug de buffer
        // detachment documentado na Sprint 22 para o fingerprint SHA-256).
        const visual = await extractPageVisualElements(page, operatorList, pageNumber);
        rasterElements.push(...visual.rasterElements);
        vectorCandidates.push(...visual.vectorCandidates);
      } finally {
        page.cleanup();
      }
    }

    if (totalNonWhitespaceChars < MIN_NON_WHITESPACE_CHARS_TOTAL) {
      return {
        ok: false,
        reason: "needs_ocr",
        message: "Este PDF parece ser digitalizado e precisa de OCR. Ainda não pode ser importado automaticamente.",
      };
    }

    // Seção 5/6 da ordem — decisão de "decorativo/estrutural" só é possível
    // com o DOCUMENTO INTEIRO já extraído (precisa comparar entre páginas).
    classifyDecorativeRasterElements(rasterElements, doc.numPages);
    const decorativeVectorFingerprints = classifyDecorativeVectorCandidates(vectorCandidates, doc.numPages);
    for (let vectorIndex = 0; vectorIndex < vectorCandidates.length; vectorIndex++) {
      const candidate = vectorCandidates[vectorIndex];
      if (decorativeVectorFingerprints.get(candidate.fingerprint)) continue;
      // Candidatos vetoriais REAIS (não-decorativos) viram um elemento
      // visual de baixa-fidelidade (sem pixels, sem PNG — seção 6: mesmo
      // sem bitmap, força revisão) para poderem ser associados a uma
      // questão pelo MESMO mecanismo de posição usado para raster
      // (`pdfEnemVisualPlacement.ts`).
      rasterElements.push({
        id: `p${candidate.pageNumber}_vec_${vectorIndex}`,
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

    return { ok: true, pageCount: doc.numPages, pages, visualElements: rasterElements };
  } finally {
    await loadingTask.destroy();
  }
}
