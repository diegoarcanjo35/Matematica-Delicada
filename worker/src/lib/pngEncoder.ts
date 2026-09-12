/* Codificador PNG mínimo — Sprint 23, seção 2 da ordem.

   Escolha técnica (ver relatório da sprint): pdfjs-dist só expõe pixels JÁ
   DECODIFICADOS via `page.objs` (RGB/RGBA/escala de cinza crus,
   `Uint8ClampedArray`) — não há acesso público/documentado aos bytes
   originais do stream de imagem (JPEG etc.), então "Camada A" (bytes
   originais) da ordem não é viável sem módulos internos não exportados do
   pdfjs-dist (frágil entre versões, descartado). "Camada B" (recodificar os
   pixels decodificados) foi escolhida.

   ZERO dependências novas: o formato de compressão exigido pelo chunk IDAT
   do PNG é zlib (RFC 1950) — exatamente o que `CompressionStream("deflate")`
   produz nativamente no runtime do Worker (comprovado localmente via
   `wrangler dev` real: primeiros bytes 0x78 0x9C, round-trip exato). CRC32
   é uma tabela de 256 entradas trivial de gerar em runtime — sem
   dependência externa. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const writePromise = writer.write(bytes).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writePromise;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(type.split("").map((c) => c.charCodeAt(0)));
  const body = concatBytes([typeBytes, data]);
  return concatBytes([u32be(data.length), body, u32be(crc32(body))]);
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Formatos de pixel de entrada aceitos — espelham `pdfjsLib.ImageKind`
 *  (GRAYSCALE_1BPP/RGB_24BPP/RGBA_32BPP), única fonte real de pixels que o
 *  extrator de PDF produz (ver `pdfEnemVisualExtractor.ts`). Nunca aceitamos
 *  um `channels` arbitrário fora desta lista — evita codificar lixo. */
export type PngInputChannels = "gray1bpp" | "rgb" | "rgba";

export interface EncodePngInput {
  width: number;
  height: number;
  channels: PngInputChannels;
  /** Para `gray1bpp`: 1 bit por pixel, empacotado por linha (MSB primeiro),
   *  igual ao formato que o próprio pdfjs-dist usa para `GRAYSCALE_1BPP`.
   *  Para `rgb`/`rgba`: 3/4 bytes por pixel, sem padding entre pixels. */
  data: Uint8ClampedArray | Uint8Array;
}

const COLOR_TYPE_BY_CHANNELS: Record<PngInputChannels, number> = {
  gray1bpp: 0, // grayscale
  rgb: 2, // truecolor
  rgba: 6, // truecolor + alpha
};
const BIT_DEPTH_BY_CHANNELS: Record<PngInputChannels, number> = { gray1bpp: 1, rgb: 8, rgba: 8 };
const BYTES_PER_PIXEL_BY_CHANNELS: Record<PngInputChannels, number> = { gray1bpp: 0, rgb: 3, rgba: 4 };

/** Máximo de pixels aceitos por imagem — seção 16 da ordem (proteção contra
 *  decompression bomb / dimensão absurda). Escolhido generoso o bastante
 *  para qualquer imagem real de uma questão de prova (uma imagem de página
 *  inteira em alta resolução fica bem abaixo disto), mas finito: nunca
 *  aceitamos alocar um buffer de tamanho arbitrário vindo de um PDF não
 *  confiável. Ver também `MAX_IMAGE_DIMENSION_PX` — a checagem de dimensão
 *  roda ANTES desta, e ambas rodam antes de qualquer alocação de buffer de
 *  saída. */
export const MAX_IMAGE_PIXELS = 20_000_000; // ~20MP — ex.: 5000x4000
export const MAX_IMAGE_DIMENSION_PX = 10_000; // nenhum lado isolado absurdo mesmo com área total pequena

export type EncodePngResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "dimension_exceeded" | "invalid" };

/** Codifica pixels crus (já decodificados pelo pdfjs-dist) como PNG válido.
 *  Filtro de linha sempre "None" (0) — mais simples e determinístico;
 *  aceita ficar um pouco maior que um encoder com filtro adaptativo, o que
 *  é uma troca aceitável para não introduzir lógica extra não essencial
 *  nesta sprint. Nunca lê metadado externo, nunca segue referência —
 *  opera só sobre os bytes de pixel já em memória. */
export async function encodePng(input: EncodePngInput): Promise<EncodePngResult> {
  const { width, height, channels, data } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "invalid" };
  }
  if (width > MAX_IMAGE_DIMENSION_PX || height > MAX_IMAGE_DIMENSION_PX) return { ok: false, reason: "dimension_exceeded" };
  if (width * height > MAX_IMAGE_PIXELS) return { ok: false, reason: "dimension_exceeded" };

  const bitDepth = BIT_DEPTH_BY_CHANNELS[channels];
  const colorType = COLOR_TYPE_BY_CHANNELS[channels];

  const rowBytes = channels === "gray1bpp" ? Math.ceil(width / 8) : width * BYTES_PER_PIXEL_BY_CHANNELS[channels];
  if (data.length < rowBytes * height) return { ok: false, reason: "invalid" };

  // Monta o stream de scanlines com filtro "None" (byte 0) prefixado a cada linha.
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const srcOffset = y * rowBytes;
    const dstOffset = y * (rowBytes + 1);
    raw[dstOffset] = 0; // filter type None
    raw.set(data.subarray(srcOffset, srcOffset + rowBytes), dstOffset + 1);
  }

  const ihdr = concatBytes([u32be(width), u32be(height), new Uint8Array([bitDepth, colorType, 0, 0, 0])]);
  const idatData = await deflateZlib(raw);

  const png = concatBytes([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", new Uint8Array(0))]);
  return { ok: true, bytes: png };
}
