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
import { fusePageLines, looksTabularOcrRegion } from "./pdfEnemOcrFusion";
import { MAX_OCR_PAGES_PER_BATCH, MAX_OCR_LINES_PER_PAGE, MAX_OCR_TEXT_LENGTH_PER_LINE } from "./pdfEnemOcrModel";
import type { OcrPageInput, PageQualityDiagnostic, PageTextQualityState } from "./pdfEnemOcrModel";

pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.mjs";

export const PDF_MAX_BYTES = 40 * 1024 * 1024; // 40MB — generoso para um caderno ENEM completo escaneado com camada de texto.
export const PDF_MAX_PAGES = 220; // ENEM tem no máximo ~90 páginas por caderno; folga ampla, nunca ilimitado.
export const PDF_MAX_TEXT_ITEMS_PER_PAGE = 4000; // proteção contra PDF hostil com milhões de glifos por página.

/** Sprint 24, seção 3 da ordem — um glifo solto (ex.: um número de página
 *  isolado, um artefato de fonte) nunca conta como "esta página tem texto
 *  nativo real" — evita que uma página quase-em-branco-mas-tecnicamente-
 *  com-um-caractere passe como `text_layer_good` por acidente. */
const PAGE_TEXT_NOISE_FLOOR_CHARS = 2;

/** Sprint 24, seção 3 da ordem — proporção mínima de páginas com texto real
 *  (acima do piso de ruído acima) para o documento inteiro ser considerado
 *  "nativo, funcionando" — páginas isoladas com zero/pouco texto nesse
 *  contexto são tratadas como capa/folha em branco/página só-gráfica
 *  LEGÍTIMAS (seção 3: "não exigir que toda página tenha texto"), nunca
 *  disparam OCR sozinhas. Um documento ONDE A MAIORIA das páginas está
 *  vazia é, ao contrário, o sinal real de PDF escaneado sem camada de
 *  texto. Substitui o limiar antigo (Sprint 22), que olhava só o total
 *  acumulado do documento inteiro — preserva o mesmo comportamento para um
 *  gabarito curto e 100% nativo (qualquer página com texto real, por menor
 *  que seja, nunca precisa de OCR) e para um PDF totalmente escaneado
 *  (nenhuma página tem texto real → nenhuma passa), mas agora também
 *  resolve OCR por página individual em documentos híbridos (seção 4). */
const DOCUMENT_NATIVE_PROPORTION_THRESHOLD = 0.5;

export interface PdfTextLine {
  y: number;
  text: string;
  /** Sprint 24 — origem da linha. Ausente/`"native"` para todo o texto já
   *  extraído nativamente (comportamento de todas as sprints anteriores,
   *  nunca alterado); `"ocr"` só existe em linhas fundidas a partir de
   *  `OcrPageInput` fornecido pelo cliente (seção 4/9/12 da ordem). Campo
   *  OPCIONAL deliberadamente — nenhum código/teste existente que construía
   *  `PdfTextLine` sem este campo precisa mudar. */
  source?: "native" | "ocr";
  /** Só presente quando `source==='ocr'` — confiança bruta do engine
   *  (0-100). Nunca inventada para linhas nativas (ausência = confiança
   *  total implícita do texto vetorial real do PDF). */
  confidencePercent?: number;
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
  | { ok: true; pageCount: number; pages: PdfPageText[]; visualElements: RawVisualElement[]; pageDiagnostics: PageQualityDiagnostic[]; ocrWarnings: string[]; tabularPageNumbers: number[] }
  | { ok: false; reason: "invalid" | "too_large" | "too_many_pages" | "needs_ocr"; message: string; pagesNeedingOcr?: number[] };

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
 *  onde não existe.
 *
 *  Sprint 24, seção 10 da ordem — investigação contra o PDF oficial 2019
 *  (Caderno 7 Azul) encontrou um segundo bug real: em algumas páginas, um
 *  valor solto de uma TABELA vizinha (ex.: um potencial de redução de uma
 *  questão de química anterior) cai, por coincidência de arredondamento,
 *  na MESMA faixa Y do item de cabeçalho "Questão N" seguinte — os dois
 *  acabam no MESMO bucket e viram uma única linha fundida ("− −0,73
 *  Questão 93"), que nunca bate no início com "QUESTÃO" e faz o cabeçalho
 *  ser engolido pelo enunciado da questão anterior (mesma família de
 *  sintoma de "QUESTÃO 149"/"QUESTÃO 172", mas causada por uma fusão
 *  DENTRO da mesma coluna, não entre colunas). Corrigido na ORIGEM: um
 *  item de texto cujo conteúdo PRÓPRIO (antes de qualquer fusão) já é
 *  EXATAMENTE "Questão N" (nada mais — o formato real de heading do ENEM,
 *  sempre um run de texto isolado) nunca entra no bucket compartilhado —
 *  sempre vira sua própria linha, imune a qualquer colisão de Y com
 *  conteúdo de outra origem. Nunca aplicado ao restante do texto (só ao
 *  item que JÁ é, sozinho, um cabeçalho completo). */
const ISOLATED_HEADING_RE = /^QUEST(?:ÃO|AO)\s+0*[1-9]\d{0,2}$/i;

function groupItemsByY(items: Array<{ x: number; y: number; str: string }>): PdfTextLine[] {
  const buckets = new Map<number, Array<{ x: number; str: string }>>();
  const isolatedHeadingLines: PdfTextLine[] = [];
  for (const item of items) {
    if (ISOLATED_HEADING_RE.test(item.str.trim())) {
      isolatedHeadingLines.push({ y: item.y, text: item.str.trim() });
      continue;
    }
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
  const lines: PdfTextLine[] = [...isolatedHeadingLines];
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

/** Sprint 24, seção 10 da ordem — investigação real contra o PDF oficial
 *  ENEM 2019 (Caderno 7 Azul) encontrou a causa raiz de "QUESTÃO 149" e
 *  "QUESTÃO 172" nunca serem detectadas: a versão anterior (Sprint 22.1)
 *  procurava o MAIOR VÃO VAZIO entre posições X adjacentes na faixa
 *  central da página. Na página real, um diagrama embutido na questão
 *  ANTERIOR (rótulos como "d = 40 cm", "sendo que", "π.") tem suas
 *  legendas de texto espalhadas horizontalmente exatamente na faixa onde
 *  o gutter deveria estar — isso fragmenta qualquer vão único grande o
 *  bastante para passar do limiar, e o algoritmo concluía "página de
 *  coluna única", fundindo o cabeçalho "Questão 149" (coluna direita) na
 *  MESMA linha lida do cabeçalho "Questão 147" (coluna esquerda) — a causa
 *  exata do cabeçalho nunca ser reconhecido como início de questão.
 *
 *  Correção estrutural (nunca por página/conteúdo específico, nunca uma
 *  lista de exceções): em vez do maior vão isolado, procura a posição X
 *  que MAIS SE REPETE em cada metade da página. A margem de uma coluna de
 *  texto corrido real é usada por DEZENAS de linhas (cada nova linha da
 *  mesma coluna começa exatamente no mesmo X); uma legenda de diagrama
 *  aparece isolada, quase sempre num X que nunca se repete. Um rótulo
 *  perdido no meio da página nunca vence duas margens de coluna genuínas
 *  nesta contagem de frequência — robusto a ruído sem precisar conhecer o
 *  conteúdo da página. `null` quando nenhuma das duas metades tem uma
 *  margem repetida com confiança (página de coluna única). */
function detectColumnGutter(xs: number[], pageWidth: number): number | null {
  if (xs.length < 10 || pageWidth <= 0) return null;

  const frequency = new Map<number, number>();
  for (const x of xs) {
    const bucket = Math.round(x); // tolera jitter de sub-ponto do PDF; nunca agrupa margens realmente distintas.
    frequency.set(bucket, (frequency.get(bucket) ?? 0) + 1);
  }

  const half = pageWidth / 2;
  let leftX: number | null = null;
  let leftCount = 0;
  let rightX: number | null = null;
  let rightCount = 0;
  for (const [x, count] of frequency.entries()) {
    if (x < half && count > leftCount) {
      leftCount = count;
      leftX = x;
    }
    if (x >= half && count > rightCount) {
      rightCount = count;
      rightX = x;
    }
  }

  // Exige repetição real (uma margem de coluna genuína é usada por várias
  // linhas) — descarta qualquer "moda" acidental de 1-2 itens soltos (ex.:
  // uma legenda de diagrama que por acaso repete um X duas vezes).
  const MIN_MARGIN_REPETITION = 3;
  if (leftX === null || rightX === null || leftCount < MIN_MARGIN_REPETITION || rightCount < MIN_MARGIN_REPETITION) return null;

  // Sprint 24 — a margem esquerda "real" de uma coluna pode ter mais de um
  // valor legítimo (texto corrido vs. marcador de alternativa indentado
  // diferente, por exemplo x=30 vs x=40) — o ponto médio entre as duas
  // MARGENS INICIAIS (nunca entre onde o texto "termina") não precisa cair
  // perto do centro geométrico da página; só precisa separar corretamente
  // os itens de cada lado. `leftX`/`rightX` já são, por construção, um de
  // cada metade da página — só resta uma checagem ampla contra um split
  // absurdo (ex.: bem na margem física da página) e uma separação mínima
  // real entre as duas margens.
  if (rightX - leftX <= pageWidth * 0.03) return null; // margens grudadas demais para serem duas colunas reais.
  const mid = (leftX + rightX) / 2;
  if (mid <= pageWidth * 0.1 || mid >= pageWidth * 0.9) return null;
  return mid;
}

/** Hotfix pós-Sprint 24.1 — investigação real contra o PDF oficial ENEM
 *  2024 (2º dia, Caderno 5, Amarelo) encontrou um item de texto novo,
 *  inexistente no PDF 2019 usado nas sprints anteriores: uma marca d'água
 *  de segurança impressa como texto REAL do PDF — um item ISOLADO cuja
 *  string inteira é um trecho curto repetido dezenas de vezes seguidas
 *  (ex.: "ENEM2024ENEM2024ENEM2024..."). Esse item fica posicionado numa
 *  faixa Y fixa perto da margem da página e, por coincidência, cai no
 *  MESMO bucket de `groupItemsByY` de conteúdo real vizinho (rodapé de
 *  identidade, última alternativa de uma questão) — fundindo os dois numa
 *  única linha ilegível (mesma classe de bug já corrigida nesta sprint
 *  para colisão de cabeçalho isolado, agora para marca d'água).
 *
 *  Correção estrutural (nunca amarrada a "ENEM2024"/2024 — funciona para
 *  qualquer ano/padrão futuro de marca d'água repetida): um item cuja
 *  string inteira é um trecho de 2-24 caracteres repetido pelo menos 10
 *  vezes seguidas nunca é texto real de prova (nenhuma palavra/frase
 *  legítima em português se repete assim) — excluído ANTES de qualquer
 *  agrupamento por linha, nunca deixado fundir com conteúdo real.
 *
 *  Correção pós-cc3737b (auditoria): o regex original não estava ancorado
 *  no final (`$` ausente), então um item MISTO — "[marca d'água repetida
 *  10x][texto legítimo]" — também batia no padrão pelo PREFIXO e o item
 *  inteiro era descartado, inclusive o texto real que vinha depois.
 *  Fail-closed exige o oposto: só descartar quando a STRING INTEIRA, do
 *  início ao fim, é a repetição — nunca um prefixo. Um item corrompido no
 *  meio da repetição (ex.: glitch de encoding do PDF) deixa de casar por
 *  inteiro e agora é preservado (nunca descartado por engano) em vez de
 *  ser tolerado como antes — a perda de conteúdo real é sempre pior do que
 *  deixar passar um fragmento residual de marca d'água corrompida. */
const REPEATED_STAMP_TEXT_RE = /^(.{2,24}?)\1{9,}$/;

export function isRepeatedStampText(str: string): boolean {
  return REPEATED_STAMP_TEXT_RE.test(str);
}

function groupItemsIntoLines(items: Array<{ str: string; transform: number[] }>, pageWidth: number): PdfTextLine[] {
  const flat = items.filter((i) => i.str && !isRepeatedStampText(i.str)).map((i) => ({ x: i.transform[4], y: Math.round(i.transform[5]), str: i.str }));
  const gutter = detectColumnGutter(flat.map((i) => i.x), pageWidth);
  if (gutter === null) return groupItemsByY(flat);

  const left = flat.filter((i) => i.x < gutter);
  const right = flat.filter((i) => i.x >= gutter);
  return [...groupItemsByY(left), ...groupItemsByY(right)];
}

function nonWhitespaceCharCount(lines: PdfTextLine[]): number {
  let total = 0;
  for (const line of lines) total += line.text.replace(/\s/g, "").length;
  return total;
}

/** Sprint 24, seção 3 da ordem — classifica CADA página do documento já
 *  extraído (só camada nativa) em um estado de qualidade de texto, usando
 *  o CONTEXTO do documento inteiro (nunca um limiar isolado por página) —
 *  ver comentário de `DOCUMENT_NATIVE_PROPORTION_THRESHOLD` acima. Função
 *  pura, sem I/O — testável isoladamente. */
export function classifyPageTextQuality(pages: PdfPageText[]): PageQualityDiagnostic[] {
  const raw = pages.map((p) => ({ pageNumber: p.pageNumber, chars: nonWhitespaceCharCount(p.lines), hasVisualContent: p.hasVisualContent }));
  const totalPages = raw.length;
  const substantivePages = raw.filter((p) => p.chars > PAGE_TEXT_NOISE_FLOOR_CHARS).length;
  const documentLooksNative = totalPages > 0 && substantivePages / totalPages >= DOCUMENT_NATIVE_PROPORTION_THRESHOLD;

  return raw.map((p) => {
    if (p.chars > PAGE_TEXT_NOISE_FLOOR_CHARS) {
      return { pageNumber: p.pageNumber, state: "text_layer_good" as const, nonWhitespaceChars: p.chars, hasVisualContent: p.hasVisualContent, ocrApplied: false };
    }
    // Seção 3 da ordem — "existência de conteúdo visual/renderizado sem
    // texto correspondente" é sinal FORTE de página fotografada/escaneada
    // (uma imagem cheia de página, sem nenhum texto real) — sempre
    // `needs_ocr`, mesmo num documento cujas outras páginas estejam ótimas
    // (nunca "diluído" pela proporção do documento: ao contrário de uma
    // capa/página em branco de verdade, aqui HÁ conteúdo renderizado, só
    // não tem texto — exatamente o padrão que esta sprint existe para
    // tratar). Só a ausência de QUALQUER conteúdo (nem texto, nem visual)
    // é que pode ser uma página legitimamente em branco/divisória — aí sim
    // o contexto do documento decide.
    if (p.hasVisualContent) {
      return { pageNumber: p.pageNumber, state: "needs_ocr" as const, nonWhitespaceChars: p.chars, hasVisualContent: p.hasVisualContent, ocrApplied: false };
    }
    if (documentLooksNative) {
      return { pageNumber: p.pageNumber, state: "text_layer_good" as const, nonWhitespaceChars: p.chars, hasVisualContent: p.hasVisualContent, ocrApplied: false };
    }
    const state: PageTextQualityState = p.chars > 0 ? "text_layer_partial" : "needs_ocr";
    return { pageNumber: p.pageNumber, state, nonWhitespaceChars: p.chars, hasVisualContent: p.hasVisualContent, ocrApplied: false };
  });
}

export async function extractPdfPages(bytes: Uint8Array, ocrPages?: OcrPageInput[]): Promise<PdfExtractResult> {
  if (bytes.byteLength === 0) return { ok: false, reason: "invalid", message: "Arquivo PDF vazio." };
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { ok: false, reason: "too_large", message: `PDF excede o limite de ${PDF_MAX_BYTES} bytes.` };
  }
  // Seção 19 da ordem — revalidação fail-closed do lado do worker, nunca
  // confia só no cliente ter respeitado os próprios limites de OCR.
  if (ocrPages && ocrPages.length > MAX_OCR_PAGES_PER_BATCH) {
    return { ok: false, reason: "invalid", message: `Envio de OCR excede o limite de ${MAX_OCR_PAGES_PER_BATCH} páginas por lote.` };
  }
  for (const page of ocrPages ?? []) {
    if (page.lines.length > MAX_OCR_LINES_PER_PAGE) {
      return { ok: false, reason: "invalid", message: `Página ${page.pageNumber} do OCR excede o limite de ${MAX_OCR_LINES_PER_PAGE} linhas.` };
    }
    for (const line of page.lines) {
      if (line.text.length > MAX_OCR_TEXT_LENGTH_PER_LINE) {
        return { ok: false, reason: "invalid", message: `Uma linha de OCR na página ${page.pageNumber} excede o limite de ${MAX_OCR_TEXT_LENGTH_PER_LINE} caracteres.` };
      }
    }
  }
  const ocrPagesByNumber = new Map<number, OcrPageInput>((ocrPages ?? []).map((p) => [p.pageNumber, p]));

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

    // Sprint 24, seções 2/3/4/9 da ordem — pipeline "tentar nativo →
    // medir qualidade → só se insuficiente, OCR", agora POR PÁGINA (nunca
    // mais um veredito único para o documento inteiro). Páginas cujo
    // estado não é `text_layer_good` e para as quais o cliente ainda não
    // enviou OCR ficam pendentes — o documento inteiro só falha com
    // `needs_ocr` quando SOBRA pelo menos uma página pendente ao final
    // desta passada (permite documentos híbridos: algumas páginas boas,
    // outras precisando de OCR, seção 4 da ordem).
    const pageDiagnostics = classifyPageTextQuality(pages);
    const pagesNeedingOcr: number[] = [];
    const ocrWarnings: string[] = [];
    const tabularPageNumbers: number[] = [];

    for (let i = 0; i < pages.length; i++) {
      const diagnostic = pageDiagnostics[i];
      if (diagnostic.state === "text_layer_good") continue;

      const ocrPage = ocrPagesByNumber.get(diagnostic.pageNumber);
      if (!ocrPage || ocrPage.lines.length === 0) {
        pagesNeedingOcr.push(diagnostic.pageNumber);
        continue;
      }

      const fusion = fusePageLines(pages[i].lines, ocrPage.lines);
      pages[i] = { ...pages[i], lines: fusion.lines };
      diagnostic.ocrApplied = true;
      if (fusion.hasAmbiguousOverlap) {
        ocrWarnings.push(`Página ${diagnostic.pageNumber}: texto OCR sobreposto de forma ambígua ao texto nativo — revisar linhas dessa região.`);
      }
      if (looksTabularOcrRegion(ocrPage.lines)) {
        ocrWarnings.push(`Página ${diagnostic.pageNumber}: conteúdo reconhecido por OCR tem formato de tabela — revisão manual necessária (nunca convertido automaticamente).`);
        tabularPageNumbers.push(diagnostic.pageNumber);
      }
    }

    if (pagesNeedingOcr.length > 0) {
      return {
        ok: false,
        reason: "needs_ocr",
        message: `Este PDF tem ${pagesNeedingOcr.length} página(s) sem camada de texto utilizável (parecem digitalizadas). Reconheça o texto dessas páginas antes de continuar.`,
        pagesNeedingOcr,
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

    return { ok: true, pageCount: doc.numPages, pages, visualElements: rasterElements, pageDiagnostics, ocrWarnings, tabularPageNumbers };
  } finally {
    await loadingTask.destroy();
  }
}
