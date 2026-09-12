/* Extração de elementos visuais (imagens raster + candidatos vetoriais) do
   PDF da prova — Sprint 23, seções 1/3/5/6/16/17 da ordem.

   Investigação empírica desta sprint (rodada contra o PDF oficial real do
   ENEM 2019, 2º dia, Caderno 7 Azul, via Node E confirmada depois em
   `wrangler dev` real para a parte de codificação — ver pngEncoder.ts):

     1) `page.objs.get(objId, callback)` (pdfjs-dist 6.3.289) só expõe
        PIXELS JÁ DECODIFICADOS (`{width, height, kind, data:
        Uint8ClampedArray}` — `kind` é `pdfjsLib.ImageKind`: 1=escala de
        cinza 1bpp, 2=RGB 24bpp, 3=RGBA 32bpp). NÃO há acesso público aos
        bytes originais do stream (JPEG etc.) — os exports de
        `pdfjs-dist/legacy/build/pdf.mjs` não incluem `Ref`/`Stream`/`XRef`
        nem qualquer outra classe interna do núcleo. "Camada A" da ordem
        (bytes originais) foi descartada por isso — ver relatório da
        sprint.
     2) `page.objs.has(objId)` NÃO é confiável logo após `getOperatorList()`
        resolver em documentos de muitas páginas processadas em sequência
        (bug real observado: `has()` retornava `false` para imagens que
        SIM existiam, resolvendo poucos milissegundos depois) — por isso
        este módulo SEMPRE usa a resolução assíncrona por callback, nunca
        `has()` como guarda de disponibilidade.
     3) Nenhuma imagem se repete pelo MESMO objId entre páginas diferentes
        (cada página embute sua própria cópia) — então detecção de
        elemento decorativo/repetitivo (seção 5) precisa comparar o HASH
        do conteúdo decodificado, nunca o objId.
     4) Todas as páginas (inclusive páginas de texto corrido, sem nenhuma
        figura) emitem uma quantidade GRANDE de `constructPath` (100-800
        por página) — confirmado que os primeiros ops de cada página são
        BYTE-A-BYTE idênticos entre páginas diferentes (moldura/fundo
        estrutural repetido). Um limiar ingênuo de "quantidade de ops
        vetoriais" teria produzido falso-positivo generalizado. A
        detecção aqui usa o MESMO princípio estrutural do item 3: agrupa
        blocos de traçado por fingerprint das coordenadas LOCAIS (antes da
        CTM — por isso repete identicamente entre páginas mesmo com
        posição final diferente) e só os que NÃO se repetem
        estruturalmente entram como candidato real de "diagrama vetorial
        não preservável" (seção 6 — força `visualReviewRequired`, mesmo
        sem nenhum bitmap). */

import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { encodePng, type PngInputChannels } from "./pngEncoder";
import { sha256HexOfBytes } from "./crypto";
import { MAX_RASTER_ELEMENTS_PER_PAGE, MAX_VECTOR_CANDIDATES_PER_PAGE, type RawVisualElement } from "./pdfEnemVisualModel";

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function composeMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/** Bounding box, em espaço de página, de um retângulo local [x0,y0]-[x1,y1]
 *  transformado pela CTM ativa — usa os 4 cantos (nunca só 2), correto
 *  mesmo com rotação/inclinação na matriz. */
function transformedBBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): { x: number; y: number; width: number; height: number } {
  const corners = [applyMatrix(m, x0, y0), applyMatrix(m, x1, y0), applyMatrix(m, x0, y1), applyMatrix(m, x1, y1)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** FNV-1a 32-bit — NÃO criptográfico, só para agrupar traçados vetoriais
 *  repetidos (seção 5/6). Nunca usado como identidade de segurança —
 *  imagens raster usam SHA-256 real (`sha256HexOfBytes`). */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const IMAGE_KIND_TO_CHANNELS: Record<number, PngInputChannels> = {
  1: "gray1bpp",
  2: "rgb",
  3: "rgba",
};

/** Realm-safe: nunca `instanceof Float32Array`/`Float64Array` — mesmo
 *  motivo documentado em `buildRasterElement` (o operatorList do pdfjs-dist
 *  pode vir de outro realm/contexto de módulos; `ArrayBuffer.isView` é a
 *  checagem correta, `BYTES_PER_ELEMENT >= 4` descarta arrays de bytes). */
function isFloatTypedArrayLike(value: unknown): value is ArrayLike<number> {
  if (value === null || typeof value !== "object" || !ArrayBuffer.isView(value)) return false;
  const bytesPerElement = (value as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT;
  return typeof bytesPerElement === "number" && bytesPerElement >= 4;
}

const RESOLVE_OBJ_TIMEOUT_MS = 5000;

/** Resolve um objeto de imagem do pdfjs-dist com timeout explícito — um PDF
 *  hostil pode referenciar um objId que nunca resolve (ex.: decoder de
 *  codec não suportado travado internamente); nunca deixamos a extração
 *  pendurada indefinidamente (seção 17 da ordem — "qualquer decoder...
 *  deve ter limites explícitos"). */
function resolveImageObj(page: PDFPageProxy, objId: string): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, RESOLVE_OBJ_TIMEOUT_MS);
    try {
      page.objs.get(objId, (value: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      }
    }
  });
}

interface RawVectorCandidate {
  pageNumber: number;
  fingerprint: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageVisualExtractionResult {
  rasterElements: RawVisualElement[];
  vectorCandidates: RawVectorCandidate[];
}

const RASTER_OPS_SET = new Set<number>([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintImageXObjectRepeat,
  pdfjsLib.OPS.paintInlineImageXObject,
]);

/** Área mínima (em pontos²) para um traçado vetorial contar como candidato
 *  — filtra ruído (sublinhados curtos, marcas de pontuação desenhadas como
 *  path). Não é uma classificação de conteúdo, só uma pré-filtragem de
 *  tamanho antes da checagem de repetição estrutural. */
const MIN_VECTOR_CANDIDATE_AREA_PT2 = 25; // ~5x5pt — bem menor que qualquer figura real, generoso o bastante para não descartar traços finos de diagrama.

/** Percorre o operatorList de UMA página já obtida (mesmo objeto usado por
 *  `pdfEnemExtractor.ts` para o texto, ANTES de `page.cleanup()`) e produz
 *  elementos raster resolvidos (com PNG codificado + hash) e candidatos
 *  vetoriais (fingerprint local + bbox em espaço de página, decisão de
 *  "decorativo" feita depois, no nível do documento inteiro — ver
 *  `classifyDecorativeVisualElements`). */
export async function extractPageVisualElements(
  page: PDFPageProxy,
  operatorList: { fnArray: number[]; argsArray: unknown[] },
  pageNumber: number
): Promise<PageVisualExtractionResult> {
  const rasterElements: RawVisualElement[] = [];
  const vectorCandidates: RawVectorCandidate[] = [];

  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let rasterCount = 0;
  let vectorCount = 0;

  const { fnArray, argsArray } = operatorList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === pdfjsLib.OPS.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === pdfjsLib.OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (fn === pdfjsLib.OPS.transform && Array.isArray(args) && args.length === 6) {
      ctm = composeMatrix(args as Matrix, ctm);
      continue;
    }
    if (fn === pdfjsLib.OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrixArg = Array.isArray(args) ? args[0] : undefined;
      if (Array.isArray(matrixArg) && matrixArg.length === 6) ctm = composeMatrix(matrixArg as Matrix, ctm);
      continue;
    }
    if (fn === pdfjsLib.OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }

    if (fn === pdfjsLib.OPS.paintImageMaskXObject || fn === pdfjsLib.OPS.paintImageMaskXObjectRepeat) {
      // Seção 17/6 da ordem — máscara de imagem (stencil, colorida pela cor
      // de preenchimento ativa) detectada, mas NUNCA colorizada/recodificada
      // automaticamente nesta v1 (risco real de cor errada sem uma forma
      // confiável de testar contra dado real — nenhuma máscara foi
      // observada no PDF oficial usado nesta sprint). Reportada como
      // `detected_not_extractable`, nunca descartada silenciosamente.
      if (rasterCount < MAX_RASTER_ELEMENTS_PER_PAGE) {
        rasterCount++;
        const bbox = transformedBBox(ctm, 0, 0, 1, 1);
        rasterElements.push({
          id: `p${pageNumber}_mask_${rasterCount}`,
          pageNumber,
          kind: "raster",
          ...bbox,
          sourceObjectId: Array.isArray(args) && typeof args[0] === "string" ? (args[0] as string) : undefined,
          hash: fnv1a(`mask:${pageNumber}:${rasterCount}`),
          extractionStatus: "detected_not_extractable",
          placementCandidate: "unknown",
          warnings: ["Máscara de imagem (stencil) detectada — não colorizada/extraída automaticamente nesta versão."],
        });
      }
      continue;
    }

    if (RASTER_OPS_SET.has(fn)) {
      if (rasterCount >= MAX_RASTER_ELEMENTS_PER_PAGE) continue;
      rasterCount++;
      const objId = Array.isArray(args) ? args[0] : undefined;
      const bbox = transformedBBox(ctm, 0, 0, 1, 1);
      const elementId = `p${pageNumber}_img_${rasterCount}`;

      if (typeof objId !== "string") {
        rasterElements.push({
          id: elementId,
          pageNumber,
          kind: "raster",
          ...bbox,
          hash: fnv1a(`unresolvable:${elementId}`),
          extractionStatus: "ambiguous",
          placementCandidate: "unknown",
          warnings: ["Imagem inline sem identificador de objeto resolvível nesta versão."],
        });
        continue;
      }

      const resolved = await resolveImageObj(page, objId);
      const element = await buildRasterElement(elementId, pageNumber, objId, bbox, resolved);
      rasterElements.push(element);
      continue;
    }

    if (fn === pdfjsLib.OPS.constructPath && Array.isArray(args) && vectorCount < MAX_VECTOR_CANDIDATES_PER_PAGE) {
      const opsCode = args[0];
      const coords = args[1];
      const localMinMax = args[2];
      if (!Array.isArray(localMinMax) && !isFloatTypedArrayLike(localMinMax)) continue;
      const [x0, y0, x1, y1] = Array.from(localMinMax as ArrayLike<number>);
      if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) continue;

      const bbox = transformedBBox(ctm, x0, y0, x1, y1);
      if (bbox.width * bbox.height < MIN_VECTOR_CANDIDATE_AREA_PT2) continue;

      vectorCount++;
      const coordsFlat = isFloatTypedArrayLike(coords)
        ? Array.from(coords)
        : Array.isArray(coords)
          ? coords.flatMap((c: unknown) => (isFloatTypedArrayLike(c) ? Array.from(c) : []))
          : [];
      const roundedCoords = coordsFlat.map((n: number) => Math.round(n * 10) / 10).join(",");
      const fingerprint = fnv1a(`${opsCode}|${roundedCoords}`);

      vectorCandidates.push({ pageNumber, fingerprint, ...bbox });
    }
  }

  return { rasterElements, vectorCandidates };
}

async function buildRasterElement(
  id: string,
  pageNumber: number,
  objId: string,
  bbox: { x: number; y: number; width: number; height: number },
  resolved: unknown
): Promise<RawVisualElement> {
  const base = { id, pageNumber, kind: "raster" as const, ...bbox, sourceObjectId: objId };

  if (!resolved || typeof resolved !== "object") {
    return { ...base, hash: fnv1a(`unresolved:${id}`), extractionStatus: "detected_not_extractable", placementCandidate: "unknown", warnings: ["Objeto de imagem não resolveu (timeout ou decoder indisponível)."] };
  }
  const obj = resolved as { width?: unknown; height?: unknown; kind?: unknown; data?: unknown };
  const width = obj.width;
  const height = obj.height;
  const kind = obj.kind;
  const data = obj.data;
  // Nunca `instanceof Uint8ClampedArray/Uint8Array` aqui — o pdfjs-dist
  // roda em seu próprio grafo de módulos (confirmado via teste real: o
  // ambiente de teste do Vitest isola módulos em outro realm/contexto
  // `vm`, produzindo um `Uint8ClampedArray` que É um array de bytes
  // legítimo mas FALHA um `instanceof` contra o `Uint8ClampedArray` global
  // deste módulo — mesmo tendo `constructor.name` idêntico). `
  // ArrayBuffer.isView` é a checagem correta entre realms; `BYTES_PER_ELEMENT
  // === 1` descarta arrays de 16/32 bits sem depender de identidade de
  // classe.
  const isByteArray = data !== null && typeof data === "object" && ArrayBuffer.isView(data) && (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1;
  if (typeof width !== "number" || typeof height !== "number" || typeof kind !== "number" || !isByteArray) {
    return { ...base, hash: fnv1a(`ambiguous:${id}`), extractionStatus: "ambiguous", placementCandidate: "unknown", warnings: ["Formato de imagem decodificada não reconhecido (nem RGB, RGBA ou escala de cinza 1bpp)."] };
  }
  const channels = IMAGE_KIND_TO_CHANNELS[kind];
  if (!channels) {
    return { ...base, hash: fnv1a(`ambiguous-kind:${id}`), extractionStatus: "ambiguous", placementCandidate: "unknown", warnings: [`Tipo de imagem decodificada não suportado (kind=${kind}).`] };
  }

  const byteView = data as Uint8ClampedArray | Uint8Array;
  const hash = await sha256HexOfBytes(new Uint8Array(byteView.buffer, byteView.byteOffset, byteView.byteLength));
  const encoded = await encodePng({ width, height, channels, data: byteView });
  if (!encoded.ok) {
    return { ...base, hash, extractionStatus: "detected_not_extractable", placementCandidate: "unknown", warnings: [`Imagem excede limites seguros de dimensão/área (${encoded.reason}).`] };
  }

  return {
    ...base,
    mime: "image/png",
    byteLength: encoded.bytes.byteLength,
    hash,
    extractionStatus: "extracted",
    placementCandidate: "unknown",
    warnings: [],
    pngBytes: encoded.bytes,
  };
}

/** Seção 5/6 da ordem — decisão de "decorativo/estrutural" tomada no nível
 *  do DOCUMENTO INTEIRO (nunca por página isolada): um elemento (raster ou
 *  vetorial) que repete o MESMO hash/fingerprint em uma fração relevante
 *  das páginas do documento é estrutural (moldura, cabeçalho/rodapé, ícone
 *  fixo), nunca conteúdo real de uma questão específica. Limiar DINÂMICO
 *  (nunca uma contagem fixa arbitrária): pelo menos 3 páginas distintas E
 *  pelo menos 15% do total de páginas — os dois exigidos ao mesmo tempo,
 *  para não classificar como decorativo algo que só por coincidência
 *  aparece 3 vezes num documento de 4 páginas. Documentos de 1-2 páginas
 *  nunca acionam o filtro (nada pode ser "repetitivo" sem repetição real).
 *  Na dúvida (repetição fraca, perto do limiar), a decisão erra para o
 *  lado de NÃO ignorar — seção 5: "se dúvida: não ignorar silenciosamente"
 *  (ver `PRECISÃO > COBERTURA`, princípio central desta sprint). */
export function isStructurallyRepeated(distinctPageCount: number, totalPages: number): boolean {
  if (totalPages < 3) return false;
  const minPages = Math.max(3, Math.ceil(totalPages * 0.15));
  return distinctPageCount >= minPages;
}

export function classifyDecorativeVectorCandidates(candidates: RawVectorCandidate[], totalPages: number): Map<string, boolean> {
  const pagesByFingerprint = new Map<string, Set<number>>();
  for (const c of candidates) {
    const set = pagesByFingerprint.get(c.fingerprint) ?? new Set<number>();
    set.add(c.pageNumber);
    pagesByFingerprint.set(c.fingerprint, set);
  }
  const decorative = new Map<string, boolean>();
  for (const [fingerprint, pages] of pagesByFingerprint.entries()) {
    decorative.set(fingerprint, isStructurallyRepeated(pages.size, totalPages));
  }
  return decorative;
}

export function classifyDecorativeRasterElements(elements: RawVisualElement[], totalPages: number): void {
  const pagesByHash = new Map<string, Set<number>>();
  for (const el of elements) {
    if (el.extractionStatus !== "extracted") continue;
    const set = pagesByHash.get(el.hash) ?? new Set<number>();
    set.add(el.pageNumber);
    pagesByHash.set(el.hash, set);
  }
  for (const el of elements) {
    if (el.extractionStatus !== "extracted") continue;
    const pages = pagesByHash.get(el.hash)!;
    if (isStructurallyRepeated(pages.size, totalPages)) {
      el.extractionStatus = "ignored_decorative";
      el.warnings.push(`Mesmo conteúdo de imagem detectado em ${pages.size} páginas — tratado como elemento decorativo/estrutural.`);
    }
  }
}

export type { RawVectorCandidate };
