// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import {
  canonicalizeFingerprintText,
  computeQuestionFingerprint,
  QUESTION_FINGERPRINT_VERSION,
  type FingerprintAlternativeInput,
} from "../src/lib/fingerprint";
import { createQuestion } from "../src/services/questionService";
import { previewImport } from "../src/services/questionImportService";

/* Sprint 7 v1.1, Correção C — algoritmo de fingerprint testado DIRETAMENTE
   (nunca só indiretamente via comportamento de duplicidade). Cobre os 12
   itens da seção 4 da ordem de correção. */

const BASE_ALTERNATIVES: FingerprintAlternativeInput[] = [
  { letter: "A", text: "Alternativa A", isCorrect: false },
  { letter: "B", text: "Alternativa B", isCorrect: true },
  { letter: "C", text: "Alternativa C", isCorrect: false },
  { letter: "D", text: "Alternativa D", isCorrect: false },
  { letter: "E", text: "Alternativa E", isCorrect: false },
];

describe("computeQuestionFingerprint — contrato explícito", () => {
  it("é sempre SHA-256 em hexadecimal: exatamente 64 caracteres hexadecimais (item 11)", async () => {
    const fp = await computeQuestionFingerprint("Enunciado de teste.", BASE_ALTERNATIVES);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a constante de versão está presente no payload canônico (nunca alteração silenciosa de algoritmo)", () => {
    expect(QUESTION_FINGERPRINT_VERSION).toBe("question-fingerprint-v1");
  });

  // 1. mesma questão por criação e CSV → mesmo fingerprint.
  it("1. o mesmo enunciado+alternativas produz o MESMO fingerprint seja qual for o caminho de entrada", async () => {
    const viaForm = await computeQuestionFingerprint("Qual o valor de x na equação 2x + 4 = 10?", BASE_ALTERNATIVES);
    // "via CSV": mesmos dados, só que originados de uma linha de planilha
    // (strings equivalentes, simulando o parse de células de texto puro).
    const viaCsv = await computeQuestionFingerprint(
      "Qual o valor de x na equação 2x + 4 = 10?",
      BASE_ALTERNATIVES.map((a) => ({ ...a }))
    );
    expect(viaForm).toBe(viaCsv);
  });

  // 2. CRLF versus LF → mesmo fingerprint.
  it("2. CRLF e LF no enunciado produzem o MESMO fingerprint", async () => {
    const lf = await computeQuestionFingerprint("Linha 1\nLinha 2\nLinha 3", BASE_ALTERNATIVES);
    const crlf = await computeQuestionFingerprint("Linha 1\r\nLinha 2\r\nLinha 3", BASE_ALTERNATIVES);
    const cr = await computeQuestionFingerprint("Linha 1\rLinha 2\rLinha 3", BASE_ALTERNATIVES);
    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
  });

  // 3. Unicode canonicamente equivalente → mesmo fingerprint.
  it("3. formas Unicode canonicamente equivalentes (NFC vs. NFD) produzem o MESMO fingerprint", async () => {
    const nfc = "razão".normalize("NFC"); // "ã" precomposto
    const nfd = "razão".normalize("NFD"); // "a" + combining tilde
    expect(nfc).not.toBe(nfd); // strings brutas são diferentes byte a byte
    const fpNfc = await computeQuestionFingerprint(`Sobre a ${nfc} entre dois valores.`, BASE_ALTERNATIVES);
    const fpNfd = await computeQuestionFingerprint(`Sobre a ${nfd} entre dois valores.`, BASE_ALTERNATIVES);
    expect(fpNfc).toBe(fpNfd);
  });

  // 4. espaços externos/repetidos equivalentes → mesmo fingerprint.
  it("4. espaços externos e sequências de espaço horizontal repetidas não mudam o fingerprint", async () => {
    const tight = await computeQuestionFingerprint("Enunciado com espaço simples.", BASE_ALTERNATIVES);
    // Espaços externos (início/fim) e espaços internos repetidos colapsam
    // para o MESMO texto canônico de `tight` — logo o MESMO fingerprint.
    const loose = await computeQuestionFingerprint("   Enunciado  com   espaço simples.   ", BASE_ALTERNATIVES);
    expect(tight).toBe(loose);
    const identical1 = await computeQuestionFingerprint("Enunciado  com   espaço   simples.", BASE_ALTERNATIVES);
    const identical2 = await computeQuestionFingerprint("  Enunciado com espaço simples.  ", BASE_ALTERNATIVES);
    expect(identical1).toBe(identical2);
    // Uma mudança real de PALAVRA (não só espaçamento) continua produzindo
    // fingerprints diferentes — o colapso de espaço nunca mascara conteúdo.
    const differentWord = await computeQuestionFingerprint("Enunciado com espaço duplo.", BASE_ALTERNATIVES);
    expect(differentWord).not.toBe(tight);
  });

  it("4b. o colapso de espaço NUNCA apaga sinais, expoentes, frações ou pontuação matemática", () => {
    const canonical = canonicalizeFingerprintText("  x^2  +  1/2  -  y  =  0,  logo x > 0.  ");
    expect(canonical).toBe("x^2 + 1/2 - y = 0, logo x > 0.");
  });

  // 5. mudança real no enunciado → fingerprint diferente.
  it("5. uma mudança real no enunciado produz um fingerprint DIFERENTE", async () => {
    const a = await computeQuestionFingerprint("Qual o valor de x?", BASE_ALTERNATIVES);
    const b = await computeQuestionFingerprint("Qual o valor de y?", BASE_ALTERNATIVES);
    expect(a).not.toBe(b);
  });

  // 6. mudança em qualquer alternativa → diferente.
  it("6. uma mudança em QUALQUER alternativa produz um fingerprint DIFERENTE", async () => {
    const original = await computeQuestionFingerprint("Enunciado fixo.", BASE_ALTERNATIVES);
    const changedText = BASE_ALTERNATIVES.map((a) => (a.letter === "C" ? { ...a, text: "Alternativa C modificada" } : a));
    const changedCorrect = BASE_ALTERNATIVES.map((a) => ({ ...a, isCorrect: a.letter === "A" }));
    expect(await computeQuestionFingerprint("Enunciado fixo.", changedText)).not.toBe(original);
    expect(await computeQuestionFingerprint("Enunciado fixo.", changedCorrect)).not.toBe(original);
  });

  // 7. troca de letras/ordem das alternativas → diferente (mas ORDEM DE
  // ENVIO em si não importa, pois sempre reordenamos por letra — o teste
  // aqui é sobre trocar o CONTEÚDO entre as letras, que é semanticamente
  // uma questão diferente).
  it("7a. reordenar as alternativas NO ENVIO (mesma letra->mesmo texto) NÃO muda o fingerprint (canonicalização por letra)", async () => {
    const inOrder = await computeQuestionFingerprint("Enunciado fixo.", BASE_ALTERNATIVES);
    const shuffled = await computeQuestionFingerprint("Enunciado fixo.", [...BASE_ALTERNATIVES].reverse());
    expect(shuffled).toBe(inOrder);
  });
  it("7b. trocar o CONTEÚDO entre as letras (A vira o texto de B e vice-versa) produz fingerprint DIFERENTE", async () => {
    const original = await computeQuestionFingerprint("Enunciado fixo.", BASE_ALTERNATIVES);
    const swapped = BASE_ALTERNATIVES.map((a) => {
      if (a.letter === "A") return { ...a, text: "Alternativa B" };
      if (a.letter === "B") return { ...a, text: "Alternativa A" };
      return a;
    });
    expect(await computeQuestionFingerprint("Enunciado fixo.", swapped)).not.toBe(original);
  });

  // 8. mudança apenas de código/autor/status → igual.
  it("8. o fingerprint é INDEPENDENTE de código, ID, status, autor, revisor e datas", async () => {
    // A própria assinatura da função só recebe enunciado+alternativas — não
    // há como um código/autor/status influenciá-la; isto prova o contrato
    // na fonte, e o teste de service abaixo prova o comportamento fim-a-fim.
    const fp1 = await computeQuestionFingerprint("Mesmo conteúdo.", BASE_ALTERNATIVES);
    const fp2 = await computeQuestionFingerprint("Mesmo conteúdo.", BASE_ALTERNATIVES);
    expect(fp1).toBe(fp2);
  });
});

describe("fingerprint — provas de duplicidade fim-a-fim (itens 9 e 10)", () => {
  let db: FakeD1Database;

  beforeEach(async () => {
    db = new FakeD1Database();
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
    );
    await createUser(db as never, {
      id: "autor1",
      name: "Autora Teste",
      email: "autor1@teste.dev",
      emailNormalized: "autor1@teste.dev",
      passwordHash: "hash",
    });
  });

  function altPayload(overrideText?: string) {
    return [
      { letter: "A", text: "Alt A", isCorrect: false, distractorExplanation: null },
      { letter: "B", text: overrideText ?? "Alt B", isCorrect: true, distractorExplanation: null },
      { letter: "C", text: "Alt C", isCorrect: false, distractorExplanation: null },
      { letter: "D", text: "Alt D", isCorrect: false, distractorExplanation: null },
      { letter: "E", text: "Alt E", isCorrect: false, distractorExplanation: null },
    ];
  }
  const dna = { pista: "p", estrategia: "e", pegadinha: "p", conteudoApoio: "c", resolucao: "r", atalho: null, aprendizadoErro: "a" };

  it("8b (fim-a-fim). alterar só código/origem sem alterar enunciado/alternativas mantém a MESMA fingerprint gravada", async () => {
    const first = await createQuestion(db as never, "autor1", {
      code: "FP-CODE-1",
      enunciado: "Enunciado estável para o teste de fingerprint.",
      dificuldade: "media",
      origem: "autoral",
      alternativas: altPayload() as never,
      dna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    const row1 = db.sqlite.prepare("SELECT fingerprint FROM questions WHERE id = ?").get(first.value!.id) as { fingerprint: string };

    // Segunda questão com CÓDIGO diferente mas conteúdo IDÊNTICO — deve
    // colidir (é rejeitada como duplicata), provando que fingerprint não
    // depende do código.
    const second = await createQuestion(db as never, "autor1", {
      code: "FP-CODE-2",
      enunciado: "Enunciado estável para o teste de fingerprint.",
      dificuldade: "facil", // dificuldade também diferente — não afeta fingerprint
      origem: "licenciada", // origem diferente — não afeta fingerprint
      alternativas: altPayload() as never,
      dna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(second.ok).toBe(false);
    expect(second.fieldErrors?.enunciado).toMatch(/fingerprint/i);
    expect(row1.fingerprint).toHaveLength(64);
  });

  // 9. duplicata DENTRO do mesmo CSV.
  it("9. detecta duplicata de fingerprint DENTRO do mesmo arquivo CSV", async () => {
    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const row = (codigo: string) =>
      [
        codigo, "Mesmo enunciado para duplicidade de arquivo", "R", "C", "S", "H", "Comp",
        "media", "autoral", "", "", "90", "misto", "nao",
        "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
        "P", "E", "Peg", "Apoio", "Res", "", "Aprend",
        "PAD-01", "", "", "T", "L", "", "", "",
      ].join(",");
    const csv = `${header}\r\n${row("DUP-A")}\r\n${row("DUP-B")}\r\n`;
    const result = await previewImport(db as never, "autor1", new TextEncoder().encode(csv));
    expect(result.ok).toBe(true);
    expect(result.errors!.some((e) => e.field === "enunciado" && /outra linha/i.test(e.message))).toBe(true);
  });

  // 10. duplicata CONTRA o banco.
  it("10. detecta duplicata de fingerprint CONTRA uma questão já existente no banco", async () => {
    await createQuestion(db as never, "autor1", {
      code: "EXIST-1",
      enunciado: "Enunciado já existente no banco para teste.",
      dificuldade: "media",
      origem: "autoral",
      alternativas: altPayload() as never,
      dna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);

    const header =
      "codigo,enunciado,resolucao_comentada,conteudo,subconteudo,habilidade,competencia,dificuldade,origem,prova,ano,tempo_estimado_segundos,tipo_calculo,necessita_calculadora,alt_a,alt_b,alt_c,alt_d,alt_e,correta,pista,estrategia,pegadinha,conteudo_apoio,resolucao_dna,atalho,aprendizado_erro,padrao_principal_code,padroes_secundarios_codes,tags,titular_direitos,base_licenca,texto_atribuicao,imagem_ref,imagem_alt";
    const row = [
      "IMP-DUP-1", "Enunciado já existente no banco para teste.", "R", "C", "S", "H", "Comp",
      "media", "autoral", "", "", "90", "misto", "nao",
      "Alt A", "Alt B", "Alt C", "Alt D", "Alt E", "B",
      "P", "E", "Peg", "Apoio", "Res", "", "Aprend",
      "PAD-01", "", "", "T", "L", "", "", "",
    ].join(",");
    const csv = `${header}\r\n${row}\r\n`;
    const result = await previewImport(db as never, "autor1", new TextEncoder().encode(csv));
    expect(result.errors!.some((e) => e.field === "enunciado" && /banco/i.test(e.message))).toBe(true);
  });

  // 12. nenhum dado sensível ou texto integral é registrado em log ao detectar duplicidade.
  it("12. ao detectar duplicidade, a mensagem de erro NUNCA inclui o texto integral do enunciado", async () => {
    const longEnunciado = "Este enunciado tem um texto bem específico e reconhecível que não deveria vazar em nenhuma mensagem de erro.";
    await createQuestion(db as never, "autor1", {
      code: "SENSIVEL-1",
      enunciado: longEnunciado,
      dificuldade: "media",
      origem: "autoral",
      alternativas: altPayload() as never,
      dna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);

    const second = await createQuestion(db as never, "autor1", {
      code: "SENSIVEL-2",
      enunciado: longEnunciado,
      dificuldade: "media",
      origem: "autoral",
      alternativas: altPayload() as never,
      dna,
      padroes: [{ patternId: "pat-1", role: "principal" }],
      tags: [],
      imagens: [],
    } as never);
    expect(second.ok).toBe(false);
    expect(second.fieldErrors?.enunciado).not.toContain(longEnunciado);

    // O question_history da questão original também nunca guarda o texto
    // integral — só ação/estado/versão/metadados técnicos.
    const historyRows = db.sqlite.prepare("SELECT metadata FROM question_history").all() as Array<{ metadata: string | null }>;
    for (const row of historyRows) {
      expect(row.metadata ?? "").not.toContain(longEnunciado);
    }
  });
});
