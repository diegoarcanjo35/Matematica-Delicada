/* Sprint 24 — OCR SEGURO PARA PDFs ESCANEADOS.

   Testes NOVOS desta sprint — nunca repete os 1766+ testes de sprints
   anteriores. Cobre: modelo de confiança OCR, fusão nativo+OCR, detecção
   de tabela/matemática suspeita, classificação por página, gating de
   elementos estruturais críticos (número/letra/gabarito/identidade), e o
   fluxo needs_ocr → OCR fornecido → fundido, ponta a ponta via um PDF
   técnico real (nunca a prova oficial — seção 34 da ordem). */

import { describe, expect, it } from "vitest";
import {
  classifyOcrConfidence,
  isOcrConfidentEnoughForAnswerKey,
  isOcrConfidentEnoughForStructural,
  isOcrConfidentEnoughForIdentity,
  detectSuspiciousMathText,
  OCR_CONFIDENCE_HIGH,
  OCR_CONFIDENCE_MEDIUM,
} from "../src/lib/pdfEnemOcrModel";
import { fusePageLines, looksTabularOcrRegion } from "../src/lib/pdfEnemOcrFusion";
import { extractPdfPages, classifyPageTextQuality, type PdfPageText } from "../src/lib/pdfEnemExtractor";
import { parseAnswerKeyFromPages, parseAnswerKeyLines } from "../src/lib/pdfEnemAnswerKey";
import { checkDocumentIdentity } from "../src/lib/pdfEnemDocumentIdentity";
import { segmentExamQuestions } from "../src/lib/pdfEnemSegmenter";
import { buildPreviewQuestions } from "../src/lib/pdfEnemMatch";
import { buildFixturePdfWithVisuals, buildTwoColumnCollisionFixturePdf } from "./pdfFixtureBuilder";

describe("pdfEnemOcrModel — bandas de confianca (secao 6 da ordem)", () => {
  it("classifica high/medium/low nos limiares corretos", () => {
    expect(classifyOcrConfidence(100)).toBe("high");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_HIGH)).toBe("high");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_HIGH - 1)).toBe("medium");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_MEDIUM)).toBe("medium");
    expect(classifyOcrConfidence(OCR_CONFIDENCE_MEDIUM - 1)).toBe("low");
    expect(classifyOcrConfidence(0)).toBe("low");
  });

  it("gabarito, estrutural e identidade rejeitam confianca low, aceitam medium/high", () => {
    expect(isOcrConfidentEnoughForAnswerKey(OCR_CONFIDENCE_MEDIUM - 1)).toBe(false);
    expect(isOcrConfidentEnoughForAnswerKey(OCR_CONFIDENCE_MEDIUM)).toBe(true);
    expect(isOcrConfidentEnoughForStructural(OCR_CONFIDENCE_MEDIUM - 1)).toBe(false);
    expect(isOcrConfidentEnoughForStructural(OCR_CONFIDENCE_HIGH)).toBe(true);
    expect(isOcrConfidentEnoughForIdentity(10)).toBe(false);
    expect(isOcrConfidentEnoughForIdentity(90)).toBe(true);
  });

  it("detecta suspeitas estruturais de simbolo matematico perdido, sem corrigir nada", () => {
    expect(detectSuspiciousMathText("area vale 2x10 3 metros")).not.toHaveLength(0);
    expect(detectSuspiciousMathText("calcule a raiz do numero")).not.toHaveLength(0);
    expect(detectSuspiciousMathText("resultado e 3/")).not.toHaveLength(0);
    expect(detectSuspiciousMathText("um texto absolutamente normal e limpo")).toHaveLength(0);
  });
});

describe("pdfEnemOcrFusion — fusePageLines (secao 12 da ordem)", () => {
  const nativeLines: PdfPageText["lines"] = [
    { y: 700, text: "Linha nativa A" },
    { y: 600, text: "Linha nativa B" },
  ];

  it("OCR na mesma posicao de uma linha nativa e descartado (nativo sempre vence)", () => {
    const result = fusePageLines(nativeLines, [{ x: 40, y: 700, text: "Duplicata OCR de A", confidencePercent: 90 }]);
    expect(result.lines).toHaveLength(2);
    expect(result.lines.some((l) => l.text.includes("Duplicata"))).toBe(false);
    expect(result.hasAmbiguousOverlap).toBe(false);
  });

  it("OCR em regiao sem cobertura nativa e incluido, marcado source=ocr", () => {
    const result = fusePageLines(nativeLines, [{ x: 40, y: 300, text: "Linha OCR nova", confidencePercent: 77 }]);
    expect(result.lines).toHaveLength(3);
    const added = result.lines.find((l) => l.text === "Linha OCR nova");
    expect(added?.source).toBe("ocr");
    expect(added?.confidencePercent).toBe(77);
    expect(result.hasAmbiguousOverlap).toBe(false);
  });

  it("OCR numa faixa ambigua (perto mas nao identica a uma linha nativa) e incluido E sinalizado", () => {
    const result = fusePageLines(nativeLines, [{ x: 40, y: 693, text: "Talvez a mesma linha A, talvez nao", confidencePercent: 80 }]);
    expect(result.hasAmbiguousOverlap).toBe(true);
    const added = result.lines.find((l) => l.text.includes("Talvez"));
    expect(added?.ambiguousFusion).toBe(true);
  });

  it("pagina 100% escaneada (sem nativo) aceita todas as linhas OCR diretamente", () => {
    const result = fusePageLines([], [{ x: 40, y: 500, text: "Unica linha OCR", confidencePercent: 95 }]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].source).toBe("ocr");
  });

  it("looksTabularOcrRegion detecta linhas com multiplas celulas repetidas (secao 14)", () => {
    const tabularLines = [
      { x: 40, y: 700, text: "1  A   10   20", confidencePercent: 80 },
      { x: 40, y: 690, text: "2  B   30   40", confidencePercent: 80 },
      { x: 40, y: 680, text: "3  C   50   60", confidencePercent: 80 },
    ];
    expect(looksTabularOcrRegion(tabularLines)).toBe(true);
    expect(looksTabularOcrRegion([{ x: 40, y: 700, text: "Um paragrafo comum de texto corrido", confidencePercent: 80 }])).toBe(false);
  });
});

describe("classifyPageTextQuality — heuristica por pagina (secao 3 da ordem)", () => {
  function page(pageNumber: number, chars: string, hasVisualContent = false): PdfPageText {
    return { pageNumber, width: 600, height: 800, hasVisualContent, lines: chars ? [{ y: 700, text: chars }] : [] };
  }

  it("documento inteiro com texto nativo bom: toda pagina text_layer_good", () => {
    const diag = classifyPageTextQuality([page(1, "Bastante texto nativo real nesta pagina de exemplo."), page(2, "Mais texto nativo real aqui tambem, sem problema nenhum.")]);
    expect(diag.every((d) => d.state === "text_layer_good")).toBe(true);
  });

  it("gabarito curto e 100% nativo NUNCA precisa de OCR (nao repete o bug do limiar global antigo)", () => {
    const diag = classifyPageTextQuality([page(1, "1 C 2 A 3 B")]);
    expect(diag[0].state).toBe("text_layer_good");
  });

  it("pagina isolada em branco/capa dentro de um documento bom nunca dispara OCR sozinha", () => {
    const diag = classifyPageTextQuality([
      page(1, "Capa do caderno, sem nenhum texto relevante aqui mesmo"),
      page(2, ""),
      page(3, "Enunciado bem extenso da terceira pagina, com texto de sobra."),
      page(4, "Mais uma pagina cheia de texto nativo de verdade por aqui."),
    ]);
    expect(diag[1].state).toBe("text_layer_good"); // outlier legitimo, documento é majoritariamente nativo.
  });

  it("documento totalmente escaneado (todas as paginas sem texto real): todas precisam de OCR", () => {
    const diag = classifyPageTextQuality([page(1, "", true), page(2, "", true), page(3, "", true)]);
    expect(diag.every((d) => d.state === "needs_ocr")).toBe(true);
  });

  it("documento hibrido: so as paginas realmente vazias entram como needs_ocr/partial", () => {
    const diag = classifyPageTextQuality([page(1, "", true), page(2, "", true), page(3, "", true), page(4, "", true), page(5, "Uma unica pagina com bastante texto nativo real por aqui.")]);
    // Minoria com texto (1/5 = 20% < 50%) -> documento NÃO passa no limiar de "nativo funcionando";
    // páginas zeradas seguem needs_ocr; a única com texto real continua good de qualquer forma.
    expect(diag[4].state).toBe("text_layer_good");
    expect(diag.slice(0, 4).every((d) => d.state === "needs_ocr")).toBe(true);
  });
});

describe("extractPdfPages — fluxo needs_ocr -> OCR fornecido -> fundido (secoes 2/4/9)", () => {
  it("PDF hibrido (uma pagina boa, uma sem texto) reporta pagesNeedingOcr; apos OCR fornecido, extrai com sucesso", async () => {
    const bytes = buildFixturePdfWithVisuals([
      { lines: ["QUESTAO 1", "Enunciado tecnico normal da questao um.", "A. Alt A", "B. Alt B", "C. Alt C", "D. Alt D", "E. Alt E"] },
      { lines: [""], images: [{ afterLineIndex: 0, width: 2, height: 2, rgbBytes: [10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40] }] },
    ]);

    const firstAttempt = await extractPdfPages(bytes);
    expect(firstAttempt.ok).toBe(false);
    if (firstAttempt.ok) throw new Error("esperava needs_ocr");
    expect(firstAttempt.reason).toBe("needs_ocr");
    expect(firstAttempt.pagesNeedingOcr).toEqual([2]);

    const withOcr = await extractPdfPages(bytes, [
      { pageNumber: 2, lines: [{ x: 40, y: 700, text: "QUESTAO 2", confidencePercent: 92 }, { x: 40, y: 686, text: "Enunciado reconhecido por OCR desta segunda questao.", confidencePercent: 88 }] },
    ]);
    expect(withOcr.ok).toBe(true);
    if (!withOcr.ok) throw new Error("esperava sucesso apos fundir OCR");
    const page2 = withOcr.pages.find((p) => p.pageNumber === 2)!;
    expect(page2.lines.some((l) => l.source === "ocr" && l.text === "QUESTAO 2")).toBe(true);
    expect(withOcr.pageDiagnostics.find((d) => d.pageNumber === 2)?.ocrApplied).toBe(true);
  });

  it("revalida limites de OCR do lado do worker mesmo se o cliente nao respeitar (secao 19)", async () => {
    const bytes = buildFixturePdfWithVisuals([{ lines: [""], images: [{ afterLineIndex: 0, width: 1, height: 1, rgbBytes: [1, 1, 1] }] }]);
    const tooLong = "x".repeat(3000);
    const result = await extractPdfPages(bytes, [{ pageNumber: 1, lines: [{ x: 0, y: 0, text: tooLong, confidencePercent: 90 }] }]);
    expect(result.ok).toBe(false);
  });
});

describe("Fixture G — colisao de coluna/heading reproduzindo o bug real do ENEM 2019 (secao 10/24 da ordem)", () => {
  it("duas colunas com rotulo solto colidindo em Y com o cabecalho vizinho: ambas as questoes sao reconhecidas", async () => {
    const bytes = buildTwoColumnCollisionFixturePdf();
    const extract = await extractPdfPages(bytes);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions, globalWarnings } = segmentExamQuestions(extract.pages);
    expect(globalWarnings).toEqual([]);
    expect(questions.map((q) => q.originalNumber).sort((a, b) => a - b)).toEqual([1, 2]);
    const q1 = questions.find((q) => q.originalNumber === 1)!;
    const q2 = questions.find((q) => q.originalNumber === 2)!;
    expect(q1.alternatives).toHaveLength(5);
    expect(q2.alternatives).toHaveLength(5);
    expect(q1.warnings).toEqual([]);
    expect(q2.warnings).toEqual([]);
    // A questão 2 nunca deve conter o rótulo solto "d" da coluna vizinha —
    // prova de que o cabeçalho ficou isolado (nunca fundido) na extração.
    expect(q2.statement).not.toContain("\"d\"");
  });
});

describe("parseAnswerKeyFromPages — regra absoluta do gabarito (secao 7 da ordem)", () => {
  it("linha OCR de confianca baixa NUNCA vira resposta — questao fica sem gabarito", () => {
    const pages: PdfPageText[] = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        hasVisualContent: false,
        lines: [
          { y: 700, text: "1 C", source: "native" },
          { y: 690, text: "2 A", source: "ocr", confidencePercent: 40 },
          { y: 680, text: "3 B", source: "ocr", confidencePercent: 80 },
        ],
      },
    ];
    const result = parseAnswerKeyFromPages(pages);
    expect(result.answers?.get(1)).toBe("C");
    expect(result.answers?.has(2)).toBe(false); // confianca low — nunca aceito.
    expect(result.answers?.get(3)).toBe("B"); // confianca medium — aceito.
  });

  it("baseline: parseAnswerKeyLines puro continua funcionando sem nenhuma nocao de OCR (nenhuma regressao)", () => {
    const result = parseAnswerKeyLines(["1 C", "2 A"]);
    expect(result.ok).toBe(true);
    expect(result.answers?.get(1)).toBe("C");
  });
});

describe("checkDocumentIdentity — identidade OCR nunca confirma sozinha (secao 8 da ordem)", () => {
  it("campos batem mas vieram de OCR de confianca baixa -> confirmedAutomatically continua false", () => {
    const examDetected = { day: 2, bookletNumber: 7, color: "AZUL", lowConfidenceOcrSource: true };
    const answerKeyDetected = { day: 2, bookletNumber: 7, color: "AZUL", year: 2019 };
    const result = checkDocumentIdentity(examDetected, answerKeyDetected, { year: 2019, application: "regular", booklet: "Caderno 7 Azul" });
    expect(result.confirmedAutomatically).toBe(false);
    expect(result.ok).toBe(true); // nunca uma divergencia real — so falta de confirmacao automatica.
    expect(result.messages.some((m) => m.includes("OCR"))).toBe(true);
  });

  it("mesmos campos 100% nativos confirmam automaticamente normalmente (nenhuma regressao)", () => {
    const examDetected = { day: 2, bookletNumber: 7, color: "AZUL" };
    const answerKeyDetected = { day: 2, bookletNumber: 7, color: "AZUL", year: 2019 };
    const result = checkDocumentIdentity(examDetected, answerKeyDetected, { year: 2019, application: "regular", booklet: "Caderno 7 Azul" });
    expect(result.confirmedAutomatically).toBe(true);
  });
});

describe("segmentExamQuestions — gating de elementos estruturais criticos (secao 6 da ordem)", () => {
  it("numero de questao reconhecido por OCR de confianca baixa gera aviso (forca needs_review a jusante)", () => {
    const pages: PdfPageText[] = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        hasVisualContent: false,
        lines: [
          { y: 700, text: "QUESTAO 1", source: "ocr", confidencePercent: 30 },
          { y: 686, text: "Enunciado tecnico de teste da questao um.", source: "ocr", confidencePercent: 90 },
          { y: 672, text: "A. Alt A", source: "ocr", confidencePercent: 90 },
          { y: 658, text: "B. Alt B", source: "ocr", confidencePercent: 90 },
          { y: 644, text: "C. Alt C", source: "ocr", confidencePercent: 90 },
          { y: 630, text: "D. Alt D", source: "ocr", confidencePercent: 90 },
          { y: 616, text: "E. Alt E", source: "ocr", confidencePercent: 90 },
        ],
      },
    ];
    const { questions } = segmentExamQuestions(pages);
    expect(questions).toHaveLength(1);
    expect(questions[0].hasOcrText).toBe(true);
    expect(questions[0].warnings.some((w) => w.includes("confiança baixa"))).toBe(true);
  });

  it("letra de alternativa reconhecida por OCR de confianca baixa gera aviso especifico", () => {
    const pages: PdfPageText[] = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        hasVisualContent: false,
        lines: [
          { y: 700, text: "QUESTAO 1", source: "native" },
          { y: 686, text: "Enunciado tecnico de teste da questao um.", source: "native" },
          { y: 672, text: "A. Alt A", source: "native" },
          { y: 658, text: "B. Alt B", source: "ocr", confidencePercent: 20 },
          { y: 644, text: "C. Alt C", source: "native" },
          { y: 630, text: "D. Alt D", source: "native" },
          { y: 616, text: "E. Alt E", source: "native" },
        ],
      },
    ];
    const { questions } = segmentExamQuestions(pages);
    expect(questions[0].warnings.some((w) => w.includes("Letra da alternativa B"))).toBe(true);
  });

  it("texto 100% nativo nunca gera aviso de OCR (nenhuma regressao)", () => {
    const pages: PdfPageText[] = [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        hasVisualContent: false,
        lines: [
          { y: 700, text: "QUESTAO 1" },
          { y: 686, text: "Enunciado tecnico de teste da questao um." },
          { y: 672, text: "A. Alt A" },
          { y: 658, text: "B. Alt B" },
          { y: 644, text: "C. Alt C" },
          { y: 630, text: "D. Alt D" },
          { y: 616, text: "E. Alt E" },
        ],
      },
    ];
    const { questions } = segmentExamQuestions(pages);
    expect(questions[0].hasOcrText).toBe(false);
    expect(questions[0].warnings).toHaveLength(0);
  });
});

describe("buildPreviewQuestions — tabela e matematica suspeita (secoes 11/14 da ordem)", () => {
  it("questao que toca uma pagina marcada como tabular nunca fica ready", async () => {
    const raw = segmentExamQuestions([
      {
        pageNumber: 3,
        width: 600,
        height: 800,
        hasVisualContent: false,
        lines: [
          { y: 700, text: "QUESTAO 9" },
          { y: 686, text: "Enunciado tecnico de teste da questao nove." },
          { y: 672, text: "A. Alt A" },
          { y: 658, text: "B. Alt B" },
          { y: 644, text: "C. Alt C" },
          { y: 630, text: "D. Alt D" },
          { y: 616, text: "E. Alt E" },
        ],
      },
    ]);
    const { items } = await buildPreviewQuestions(
      raw.questions,
      new Map([[9, "A"]]),
      { year: 2019, application: "regular", booklet: "Caderno 7 Azul" },
      new Set(),
      new Set(),
      [],
      [3]
    );
    expect(items[0].status).toBe("needs_review");
    expect(items[0].warnings.some((w) => w.toLowerCase().includes("tabela"))).toBe(true);
  });

  it("questao com texto OCR e simbolo matematico suspeito recebe aviso (nunca corrige)", async () => {
    const raw = segmentExamQuestions([
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        hasVisualContent: false,
        lines: [
          { y: 700, text: "QUESTAO 5", source: "ocr", confidencePercent: 95 },
          { y: 686, text: "O valor e 2x10 3 metros conforme calculado.", source: "ocr", confidencePercent: 95 },
          { y: 672, text: "A. Alt A", source: "ocr", confidencePercent: 95 },
          { y: 658, text: "B. Alt B", source: "ocr", confidencePercent: 95 },
          { y: 644, text: "C. Alt C", source: "ocr", confidencePercent: 95 },
          { y: 630, text: "D. Alt D", source: "ocr", confidencePercent: 95 },
          { y: 616, text: "E. Alt E", source: "ocr", confidencePercent: 95 },
        ],
      },
    ]);
    const { items } = await buildPreviewQuestions(raw.questions, new Map([[5, "A"]]), { year: 2019, application: "regular", booklet: "Caderno 7 Azul" }, new Set(), new Set());
    expect(items[0].hasOcrText).toBe(true);
    expect(items[0].warnings.some((w) => w.includes("símbolo matemático"))).toBe(true);
    expect(items[0].status).toBe("needs_review");
  });
});
