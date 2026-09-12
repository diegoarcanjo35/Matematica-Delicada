/* Sprint 24 — testes das partes PURAS do módulo de OCR client-side (nunca
   exercitam tesseract.js/pdf.js real aqui — isso é validado separadamente
   via o smoke local com o PDF real escaneado, seção 26/27 da ordem, que
   não roda em CI/navegador headless). */

import { describe, expect, it } from "vitest";
import { boundedRenderScale, canvasBboxToPdfPoint, OCR_MAX_DIMENSION_PX, OCR_MAX_PIXELS, OCR_RENDER_SCALE, OcrCancelledError } from "./pdfOcr";

describe("boundedRenderScale — seção 5/19 da ordem (nunca gera imagem gigantesca)", () => {
  it("usa a escala inicial para uma página de tamanho normal (A4/carta)", () => {
    expect(boundedRenderScale(612, 792)).toBe(OCR_RENDER_SCALE);
  });

  it("reduz a escala para uma página moderadamente grande, dentro dos limites", () => {
    const scale = boundedRenderScale(2000, 2000);
    expect(scale).not.toBeNull();
    const width = 2000 * (scale as number);
    const height = 2000 * (scale as number);
    expect(width).toBeLessThanOrEqual(OCR_MAX_DIMENSION_PX);
    expect(height).toBeLessThanOrEqual(OCR_MAX_DIMENSION_PX);
    expect(width * height).toBeLessThanOrEqual(OCR_MAX_PIXELS);
  });

  it("nunca aumenta a escala além da inicial, mesmo para páginas minúsculas", () => {
    expect(boundedRenderScale(10, 10)).toBe(OCR_RENDER_SCALE);
  });

  it("falha fechado (null) para uma página absurdamente grande, nunca renderiza algo ilegível/gigante (seção 5 da ordem)", () => {
    expect(boundedRenderScale(100000, 100000)).toBeNull();
  });
});

describe("canvasBboxToPdfPoint — conversão de coordenadas canvas -> PDF nativo", () => {
  it("inverte o eixo Y (canvas cresce para baixo, PDF cresce para cima)", () => {
    const point = canvasBboxToPdfPoint({ x0: 100, y1: 50 }, 2, 800);
    // x0=100 em escala 2 -> 50pt; y1=50 em escala 2 -> 25px de baixo do
    // canvas -> pageHeight(400pt em escala 1, mas aqui pageHeightPt já é
    // em pontos nativos) - 25 = 375.
    expect(point.x).toBe(50);
    expect(point.y).toBe(800 - 25);
  });

  it("escala 1 é a identidade em X (sem qualquer fator de conversão)", () => {
    const point = canvasBboxToPdfPoint({ x0: 42, y1: 0 }, 1, 500);
    expect(point.x).toBe(42);
    expect(point.y).toBe(500);
  });
});

describe("OcrCancelledError — seção 21 da ordem (cancelamento real)", () => {
  it("é uma instância de Error com nome distinto, identificável por quem chama", () => {
    const error = new OcrCancelledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OcrCancelledError");
  });
});
