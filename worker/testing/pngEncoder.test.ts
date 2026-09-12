import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { encodePng, MAX_IMAGE_DIMENSION_PX, MAX_IMAGE_PIXELS } from "../src/lib/pngEncoder";

/* Node não tem `CompressionStream` no mesmo runtime que o Worker usa, mas
   Node 18+ expõe a MESMA API Web Streams — usada aqui tal como o código de
   produção usa. Estes testes rodam via Vitest/Node puro (mesma limitação de
   ambiente documentada para o resto do projeto — sem vitest-pool-workers no
   Windows), e validam o PNG resultante decodificando o IDAT com
   `node:zlib` (só para o teste — nunca uma dependência do Worker). */

function readChunks(png: Uint8Array): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array>();
  let offset = 8; // pula assinatura
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const data = png.slice(offset + 8, offset + 8 + length);
    chunks.set(type, data);
    offset += 8 + length + 4; // header + data + CRC
  }
  return chunks;
}

describe("encodePng", () => {
  it("codifica RGB e produz PNG válido decodificável (bytes idênticos)", async () => {
    const width = 10;
    const height = 6;
    const data = new Uint8ClampedArray(width * height * 3);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;

    const result = await encodePng({ width, height, channels: "rgb", data });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Array.from(result.bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks = readChunks(result.bytes);
    expect(chunks.has("IHDR")).toBe(true);
    expect(chunks.has("IDAT")).toBe(true);
    expect(chunks.has("IEND")).toBe(true);

    const ihdr = chunks.get("IHDR")!;
    const ihdrView = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
    expect(ihdrView.getUint32(0)).toBe(width);
    expect(ihdrView.getUint32(4)).toBe(height);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(2); // color type truecolor

    const raw = zlib.inflateSync(Buffer.from(chunks.get("IDAT")!));
    const rowBytes = width * 3;
    expect(raw.length).toBe(height * (rowBytes + 1));
    for (let y = 0; y < height; y++) {
      expect(raw[y * (rowBytes + 1)]).toBe(0); // filtro None
      const rowData = raw.subarray(y * (rowBytes + 1) + 1, y * (rowBytes + 1) + 1 + rowBytes);
      const expectedRow = data.subarray(y * rowBytes, y * rowBytes + rowBytes);
      expect(Array.from(rowData)).toEqual(Array.from(expectedRow));
    }
  });

  it("codifica RGBA corretamente (color type 6)", async () => {
    const width = 4;
    const height = 4;
    const data = new Uint8ClampedArray(width * height * 4).fill(200);
    const result = await encodePng({ width, height, channels: "rgba", data });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chunks = readChunks(result.bytes);
    const ihdr = chunks.get("IHDR")!;
    expect(ihdr[8]).toBe(8);
    expect(ihdr[9]).toBe(6);
  });

  it("codifica escala de cinza 1bpp corretamente (color type 0, bit depth 1)", async () => {
    const width = 8;
    const height = 2;
    const rowBytes = Math.ceil(width / 8);
    const data = new Uint8ClampedArray(rowBytes * height);
    data[0] = 0b10101010;
    data[1] = 0b11110000;
    const result = await encodePng({ width, height, channels: "gray1bpp", data });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chunks = readChunks(result.bytes);
    const ihdr = chunks.get("IHDR")!;
    expect(ihdr[8]).toBe(1);
    expect(ihdr[9]).toBe(0);
    const raw = zlib.inflateSync(Buffer.from(chunks.get("IDAT")!));
    expect(raw.length).toBe(height * (rowBytes + 1));
  });

  it("rejeita dimensão acima do limite explícito (seção 16 da ordem)", async () => {
    const result = await encodePng({
      width: MAX_IMAGE_DIMENSION_PX + 1,
      height: 1,
      channels: "rgb",
      data: new Uint8ClampedArray(3),
    });
    expect(result).toEqual({ ok: false, reason: "dimension_exceeded" });
  });

  it("rejeita área total acima do limite mesmo com lados individualmente aceitáveis", async () => {
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 100;
    const result = await encodePng({ width: side, height: side, channels: "rgb", data: new Uint8ClampedArray(3) });
    expect(result).toEqual({ ok: false, reason: "dimension_exceeded" });
  });

  it("rejeita dimensões inválidas (zero/negativa/não-inteira)", async () => {
    expect(await encodePng({ width: 0, height: 10, channels: "rgb", data: new Uint8ClampedArray(0) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await encodePng({ width: 10, height: -1, channels: "rgb", data: new Uint8ClampedArray(0) })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejeita buffer de dados menor que o exigido por width/height/channels", async () => {
    const result = await encodePng({ width: 10, height: 10, channels: "rgb", data: new Uint8ClampedArray(5) });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
