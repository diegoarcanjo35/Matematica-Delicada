// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractPdfPages } from "../src/lib/pdfEnemExtractor";
import { segmentExamQuestions } from "../src/lib/pdfEnemSegmenter";
import { parseAnswerKeyFromPageLines } from "../src/lib/pdfEnemAnswerKey";
import { buildPreviewQuestions, buildPdfEnemQuestionCode } from "../src/lib/pdfEnemMatch";
import { validateExamIdentityInput, examIdentitiesCompatible } from "../src/lib/pdfEnemExamIdentity";
import { buildAnswerKeyPdf, buildAnswerKeyPdfWithIdentity, buildExamPdf, buildExamPdfWithHeader, buildFixturePdf } from "./pdfFixtureBuilder";
import { checkDocumentIdentity, detectAnswerKeyDocumentIdentity, detectExamDocumentIdentity } from "../src/lib/pdfEnemDocumentIdentity";
import { applyReviewEdit, type PdfApplySelectionEntry } from "../src/services/questionPdfImportService";
import type { PdfEnemPreviewQuestion } from "../src/lib/pdfEnemMatch";

const IDENTITY_INPUT = { year: 2019, application: "Aplicacao regular", booklet: "Caderno Azul" };

describe("smoke — pipeline PDF ENEM ponta a ponta (fixtures tecnicas)", () => {
  it("extrai texto de um PDF minimo com pdfjs-dist dentro do ambiente de teste", async () => {
    const pdf = buildExamPdf([1]);
    const result = await extractPdfPages(pdf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pageCount).toBe(1);
      expect(result.pages[0].lines.map((l) => l.text)).toContain("QUESTAO 1");
    }
  });

  it("segmenta 2 questoes de uma prova de 2 questoes e casa com o gabarito", async () => {
    const examPdf = buildExamPdf([1, 2]);
    const keyPdf = buildAnswerKeyPdf([
      [1, "C"],
      [2, "A"],
      [3, "B"],
      [4, "D"],
      [5, "E"],
      [6, "C"],
      [7, "A"],
      [8, "B"],
    ]);
    const examExtract = await extractPdfPages(examPdf);
    const keyExtract = await extractPdfPages(keyPdf);
    expect(examExtract.ok).toBe(true);
    expect(keyExtract.ok).toBe(true);
    if (!examExtract.ok || !keyExtract.ok) return;

    const { questions } = segmentExamQuestions(examExtract.pages);
    expect(questions).toHaveLength(2);
    expect(questions[0].originalNumber).toBe(1);
    expect(questions[0].alternatives).toHaveLength(5);

    const { answers } = parseAnswerKeyFromPageLines(keyExtract.pages.map((p) => p.lines.map((l) => l.text)));
    expect(answers?.get(1)).toBe("C");
    expect(answers?.get(2)).toBe("A");

    const identity = validateExamIdentityInput(IDENTITY_INPUT).identity!;
    const { items } = await buildPreviewQuestions(questions, answers!, identity, new Set(), new Set());
    expect(items).toHaveLength(2);
    expect(items[0].status).toBe("ready");
    expect(items[0].correctAlternative).toBe("C");
    expect(items[0].canApply).toBe(true);
    expect(items[0].code).toBe(buildPdfEnemQuestionCode(identity, 1));
  });

  it("identidades de exame com ano diferente sao incompativeis (fail-closed)", () => {
    const a = validateExamIdentityInput({ year: 2019, application: "Aplicacao regular", booklet: "Azul" }).identity!;
    const b = validateExamIdentityInput({ year: 2020, application: "Aplicacao regular", booklet: "Azul" }).identity!;
    expect(examIdentitiesCompatible(a, b)).toBe(false);
  });
});

describe("buildPdfEnemQuestionCode — regressao real encontrada nesta sprint", () => {
  it("nunca colide entre duas questoes da mesma prova mesmo com identidade longa (bug real: truncamento cortava o sufixo numerico)", () => {
    const identity = validateExamIdentityInput({ year: 2019, application: "Aplicacao regular", booklet: "Caderno Azul" }).identity!;
    const codes = new Set<number>();
    const generated = [1, 2, 3, 50, 199].map((n) => buildPdfEnemQuestionCode(identity, n));
    expect(new Set(generated).size).toBe(generated.length); // nenhuma colisao
    for (const code of generated) {
      expect(code.length).toBeLessThanOrEqual(40);
      expect(code).toMatch(/-\d{3}$/); // sufixo numerico SEMPRE presente, nunca cortado
    }
  });
});

describe("segmentExamQuestions — deteccao de estrutura (secao 8 da ordem)", () => {
  it("questao sem alternativa E (so 4 alternativas) vira needs_review, nunca eh 'consertada'", async () => {
    const pdf = buildFixturePdf([[
      "QUESTAO 1",
      "Enunciado tecnico.",
      "A. Alternativa A",
      "B. Alternativa B",
      "C. Alternativa C",
      "D. Alternativa D",
    ]]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions).toHaveLength(1);
    expect(questions[0].alternatives).toHaveLength(4);
    expect(questions[0].warnings.some((w) => w.includes("4 alternativas"))).toBe(true);
  });

  it("letra de alternativa duplicada vira aviso explicito, nunca silenciosamente ignorada", async () => {
    const pdf = buildFixturePdf([[
      "QUESTAO 1",
      "Enunciado tecnico.",
      "A. Primeira A",
      "A. Segunda A (duplicada)",
      "B. Alternativa B",
      "C. Alternativa C",
      "D. Alternativa D",
      "E. Alternativa E",
    ]]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions[0].warnings.some((w) => w.toLowerCase().includes("duplicada"))).toBe(true);
  });

  it("questao que atravessa duas paginas continua sendo UMA questao so, com pageStart/pageEnd corretos", async () => {
    const pdf = buildFixturePdf([
      ["QUESTAO 1", "Enunciado tecnico que continua", "na proxima pagina."],
      ["A. Alternativa A", "B. Alternativa B", "C. Alternativa C", "D. Alternativa D", "E. Alternativa E"],
    ]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions).toHaveLength(1);
    expect(questions[0].pageStart).toBe(1);
    expect(questions[0].pageEnd).toBe(2);
    expect(questions[0].alternatives).toHaveLength(5);
  });

  it("duas questoes na mesma pagina sao segmentadas corretamente, cada uma com suas proprias alternativas", async () => {
    const pdf = buildExamPdf([1, 2]); // ambas na mesma pagina por padrao do builder
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    expect(extract.pageCount).toBe(1);
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions).toHaveLength(2);
    expect(questions[0].statement).toContain("questao 1");
    expect(questions[1].statement).toContain("questao 2");
  });

  it("numero de questao fora de ordem ainda eh reconhecido (a ordem de exibicao final vem do originalNumber, nunca da ordem de leitura)", async () => {
    const pdf = buildFixturePdf([[
      "QUESTAO 5",
      "Enunciado da questao 5.",
      "A. A", "B. B", "C. C", "D. D", "E. E",
      "QUESTAO 3",
      "Enunciado da questao 3.",
      "A. A", "B. B", "C. C", "D. D", "E. E",
    ]]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions.map((q) => q.originalNumber)).toEqual([5, 3]); // ordem de LEITURA preservada aqui;
    // a ordenacao final por originalNumber acontece em buildPreviewQuestions.
  });

  it("numero de questao duplicado na mesma prova gera aviso em AMBAS as ocorrencias", async () => {
    const pdf = buildFixturePdf([[
      "QUESTAO 1",
      "Primeira ocorrencia.",
      "A. A", "B. B", "C. C", "D. D", "E. E",
      "QUESTAO 1",
      "Segunda ocorrencia (duplicada).",
      "A. A", "B. B", "C. C", "D. D", "E. E",
    ]]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.warnings.some((w) => w.includes("mais de uma vez")))).toBe(true);
  });

  it("pagina de capa/instrucoes sem nenhuma questao nao gera uma questao 'numero 0'", async () => {
    const pdf = buildFixturePdf([
      ["ENEM 2019", "Instrucoes gerais da prova.", "Leia atentamente antes de comecar."],
      ["QUESTAO 1", "Enunciado tecnico.", "A. A", "B. B", "C. C", "D. D", "E. E"],
    ]);
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const { questions } = segmentExamQuestions(extract.pages);
    expect(questions).toHaveLength(1);
    expect(questions[0].originalNumber).toBe(1);
  });
});

describe("parseAnswerKeyFromPageLines — gabarito (secao 11 da ordem)", () => {
  it("numero duplicado com respostas DIFERENTES gera erro e remove a entrada ambigua do mapa", () => {
    const result = parseAnswerKeyFromPageLines([["1 C", "2 A", "1 D", "3 B", "4 E", "5 A", "6 B"]]);
    expect(result.errors.some((e) => e.includes("respostas diferentes"))).toBe(true);
    expect(result.answers?.has(1)).toBe(false); // ambiguo -> nunca escolhe arbitrariamente
    expect(result.answers?.get(2)).toBe("A");
  });

  it("gabarito vazio (nenhuma linha reconhecida) retorna erro explicito, nunca um mapa vazio silencioso", () => {
    const result = parseAnswerKeyFromPageLines([["texto qualquer sem numero e letra"]]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Nenhuma resposta"))).toBe(true);
  });
});

describe("buildPreviewQuestions — dedupe (secao 13 da ordem)", () => {
  it("codigo ja existente no banco marca duplicateStatus='exact' e bloqueia canApply", async () => {
    const examPdf = buildExamPdf([1]);
    const extract = await extractPdfPages(examPdf);
    if (!extract.ok) throw new Error("extract falhou");
    const { questions } = segmentExamQuestions(extract.pages);
    const identity = validateExamIdentityInput(IDENTITY_INPUT).identity!;
    const existingCode = buildPdfEnemQuestionCode(identity, 1);

    const { items } = await buildPreviewQuestions(questions, new Map([[1, "C"]]), identity, new Set([existingCode]), new Set());
    expect(items[0].duplicateStatus).toBe("exact");
    expect(items[0].canApply).toBe(false);
    expect(items[0].status).toBe("needs_review");
  });

  it("fingerprint identico a uma questao ja existente tambem marca duplicateStatus='exact' (mesmo com codigo diferente)", async () => {
    const examPdf = buildExamPdf([1]);
    const extract = await extractPdfPages(examPdf);
    if (!extract.ok) throw new Error("extract falhou");
    const { questions } = segmentExamQuestions(extract.pages);
    const identity = validateExamIdentityInput(IDENTITY_INPUT).identity!;
    const { items: firstPass } = await buildPreviewQuestions(questions, new Map([[1, "C"]]), identity, new Set(), new Set());
    const { items } = await buildPreviewQuestions(questions, new Map([[1, "C"]]), identity, new Set(), new Set([firstPass[0].fingerprint]));
    expect(items[0].duplicateStatus).toBe("exact");
  });
});

function buildConfirmedIdentity(overrides: Partial<{ year: number; booklet: string }> = {}) {
  return validateExamIdentityInput({ year: overrides.year ?? 2019, application: "Aplicacao regular", booklet: overrides.booklet ?? "Caderno 7 Azul" }).identity!;
}

describe("pdfEnemDocumentIdentity — extracao real do texto do PDF (Sprint 22.1, secoes 2/3/4)", () => {
  it("detecta dia/caderno/cor no cabecalho real da PROVA (formato confirmado no PDF oficial 2019)", async () => {
    const pdf = buildExamPdfWithHeader([1], { day: 2, bookletNumber: 7, color: "AZUL" });
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const detected = detectExamDocumentIdentity(extract.pages);
    expect(detected).toEqual({ day: 2, bookletNumber: 7, color: "AZUL" });
  });

  it("detecta dia/caderno/cor/ano no GABARITO real (duas linhas separadas pelo layout de colunas)", async () => {
    const pdf = buildAnswerKeyPdfWithIdentity(
      [[1, "C"], [2, "A"], [3, "B"], [4, "D"], [5, "E"], [6, "C"], [7, "A"], [8, "B"]],
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2019 }
    );
    const extract = await extractPdfPages(pdf);
    expect(extract.ok).toBe(true);
    if (!extract.ok) return;
    const detected = detectAnswerKeyDocumentIdentity(extract.pages);
    expect(detected).toEqual({ day: 2, bookletNumber: 7, color: "AZUL", year: 2019 });
  });

  it("identidade nao detectavel em nenhum dos dois PDFs nunca e tratada como confirmada nem como divergencia (mensagem neutra)", () => {
    const result = checkDocumentIdentity({}, {}, buildConfirmedIdentity({ booklet: "Caderno Azul" }));
    expect(result.ok).toBe(true); // nunca bloqueia por falta de sinal
    expect(result.confirmedAutomatically).toBe(false); // mas tambem nunca finge ter confirmado
    expect(result.messages).toEqual(["Identidade não pôde ser confirmada automaticamente neste arquivo."]);
  });

  it("item E (regressao do caso oficial real) — dia/caderno/cor/ano detectados e iguais nos dois PDFs -> confirmado automaticamente, sem mensagem", () => {
    const result = checkDocumentIdentity(
      { day: 2, bookletNumber: 7, color: "AZUL" },
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2019 },
      buildConfirmedIdentity({ year: 2019, booklet: "Caderno 7 Azul" })
    );
    expect(result.ok).toBe(true);
    expect(result.confirmedAutomatically).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it("item F (preservado) — TESTE ADVERSARIAL OBRIGATORIO — prova Caderno 7 Azul x gabarito Caderno 8 Rosa: BLOQUEIA mesmo que o editor tenha digitado 'Caderno 7 Azul'", () => {
    const examDetected = { day: 2, bookletNumber: 7, color: "AZUL" };
    const keyDetected = { day: 2, bookletNumber: 8, color: "ROSA", year: 2019 };
    const result = checkDocumentIdentity(examDetected, keyDetected, buildConfirmedIdentity({ year: 2019, booklet: "Caderno 7 Azul" }));
    expect(result.ok).toBe(false);
    expect(result.confirmedAutomatically).toBe(false);
    expect(result.messages.some((m) => m.includes("Caderno divergente"))).toBe(true);
    expect(result.messages.some((m) => m.includes("Cor de caderno divergente"))).toBe(true);
  });

  it("campo do editor nao menciona o caderno/cor detectado em um dos PDFs -> tambem bloqueia (fail-closed)", () => {
    const result = checkDocumentIdentity({ day: 2, bookletNumber: 7, color: "AZUL" }, {}, buildConfirmedIdentity({ booklet: "Caderno 9 Rosa" }));
    expect(result.ok).toBe(false);
    expect(result.messages.some((m) => m.includes("não aparece no campo"))).toBe(true);
  });

  it("item A — editor confirma ano 2019 e o gabarito detecta ano 2019 -> identidade valida, sem mensagem de ano", () => {
    const result = checkDocumentIdentity(
      { day: 2, bookletNumber: 7, color: "AZUL" },
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2019 },
      buildConfirmedIdentity({ year: 2019, booklet: "Caderno 7 Azul" })
    );
    expect(result.ok).toBe(true);
    expect(result.messages.some((m) => m.includes("Ano") || m.includes("ano"))).toBe(false);
  });

  it("item B/bloqueio principal desta sprint — editor confirma ano 2019 mas o GABARITO detecta ano 2020 -> BLOQUEIA mesmo com dia/caderno/cor batendo", () => {
    const result = checkDocumentIdentity(
      { day: 2, bookletNumber: 7, color: "AZUL" },
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2020 },
      buildConfirmedIdentity({ year: 2019, booklet: "Caderno 7 Azul" })
    );
    expect(result.ok).toBe(false);
    expect(result.confirmedAutomatically).toBe(false);
    expect(result.messages.some((m) => m.includes("ano detectado no GABARITO (2020) diverge do ano confirmado (2019)"))).toBe(true);
  });

  it("item D — ano nao detectavel no gabarito nunca inventa divergencia; identidade fica 'nao confirmada automaticamente' quando aplicavel", () => {
    // dia/caderno/cor batem, mas o gabarito nao trouxe ano nenhum (campo ausente).
    const result = checkDocumentIdentity({ day: 2, bookletNumber: 7, color: "AZUL" }, { day: 2, bookletNumber: 7, color: "AZUL" }, buildConfirmedIdentity({ year: 2019, booklet: "Caderno 7 Azul" }));
    expect(result.ok).toBe(true); // ausencia de ano nunca vira divergencia sozinha
    expect(result.messages.some((m) => m.includes("diverge do ano"))).toBe(false);
  });

  it("ano divergente detectado ENTRE os dois PDFs (quando a prova tambem detectar ano no futuro) tambem bloqueia", () => {
    const result = checkDocumentIdentity(
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2018 },
      { day: 2, bookletNumber: 7, color: "AZUL", year: 2019 },
      buildConfirmedIdentity({ year: 2019, booklet: "Caderno 7 Azul" })
    );
    expect(result.ok).toBe(false);
    expect(result.messages.some((m) => m.includes("Ano divergente entre os PDFs"))).toBe(true);
  });
});

describe("applyReviewEdit — correcao editorial de enunciado/alternativas (Sprint 22.1, secoes 5/7 da ordem)", () => {
  function baseItem(overrides: Partial<PdfEnemPreviewQuestion> = {}): PdfEnemPreviewQuestion {
    return {
      tempId: "3",
      originalNumber: 3,
      pageStart: 1,
      pageEnd: 1,
      statement: "Enunciado original com problema estrutural.",
      alternatives: [
        { letter: "A", text: "Alternativa A" },
        { letter: "B", text: "Alternativa B" },
        { letter: "C", text: "Alternativa C" },
        { letter: "D", text: "Alternativa D" },
      ], // só 4 — estruturalmente invalida na extracao original
      correctAlternative: "B",
      warnings: ["Detectadas 4 alternativas (esperado exatamente 5)."],
      status: "needs_review",
      duplicateStatus: "none",
      visualReviewRequired: false,
      patternPrincipalId: null,
      canApply: false,
      code: "ENEM-2019-TESTE-003",
      fingerprint: "fingerprint-original",
      ...overrides,
    };
  }

  it("sem reviewedStatement/reviewedAlternatives devolve o item original sem tocar em nada", async () => {
    const item = baseItem();
    const entry: PdfApplySelectionEntry = { originalNumber: 3, patternPrincipalId: "pat-1" };
    const result = await applyReviewEdit(item, entry);
    expect(result.ok).toBe(true);
    expect(result.item).toBe(item);
  });

  it("edicao estrutural valida (5 alternativas A-E) corrige a questao e RECALCULA o fingerprint", async () => {
    const item = baseItem();
    const entry: PdfApplySelectionEntry = {
      originalNumber: 3,
      patternPrincipalId: "pat-1",
      reviewedStatement: "Enunciado corrigido pela editora.",
      reviewedAlternatives: [
        { letter: "A", text: "A corrigida" },
        { letter: "B", text: "B corrigida" },
        { letter: "C", text: "C corrigida" },
        { letter: "D", text: "D corrigida" },
        { letter: "E", text: "E corrigida" },
      ],
    };
    const result = await applyReviewEdit(item, entry);
    expect(result.ok).toBe(true);
    expect(result.item!.alternatives).toHaveLength(5);
    expect(result.item!.statement).toBe("Enunciado corrigido pela editora.");
    expect(result.item!.fingerprint).not.toBe("fingerprint-original"); // nunca reaproveita o fingerprint antigo
  });

  it("gabarito NUNCA e editavel/inferivel: correctAlternative permanece o do PDF de gabarito mesmo apos a edicao de texto", async () => {
    const item = baseItem({ correctAlternative: "B" });
    const entry: PdfApplySelectionEntry = {
      originalNumber: 3,
      patternPrincipalId: "pat-1",
      reviewedStatement: "Enunciado corrigido.",
      reviewedAlternatives: [
        { letter: "A", text: "A corrigida" },
        { letter: "B", text: "B corrigida" },
        { letter: "C", text: "C corrigida" },
        { letter: "D", text: "D corrigida" },
        { letter: "E", text: "E corrigida" },
      ],
    };
    const result = await applyReviewEdit(item, entry);
    expect(result.ok).toBe(true);
    expect(result.item!.correctAlternative).toBe("B"); // inalterado — a interface nem aceita mudar isso
  });

  it("edicao com numero errado de alternativas (4, nao 5) e rejeitada explicitamente", async () => {
    const item = baseItem();
    const entry: PdfApplySelectionEntry = {
      originalNumber: 3,
      patternPrincipalId: "pat-1",
      reviewedAlternatives: [
        { letter: "A", text: "A" },
        { letter: "B", text: "B" },
        { letter: "C", text: "C" },
        { letter: "D", text: "D" },
      ] as never,
    };
    const result = await applyReviewEdit(item, entry);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("exatamente as 5 alternativas");
  });

  it("edicao com alternativa vazia e rejeitada explicitamente", async () => {
    const item = baseItem();
    const entry: PdfApplySelectionEntry = {
      originalNumber: 3,
      patternPrincipalId: "pat-1",
      reviewedAlternatives: [
        { letter: "A", text: "A" },
        { letter: "B", text: "  " },
        { letter: "C", text: "C" },
        { letter: "D", text: "D" },
        { letter: "E", text: "E" },
      ],
    };
    const result = await applyReviewEdit(item, entry);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("pode ficar vazia");
  });

  it("questao visual permanece fail-closed: a edicao de texto NUNCA limpa visualReviewRequired", async () => {
    const item = baseItem({
      visualReviewRequired: true,
      alternatives: [
        { letter: "A", text: "A" },
        { letter: "B", text: "B" },
        { letter: "C", text: "C" },
        { letter: "D", text: "D" },
        { letter: "E", text: "E" },
      ],
    });
    const entry: PdfApplySelectionEntry = {
      originalNumber: 3,
      patternPrincipalId: "pat-1",
      reviewedStatement: "Texto corrigido, mas a imagem continua faltando.",
    };
    const result = await applyReviewEdit(item, entry);
    expect(result.ok).toBe(true);
    expect(result.item!.visualReviewRequired).toBe(true); // nunca "corrigido" por edicao de texto
  });
});
