/* Hotfix pós-Sprint 24.1 — investigação real contra o PDF oficial ENEM
   2024 (2º dia, Caderno 5, Amarelo, nunca commitado). Cobre os dois bugs
   estruturais encontrados nesta edição: (1) marca d'água de segurança
   repetida como texto real do PDF, colidindo em Y com conteúdo real; (2)
   identidade documental (rodapé da prova sem dígito do dia; cabeçalho do
   gabarito espalhado em várias linhas). Nenhum teste aqui depende do ano
   2024 especificamente — os fixtures reproduzem o PADRÃO estrutural
   (repetição, ausência de campo, quebra em várias linhas), nunca o
   conteúdo literal de uma edição específica. */

import { describe, expect, it } from "vitest";
import { isRepeatedStampText, extractPdfPages } from "../src/lib/pdfEnemExtractor";
import { detectExamDocumentIdentity, detectAnswerKeyDocumentIdentity, checkDocumentIdentity } from "../src/lib/pdfEnemDocumentIdentity";
import type { PdfPageText } from "../src/lib/pdfEnemExtractor";
import { Errors } from "../src/lib/response";

describe("Errors.internal — seção 4 da ordem (erro genérico é bug também)", () => {
  it("toda resposta internal_error carrega um requestId correlacionável, nunca stack técnica", async () => {
    const response = Errors.internal("Erro interno. Tente novamente.");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string; requestId?: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Erro interno. Tente novamente.");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId!.length).toBeGreaterThan(0);
    // Nunca vaza detalhe técnico na mensagem exposta.
    expect(body.error.message).not.toMatch(/at \w+.*\(.*:\d+:\d+\)/); // formato de stack trace
  });

  it("dois requestId gerados em chamadas separadas nunca colidem (correlação precisa)", async () => {
    const r1 = await (Errors.internal().json() as Promise<{ error: { requestId: string } }>);
    const r2 = await (Errors.internal().json() as Promise<{ error: { requestId: string } }>);
    expect(r1.error.requestId).not.toBe(r2.error.requestId);
  });
});

describe("isRepeatedStampText — detecção estrutural de marca d'água (nunca amarrada a um ano)", () => {
  it("detecta um trecho curto repetido dezenas de vezes seguidas", () => {
    expect(isRepeatedStampText("ENEM2024".repeat(50))).toBe(true);
    expect(isRepeatedStampText("AB".repeat(20))).toBe(true);
  });

  it("tolera uma pequena variação no meio da repetição (ex.: glitch de encoding), desde que o início repita o suficiente", () => {
    const withGlitch = "ENEM2024".repeat(25) + "ENEM20E4" + "ENEM2024".repeat(20);
    expect(isRepeatedStampText(withGlitch)).toBe(true);
  });

  it("nunca marca texto real de prova como marca d'água", () => {
    expect(isRepeatedStampText("Qual componente celular foi afetado pela droga utilizada no experimento?")).toBe(false);
    expect(isRepeatedStampText("A Vacúolos.")).toBe(false);
    expect(isRepeatedStampText("QUESTÃO 91")).toBe(false);
    expect(isRepeatedStampText("º DIA • CADERNO 5 • AMARELO •")).toBe(false);
    expect(isRepeatedStampText("102 Anulado")).toBe(false);
  });

  it("nao marca uma repeticao curta (menos de 10 ocorrencias) — evita falso positivo em coincidencias pequenas", () => {
    expect(isRepeatedStampText("blablabla")).toBe(false); // "bla" só 3x
  });
});

describe("Filtro de marca d'água na extração — nunca deixa colidir com conteúdo real", () => {
  it("um item de texto que é só a marca d'água repetida nunca aparece na saída, mesmo colidindo em Y com uma linha real", () => {
    // Fixture de baixo nível: injeta manualmente um PDF com uma linha real
    // e um item de marca d'água na MESMA faixa Y (mesmo mecanismo de
    // colisão documentado no código de produção).
    // Unidade curta (2 caracteres) repetida muitas vezes — robusto mesmo
    // se o motor de layout do pdf.js truncar a string por causa da fonte
    // minimalista sem tabela de larguras real (limitação só desta fixture
    // de teste, nunca do PDF oficial real, que sempre vem com fonte
    // embutida completa — ver relatório do hotfix).
    const stamp = "AB".repeat(100);
    function pdfEscape(text: string): string {
      return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    }
    const lines = ["BT", "/F1 10 Tf", `1 0 0 1 40 100 Tm (${pdfEscape("D IV")}) Tj`, `1 0 0 1 300 100 Tm (${pdfEscape(stamp)}) Tj`, "ET"];
    const content = lines.join("\n");
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[4 0 R]/Count 1>>endobj\n3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 3 0 R>>>>/MediaBox[0 0 612 842]/Contents 5 0 R>>endobj\n5 0 obj<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\ntrailer<</Size 6/Root 1 0 R>>\n%%EOF\n`;
    const bytes = new TextEncoder().encode(pdf);

    return extractPdfPages(bytes).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const texts = result.pages[0].lines.map((l) => l.text);
      // A linha real sobrevive, isolada, nunca fundida com a marca d'água.
      expect(texts).toContain("D IV");
      expect(texts.some((t) => t.includes("ABAB"))).toBe(false);
    });
  });
});

describe("Identidade documental — tolerância a formatos de rodapé/cabeçalho diferentes entre edições", () => {
  function page(lines: string[]): PdfPageText {
    return { pageNumber: 1, width: 600, height: 800, hasVisualContent: false, lines: lines.map((text, i) => ({ y: 700 - i * 14, text })) };
  }

  it("detecta booklet+cor mesmo quando o dígito do dia está ausente do rodapé da prova", () => {
    const detected = detectExamDocumentIdentity([page(["º DIA • CADERNO 5 • AMARELO •"])]);
    expect(detected.bookletNumber).toBe(5);
    expect(detected.color).toBe("AMARELO");
    expect(detected.day).toBeUndefined(); // nunca inventado.
  });

  it("continua detectando o formato ORIGINAL (2019) sem nenhuma regressão", () => {
    const detected = detectExamDocumentIdentity([page(["CN - 2º dia | Caderno 7 - AZUL - Página 2"])]);
    expect(detected).toEqual({ day: 2, bookletNumber: 7, color: "AZUL" });
  });

  it("gabarito: detecta identidade espalhada em VÁRIAS linhas separadas (uma palavra por linha)", () => {
    const detected = detectAnswerKeyDocumentIdentity([page(["º", "2 dia", "CADERNO 5", "Amarelo", "Gabarito 2024"])]);
    expect(detected).toEqual({ day: 2, bookletNumber: 5, color: "AMARELO", year: 2024 });
  });

  it("gabarito: continua detectando o formato ORIGINAL (2019, duas linhas combinadas) sem nenhuma regressão", () => {
    const detected = detectAnswerKeyDocumentIdentity([page(["2o DIA - CADERNO 7", "AZUL Gabarito 2019"])]);
    expect(detected).toEqual({ day: 2, bookletNumber: 7, color: "AZUL", year: 2019 });
  });

  it("checkDocumentIdentity: campo ausente em um dos lados nunca bloqueia sozinho, mas também nunca confirma automaticamente sem os dois dias", () => {
    const examDetected = { bookletNumber: 5, color: "AMARELO" }; // dia ausente
    const keyDetected = { day: 2, bookletNumber: 5, color: "AMARELO", year: 2024 };
    const result = checkDocumentIdentity(examDetected, keyDetected, { year: 2024, application: "regular", booklet: "Caderno 5 Amarelo" });
    expect(result.ok).toBe(true); // nunca uma divergência real.
    expect(result.confirmedAutomatically).toBe(false); // nunca confirma sem o dia dos dois lados.
  });

  it("uma DIVERGÊNCIA real (cor diferente) continua bloqueando normalmente", () => {
    const examDetected = { bookletNumber: 5, color: "AMARELO" };
    const keyDetected = { day: 2, bookletNumber: 5, color: "AZUL", year: 2024 };
    const result = checkDocumentIdentity(examDetected, keyDetected, { year: 2024, application: "regular", booklet: "Caderno 5 Amarelo" });
    expect(result.ok).toBe(false);
  });
});
