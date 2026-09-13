// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  planWindows,
  splitPdfIntoWindowBytes,
  dedupQuestionsByCompleteness,
  filterPhantomQuestions,
  runClientPdfImportPipeline,
  remapElementId,
  type PdfWindowPlan,
} from "../../src/workers/pdfEnemImportPipeline";
import { extractPdfPages } from "../src/lib/pdfEnemExtractor";
import { segmentExamQuestions, type RawQuestionCandidate } from "../src/lib/pdfEnemSegmenter";
import { buildExamPdf, buildAnswerKeyPdf, buildFixturePdfWithVisuals, type FixturePageSpec } from "./pdfFixtureBuilder";

/* Sprint 24.2 — importador ENEM client-side. Suíte FOCADA (seção 19 da
   ordem, "não rodar suíte completa"): split local, overlap, dedup,
   remapeamento de página, capa sem questões fantasma, identidade,
   gabarito, anulada, visuais globais. Nunca usa PDF real (real 2024/2019
   são validados por scripts ad-hoc contra o PDF oficial baixado, nunca
   commitado — mesmo padrão já estabelecido nesta sessão). */

function baseCandidate(overrides: Partial<RawQuestionCandidate>): RawQuestionCandidate {
  return {
    originalNumber: 1,
    pageStart: 1,
    pageEnd: 1,
    statement: "Enunciado de teste.",
    alternatives: [
      { letter: "A", text: "A" },
      { letter: "B", text: "B" },
      { letter: "C", text: "C" },
      { letter: "D", text: "D" },
      { letter: "E", text: "E" },
    ],
    hasVisualContentOnPages: false,
    warnings: [],
    rawLineCount: 5,
    statementLocations: [],
    alternativeLocations: {},
    hasOcrText: false,
    ...overrides,
  };
}

describe("planWindows — janelamento interno (seção 3 da ordem)", () => {
  it("gera janelas de 8 páginas com overlap de 1, exatamente como o exemplo da ordem", () => {
    expect(planWindows(32, 8, 1)).toEqual([
      { windowIndex: 0, startPage: 1, endPage: 8 },
      { windowIndex: 1, startPage: 8, endPage: 15 },
      { windowIndex: 2, startPage: 15, endPage: 22 },
      { windowIndex: 3, startPage: 22, endPage: 29 },
      { windowIndex: 4, startPage: 29, endPage: 32 },
    ]);
  });

  it("documento menor que uma janela vira uma única janela", () => {
    expect(planWindows(5, 8, 1)).toEqual([{ windowIndex: 0, startPage: 1, endPage: 5 }]);
  });

  it("documento vazio não gera janela nenhuma", () => {
    expect(planWindows(0, 8, 1)).toEqual([]);
  });
});

describe("splitPdfIntoWindowBytes — cada janela vira um PDF válido e independente", () => {
  it("nunca corta página ao meio, nunca reordena", async () => {
    const pdf = buildExamPdf([1, 2, 3, 4], new Set([1, 2, 3]));
    const windows: PdfWindowPlan[] = [
      { windowIndex: 0, startPage: 1, endPage: 2 },
      { windowIndex: 1, startPage: 2, endPage: 4 },
    ];
    const parts = await splitPdfIntoWindowBytes(pdf, windows);
    expect(parts).toHaveLength(2);
    const extract0 = await extractPdfPages(parts[0]);
    const extract1 = await extractPdfPages(parts[1]);
    expect(extract0.ok && extract0.pageCount).toBe(2);
    expect(extract1.ok && extract1.pageCount).toBe(3);
  });
});

describe("dedupQuestionsByCompleteness — critérios exatos da seção 4 da ordem", () => {
  it("prefere a ocorrência com enunciado não vazio", () => {
    const empty = baseCandidate({ originalNumber: 5, statement: "" });
    const full = baseCandidate({ originalNumber: 5, statement: "Enunciado completo." });
    const { questions, warnings } = dedupQuestionsByCompleteness([empty, full]);
    expect(questions).toHaveLength(1);
    expect(questions[0].statement).toBe("Enunciado completo.");
    expect(warnings).toHaveLength(1);
  });

  it("prefere a ocorrência com 5 alternativas sobre uma com menos", () => {
    const partial = baseCandidate({ originalNumber: 7, alternatives: [{ letter: "A", text: "A" }] });
    const complete = baseCandidate({ originalNumber: 7 });
    const { questions } = dedupQuestionsByCompleteness([partial, complete]);
    expect(questions[0].alternatives).toHaveLength(5);
  });

  it("em empate estrutural, prefere quem tem conteúdo visual relacionado", () => {
    const noVisual = baseCandidate({ originalNumber: 9, hasVisualContentOnPages: false, pageStart: 3 });
    const withVisual = baseCandidate({ originalNumber: 9, hasVisualContentOnPages: true, pageStart: 4 });
    const { questions } = dedupQuestionsByCompleteness([noVisual, withVisual]);
    expect(questions[0].hasVisualContentOnPages).toBe(true);
  });

  it("em empate total, prefere menos warnings", () => {
    const moreWarnings = baseCandidate({ originalNumber: 11, warnings: ["a", "b"] });
    const fewerWarnings = baseCandidate({ originalNumber: 11, warnings: ["a"] });
    const { questions } = dedupQuestionsByCompleteness([moreWarnings, fewerWarnings]);
    expect(questions[0].warnings).toHaveLength(1);
  });

  it("em empate absoluto, prefere quem começou primeiro (menor pageStart)", () => {
    const later = baseCandidate({ originalNumber: 13, pageStart: 10 });
    const earlier = baseCandidate({ originalNumber: 13, pageStart: 3 });
    const { questions } = dedupQuestionsByCompleteness([later, earlier]);
    expect(questions[0].pageStart).toBe(3);
  });

  it("questão sem duplicata passa direto, sem warning", () => {
    const single = baseCandidate({ originalNumber: 20 });
    const { questions, warnings } = dedupQuestionsByCompleteness([single]);
    expect(questions).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});

describe("filterPhantomQuestions — seção 7 da ordem: nunca hardcoded por ano", () => {
  it("descarta números isolados de capa/instruções, mantém o cluster real (denso e populoso)", () => {
    const phantoms = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => baseCandidate({ originalNumber: n }));
    const real = Array.from({ length: 20 }, (_, i) => baseCandidate({ originalNumber: 91 + i }));
    const { questions, warnings } = filterPhantomQuestions([...phantoms, ...real]);
    expect(questions).toHaveLength(20);
    expect(questions.every((q) => q.originalNumber >= 91)).toBe(true);
    expect(warnings).toHaveLength(8);
  });

  it("nunca descarta nada quando só existe um cluster (documento normal)", () => {
    const real = Array.from({ length: 10 }, (_, i) => baseCandidate({ originalNumber: 1 + i }));
    const { questions, warnings } = filterPhantomQuestions(real);
    expect(questions).toHaveLength(10);
    expect(warnings).toHaveLength(0);
  });

  it("tolera pequenas lacunas reais (ex.: questão anulada) sem quebrar o cluster", () => {
    const real = [1, 2, 3, 5, 6, 7].map((n) => baseCandidate({ originalNumber: n })); // falta o 4 — gap de 2, dentro da tolerância.
    const { questions, warnings } = filterPhantomQuestions(real);
    expect(questions).toHaveLength(6);
    expect(warnings).toHaveLength(0);
  });
});

describe("runClientPdfImportPipeline — ponta a ponta com fixture sintética multi-página (overlap real)", () => {
  it("12 questões em 12 páginas (1 por página) — janela de overlap na página 8 é deduplicada corretamente, sem perda nem fantasma", async () => {
    const questionNumbers = Array.from({ length: 12 }, (_, i) => i + 1);
    const pageBreaks = new Set(questionNumbers.slice(0, -1)); // quebra depois de CADA questão, exceto a última.
    const examPdf = buildExamPdf(questionNumbers, pageBreaks);
    const answers: Array<[number, string]> = questionNumbers.map((n) => [n, "C"]);
    const keyPdf = buildAnswerKeyPdf(answers);

    const result = await runClientPdfImportPipeline(examPdf, keyPdf, { windowSize: 8, overlap: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pageCount).toBe(12);
    const numbers = result.examQuestions.map((q) => q.originalNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(questionNumbers); // 12/12, sem perda, sem duplicata, sem fantasma.
    expect(result.answerKey).toHaveLength(12);

    // A questão que cai exatamente na página de overlap (página 8 = questão 8)
    // precisa ter gerado o aviso de dedup determinístico.
    expect(result.warnings.some((w) => w.includes("Questão 8") && w.includes("sobreposição"))).toBe(true);

    // Remapeamento de página (seção 5) — cada questão aponta para a
    // página REAL do documento original (a questão N está na página N,
    // nunca "página 1" relativa a uma janela).
    for (const q of result.examQuestions) {
      expect(q.pageStart).toBe(q.originalNumber);
      expect(q.pageEnd).toBe(q.originalNumber);
    }
  });

  it("página de capa sem QUESTÃO nenhuma antes da primeira janela nunca vira questão fantasma", async () => {
    // Página 1: só texto de instrução parecido com lista numerada (o
    // mesmo padrão estrutural do achado real da POC contra o PDF 2024).
    const questionNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const pageBreaks = new Set(questionNumbers.slice(0, -1));
    const examPdf = buildExamPdf(questionNumbers, pageBreaks);
    const keyPdf = buildAnswerKeyPdf(questionNumbers.map((n) => [n, "A"] as [number, string]));

    const result = await runClientPdfImportPipeline(examPdf, keyPdf, { windowSize: 8, overlap: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.examQuestions).toHaveLength(10);
    expect(result.examQuestions.every((q) => q.originalNumber >= 1 && q.originalNumber <= 10)).toBe(true);
  });

  it("identidade: primeiro valor não-undefined encontrado entre as janelas vence (nunca exige unanimidade)", async () => {
    const examPdf = buildExamPdf([1, 2, 3], new Set([1, 2]));
    const keyPdf = buildAnswerKeyPdf([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
    const result = await runClientPdfImportPipeline(examPdf, keyPdf);
    expect(result.ok).toBe(true);
    // Fixture sem cabeçalho de identidade real — nunca inventa campo.
    if (result.ok) expect(result.examDetectedIdentity).toEqual({});
  });

  it("gabarito processado inteiro, nunca dividido em janelas — respostas batem 1:1", async () => {
    const examPdf = buildExamPdf([1, 2], new Set([1]));
    const keyPdf = buildAnswerKeyPdf([
      [1, "A"],
      [2, "B"],
    ]);
    const result = await runClientPdfImportPipeline(examPdf, keyPdf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Map(result.answerKey).get(1)).toBe("A");
      expect(new Map(result.answerKey).get(2)).toBe("B");
    }
  });

  it("questão sem entrada no gabarito (ex.: anulada) nunca é inventada — fica ausente do Map, nunca null/undefined mascarado", async () => {
    const examPdf = buildExamPdf([1, 2, 3], new Set([1, 2]));
    const keyPdf = buildAnswerKeyPdf([
      [1, "A"],
      [3, "C"],
    ]); // questão 2 "anulada" — sem entrada no gabarito.
    const result = await runClientPdfImportPipeline(examPdf, keyPdf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const map = new Map(result.answerKey);
      expect(map.has(2)).toBe(false);
      expect(map.get(1)).toBe("A");
      expect(map.get(3)).toBe("C");
    }
  });

  it("cancelamento (AbortSignal) interrompe o pipeline sem lançar exceção não tratada", async () => {
    const examPdf = buildExamPdf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const keyPdf = buildAnswerKeyPdf([[1, "A"]]);
    const controller = new AbortController();
    controller.abort();
    const result = await runClientPdfImportPipeline(examPdf, keyPdf, { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cancelled");
  });
});

describe("remapElementId — regressão do bug real de auditoria (id preso ao número de página relativo ao chunk)", () => {
  it("reescreve o prefixo p<número>_ preservando o sufixo, para qualquer offset", () => {
    expect(remapElementId("p2_img_1", 7)).toBe("p9_img_1");
    expect(remapElementId("p1_mask_3", 21)).toBe("p22_mask_3");
    expect(remapElementId("p5_vec_0", 0)).toBe("p5_vec_0");
  });

  it("nunca mexe numa string que não começa com o padrão p<número>_", () => {
    expect(remapElementId("elemento-sem-prefixo", 5)).toBe("elemento-sem-prefixo");
  });
});

describe("ponta a ponta com imagens reais em janelas diferentes — bug real encontrado na auditoria de hardening", () => {
  it("duas imagens cujo número de página é IDÊNTICO dentro do respectivo chunk (ambas 'página 2 da janela') nunca colidem — ids e pageNumber corretos e únicos", async () => {
    // 12 questões, 1 por página — janela 1 = páginas 1-8, janela 2 =
    // páginas 8-15(->12). Página absoluta 2 é a "página 2" da janela 1;
    // página absoluta 9 é a "página 2" da janela 2 (janela 2 começa na
    // página 8) — o EXATO cenário que colidia antes da correção.
    const questionNumbers = Array.from({ length: 12 }, (_, i) => i + 1);
    const smallImage = { afterLineIndex: 0, width: 2, height: 2, rgbBytes: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120] };
    const pages: FixturePageSpec[] = questionNumbers.map((n) => ({
      lines: [
        `QUESTAO ${n}`,
        `Enunciado tecnico da questao ${n} de teste.`,
        `A. Alternativa A da questao ${n}`,
        `B. Alternativa B da questao ${n}`,
        `C. Alternativa C da questao ${n}`,
        `D. Alternativa D da questao ${n}`,
        `E. Alternativa E da questao ${n}`,
      ],
      images: n === 2 || n === 9 ? [smallImage] : undefined,
    }));
    const examPdf = buildFixturePdfWithVisuals(pages);
    const keyPdf = buildAnswerKeyPdf(questionNumbers.map((n) => [n, "A"] as [number, string]));

    const result = await runClientPdfImportPipeline(examPdf, keyPdf, { windowSize: 8, overlap: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rasterElements = result.visualElements.filter((el) => el.kind === "raster" && el.extractionStatus === "extracted");
    expect(rasterElements).toHaveLength(2);

    const ids = rasterElements.map((el) => el.id);
    expect(new Set(ids).size).toBe(2); // nunca colidem.

    const byPage = new Map(rasterElements.map((el) => [el.pageNumber, el] as const));
    expect(byPage.has(2)).toBe(true);
    expect(byPage.has(9)).toBe(true);
    // O id precisa refletir a página ABSOLUTA remapeada, nunca a relativa ao chunk.
    expect(byPage.get(2)!.id.startsWith("p2_")).toBe(true);
    expect(byPage.get(9)!.id.startsWith("p9_")).toBe(true);
  });
});
