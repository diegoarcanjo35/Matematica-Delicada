// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { applyImport, buildImportErrorReportCsv, IMPORT_CSV_HEADERS, previewImport, undoImport } from "../src/services/questionImportService";
import { hasDangerousLeadingCharacter, neutralizeForCsvExport, parseCsv, serializeCsvReport } from "../src/lib/csv";

let db: FakeD1Database;

beforeEach(async () => {
  db = new FakeD1Database();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
  await createUser(db as never, {
    id: "editor1",
    name: "Editora Teste",
    email: "editor1@teste.dev",
    emailNormalized: "editor1@teste.dev",
    passwordHash: "hash",
  });
  await createUser(db as never, {
    id: "admin1",
    name: "Admin Teste",
    email: "admin1@teste.dev",
    emailNormalized: "admin1@teste.dev",
    passwordHash: "hash",
  });
});

function buildCsvRow(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    codigo: "IMP-001",
    enunciado: "Enunciado de teste de importação suficientemente longo.",
    resolucao_comentada: "Resolução de teste.",
    conteudo: "Conteúdo",
    subconteudo: "Subconteúdo",
    habilidade: "Habilidade",
    competencia: "Competência",
    dificuldade: "media",
    origem: "autoral",
    prova: "",
    ano: "",
    tempo_estimado_segundos: "90",
    tipo_calculo: "misto",
    necessita_calculadora: "nao",
    alt_a: "Alt A",
    alt_b: "Alt B",
    alt_c: "Alt C",
    alt_d: "Alt D",
    alt_e: "Alt E",
    correta: "B",
    pista: "Pista",
    estrategia: "Estratégia",
    pegadinha: "Pegadinha",
    conteudo_apoio: "Apoio",
    resolucao_dna: "Resolução DNA",
    atalho: "",
    aprendizado_erro: "Aprendizado",
    padrao_principal_code: "PAD-01",
    padroes_secundarios_codes: "",
    tags: "importacao;teste",
    titular_direitos: "Fixture",
    base_licenca: "Interno",
    texto_atribuicao: "",
    imagem_ref: "",
    imagem_alt: "",
  };
  return { ...base, ...overrides };
}

function toCsv(rows: Array<Record<string, string>>): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = IMPORT_CSV_HEADERS.join(",");
  const lines = rows.map((row) => IMPORT_CSV_HEADERS.map((h) => escape(row[h] ?? "")).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("CSV parser (lib/csv.ts)", () => {
  it("aceita aspas, vírgulas e quebras de linha dentro de campo entre aspas", () => {
    const result = parseCsv('a,b\n"linha, com vírgula","quebra\nde linha"\n', 100);
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([["a", "b"], ["linha, com vírgula", "quebra\nde linha"]]);
  });

  it("CSV malformado (aspas não fechadas) retorna erro controlado, nunca lança", () => {
    const result = parseCsv('a,"b\n', 100);
    expect(result.ok).toBe(false);
  });

  it("arquivo vazio retorna erro controlado", () => {
    expect(parseCsv("", 100).ok).toBe(false);
  });

  it("respeita o limite de linhas", () => {
    const many = Array.from({ length: 10 }, (_, i) => `v${i}`).join("\n");
    const result = parseCsv(`h\n${many}\n`, 5);
    expect(result.ok).toBe(false);
  });
});

/* Sprint 7 v1.1, Correção B — a importação NUNCA rejeita conteúdo
   matemático legítimo por causa do primeiro caractere; a neutralização de
   fórmula existe SÓ na exportação/relatório CSV. */
describe("Correção B — detecção/neutralização (só para EXPORTAÇÃO)", () => {
  it.each(["=SOMA(A1)", "+1+1", "-1", "@cmd"])("detecta prefixo perigoso: %s", (value) => {
    expect(hasDangerousLeadingCharacter(value)).toBe(true);
  });
  it("texto normal não é sinalizado", () => {
    expect(hasDangerousLeadingCharacter("Texto normal")).toBe(false);
  });
  it("espaços antes do prefixo NÃO escapam da neutralização", () => {
    expect(hasDangerousLeadingCharacter("   =SOMA(A1)")).toBe(true);
    expect(hasDangerousLeadingCharacter("\t+3")).toBe(true);
  });
  it("neutraliza prefixando aspa simples no início absoluto (antes até do espaço)", () => {
    expect(neutralizeForCsvExport("=SOMA(A1)")).toBe("'=SOMA(A1)");
    expect(neutralizeForCsvExport("  -5")).toBe("'  -5");
  });
  it("conteúdo comum NUNCA recebe apóstrofo desnecessário", () => {
    expect(neutralizeForCsvExport("Razão e proporção")).toBe("Razão e proporção");
    expect(neutralizeForCsvExport("5 - 3 = 2")).toBe("5 - 3 = 2"); // não começa por caractere perigoso
  });
  it("serializeCsvReport neutraliza os quatro prefixos em TODAS as células (cabeçalho e valor)", () => {
    const csv = serializeCsvReport(
      ["=campo", "coluna"],
      [
        ["=valor", "+outro"],
        ["-terceiro", "@quarto"],
      ]
    );
    const lines = csv.split("\r\n").filter(Boolean);
    for (const line of lines) {
      // Nenhuma célula "efetiva" (após separar por vírgula) começa por um
      // caractere perigoso — a primeira coisa em cada célula neutralizada é
      // sempre a aspa simples.
      for (const rawCell of line.split(",")) {
        const cell = rawCell.replace(/^"|"$/g, "");
        expect(hasDangerousLeadingCharacter(cell) && !cell.startsWith("'")).toBe(false);
      }
    }
    expect(csv).toContain("'=campo");
    expect(csv).toContain("'+outro");
    expect(csv).toContain("'-terceiro");
    expect(csv).toContain("'@quarto");
  });
  it("escaping RFC4180 (aspas, vírgulas, CRLF/LF) continua obrigatório independentemente da neutralização", () => {
    const csv = serializeCsvReport(["campo"], [['contém "aspas", vírgula e\nquebra']]);
    expect(csv).toContain('"contém ""aspas"", vírgula e\nquebra"');
  });
  it("nenhuma fórmula executável aparece como primeira célula efetiva do relatório exportado", () => {
    const csv = buildImportErrorReportCsv([
      { row: 2, field: "enunciado", message: "= problema", value: "=2x+4" },
    ]);
    const firstDataLine = csv.split("\r\n")[1];
    const firstCell = firstDataLine.split(",")[0];
    expect(firstCell.startsWith("=")).toBe(false); // é "2" (o número da linha), não fórmula
    expect(csv).toContain("'=2x+4"); // o valor original aparece neutralizado
  });
});

describe("previewImport", () => {
  it("template tem todos os cabeçalhos usados na validação", () => {
    const csv = toCsv([buildCsvRow()]);
    expect(csv.startsWith(IMPORT_CSV_HEADERS.join(","))).toBe(true);
  });

  it("CSV válido gera prévia sem erros e NÃO cria nenhuma questão", async () => {
    const csv = toCsv([buildCsvRow()]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.validRowCount).toBe(1);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0);
  });

  it("aceita BOM UTF-8 no início do arquivo", async () => {
    const csv = "﻿" + toCsv([buildCsvRow()]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it("cabeçalho ausente é rejeitado com erro controlado", async () => {
    const csv = "codigo,enunciado\nIMP-1,teste\n";
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_header");
  });

  it("arquivo vazio é rejeitado", async () => {
    const result = await previewImport(db as never, "editor1", bytes(""));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  it("arquivo maior que o limite é rejeitado (payload too large tratado no service)", async () => {
    const big = new Uint8Array(400 * 1024);
    const result = await previewImport(db as never, "editor1", big);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("too_large");
  });

  it("linha com número de colunas diferente do cabeçalho gera erro por linha", async () => {
    const csv = IMPORT_CSV_HEADERS.join(",") + "\r\n" + "valor_unico\r\n";
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("detecta código duplicado DENTRO do arquivo", async () => {
    const csv = toCsv([buildCsvRow({ codigo: "DUP" }), buildCsvRow({ codigo: "DUP", enunciado: "Outro enunciado bem diferente do primeiro para não colidir fingerprint." })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.ok).toBe(true);
    expect(result.errors!.some((e) => e.field === "codigo" && /duplicado no arquivo/i.test(e.message))).toBe(true);
  });

  it("detecta código já existente NO BANCO", async () => {
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('qx','IMP-001','x','media','autoral','fp-x')`
    );
    const csv = toCsv([buildCsvRow()]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errors!.some((e) => e.field === "codigo" && /já existe.*banco/i.test(e.message))).toBe(true);
  });

  it("detecta fingerprint duplicada DENTRO do arquivo (mesmo enunciado, código diferente)", async () => {
    const csv = toCsv([buildCsvRow({ codigo: "A1" }), buildCsvRow({ codigo: "A2" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errors!.some((e) => e.field === "enunciado" && /outra linha/i.test(e.message))).toBe(true);
  });

  it("valida padrão principal por código sem criar padrão novo", async () => {
    const csv = toCsv([buildCsvRow({ padrao_principal_code: "PAD-INEXISTENTE" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errors!.some((e) => e.field === "padrao_principal_code")).toBe(true);
    const patternCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM patterns").get() as { total: number }).total;
    expect(patternCount).toBe(1); // só o PAD-01 semeado no beforeEach, nenhum novo
  });

  it("Correção B — alternativa '-5' é importada sem erro (conteúdo matemático legítimo)", async () => {
    const csv = toCsv([buildCsvRow({ alt_a: "-5", codigo: "MATH-1" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errors!.some((e) => e.field === "alt_a")).toBe(false);
    expect(result.errorCount).toBe(0);
  });

  it("Correção B — alternativa '+3' é importada sem erro", async () => {
    const csv = toCsv([buildCsvRow({ alt_b: "+3", correta: "B", codigo: "MATH-2" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errors!.some((e) => e.field === "alt_b")).toBe(false);
    expect(result.errorCount).toBe(0);
  });

  it("Correção B — enunciado começando com '= 2x + 4' é importado sem erro", async () => {
    const csv = toCsv([buildCsvRow({ enunciado: "= 2x + 4, resolva para x", codigo: "MATH-3" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errors!.some((e) => e.field === "enunciado")).toBe(false);
    expect(result.errorCount).toBe(0);
  });

  it("Correção B — texto começando com '@ representa...' é importado sem erro", async () => {
    const csv = toCsv([buildCsvRow({ pista: "@ representa uma variável no plano cartesiano", codigo: "MATH-4" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    expect(result.errorCount).toBe(0);
  });

  it("Correção B — conteúdo armazenado é preservado BYTE A BYTE após o parse normalizado", async () => {
    const originalEnunciado = "= 2x + 4  precisa   preservar   espaços e o sinal -, +, = e @.";
    const csv = toCsv([buildCsvRow({ enunciado: originalEnunciado, codigo: "MATH-5" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.errorCount).toBe(0);
    const applied = await applyImport(db as never, "editor1", preview.batchId!);
    const row = db.sqlite.prepare("SELECT enunciado FROM questions WHERE id = ?").get(applied.questionIds![0]) as { enunciado: string };
    // O parser CSV (RFC4180) não deve alterar o conteúdo do campo em si —
    // só remove as aspas/escaping do FORMATO CSV, nunca o conteúdo humano.
    expect(row.enunciado).toBe(originalEnunciado);
  });

  it("nunca grava conteúdo bruto de linha inválida no payload do lote (só campo+mensagem)", async () => {
    const csv = toCsv([buildCsvRow({ codigo: "" })]);
    const result = await previewImport(db as never, "editor1", bytes(csv));
    const batch = db.sqlite.prepare("SELECT payload FROM question_import_batches WHERE id = ?").get(result.batchId) as { payload: string };
    expect(batch.payload).toBe("[]");
  });
});

describe("applyImport", () => {
  it("aplica um lote válido: cria todas as questões como draft, atômico", async () => {
    const csv = toCsv([buildCsvRow({ codigo: "A1" }), buildCsvRow({ codigo: "A2", enunciado: "Segundo enunciado bem diferente do primeiro para fingerprint distinta." })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.canApply ?? preview.errorCount === 0).toBeTruthy();

    const result = await applyImport(db as never, "editor1", preview.batchId!);
    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBe(2);
    const rows = db.sqlite.prepare("SELECT code, editorial_status FROM questions ORDER BY code").all() as Array<{ code: string; editorial_status: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.editorial_status).toBe("draft");
  });

  it("preview com erros pendentes NÃO pode ser aplicado", async () => {
    const csv = toCsv([buildCsvRow({ codigo: "" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    const result = await applyImport(db as never, "editor1", preview.batchId!);
    expect(result.ok).toBe(false);
    expect(result.invalid).toBe(true);
  });

  it("preview expirado não pode ser aplicado", async () => {
    const csv = toCsv([buildCsvRow()]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    db.sqlite.exec(`UPDATE question_import_batches SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${preview.batchId}'`);
    const result = await applyImport(db as never, "editor1", preview.batchId!);
    expect(result.ok).toBe(false);
    expect(result.expired).toBe(true);
  });

  it("apply é IDEMPOTENTE: aplicar o mesmo lote duas vezes não duplica questões", async () => {
    const csv = toCsv([buildCsvRow()]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    const first = await applyImport(db as never, "editor1", preview.batchId!);
    expect(first.ok).toBe(true);
    const second = await applyImport(db as never, "editor1", preview.batchId!);
    expect(second.ok).toBe(true);
    expect(second.alreadyApplied).toBe(true);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(1);
  });

  it("ATOMICIDADE: falha forçada numa linha do meio do lote reverte TODAS as questões (nenhuma parcial)", async () => {
    const csv = toCsv([
      buildCsvRow({ codigo: "B1" }),
      buildCsvRow({ codigo: "B2", enunciado: "Segundo enunciado distinto o suficiente para não colidir fingerprint um." }),
      buildCsvRow({ codigo: "B3", enunciado: "Terceiro enunciado ainda mais distinto para garantir fingerprint única também." }),
    ]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    db.failNextMatching(/INSERT INTO question_alternatives/);
    // applyImport converte uma falha do db.batch() num resultado controlado
    // (nunca deixa o erro cru escapar para a rota) — a prova de atomicidade
    // é que NENHUMA questão do lote persiste, não que a promise rejeite.
    const result = await applyImport(db as never, "editor1", preview.batchId!);
    expect(result.ok).toBe(false);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0);
  });
});

describe("undoImport", () => {
  async function applyValidBatch(): Promise<{ batchId: string; questionIds: string[] }> {
    const csv = toCsv([buildCsvRow()]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    const result = await applyImport(db as never, "editor1", preview.batchId!);
    return { batchId: preview.batchId!, questionIds: result.questionIds ?? [] };
  }

  it("admin desfaz um lote aplicado com todas as questões ainda em draft", async () => {
    const { batchId, questionIds } = await applyValidBatch();
    const result = await undoImport(db as never, "admin1", batchId);
    expect(result.ok).toBe(true);
    expect(result.undoneCount).toBe(1);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(0);
    for (const id of questionIds) {
      const alt = (db.sqlite.prepare("SELECT COUNT(*) as total FROM question_alternatives WHERE question_id = ?").get(id) as { total: number }).total;
      expect(alt).toBe(0);
    }
  });

  it("undo é bloqueado se a questão do lote já saiu de draft (ex.: enviada para revisão)", async () => {
    const { batchId, questionIds } = await applyValidBatch();
    // Sprint 7 v1.3 — não bumpar `version` aqui: o trigger
    // trg_questions_require_history_after_update (migrations/0009) exige
    // uma linha de question_history correspondente para toda MUDANÇA de
    // version; este teste só precisa que o status não seja mais 'draft' —
    // um UPDATE direto por SQL que muda só o status (nunca a version) não
    // aciona o trigger.
    db.sqlite.exec(`UPDATE questions SET editorial_status = 'in_review' WHERE id = '${questionIds[0]}'`);
    const result = await undoImport(db as never, "admin1", batchId);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    const count = (db.sqlite.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    expect(count).toBe(1); // nada foi removido — undo é tudo ou nada
  });

  it("undo NUNCA apaga o padrão vinculado", async () => {
    await applyValidBatch();
    const patternCountBefore = (db.sqlite.prepare("SELECT COUNT(*) as total FROM patterns").get() as { total: number }).total;
    const batch = db.sqlite.prepare("SELECT id FROM question_import_batches").get() as { id: string };
    await undoImport(db as never, "admin1", batch.id);
    const patternCountAfter = (db.sqlite.prepare("SELECT COUNT(*) as total FROM patterns").get() as { total: number }).total;
    expect(patternCountAfter).toBe(patternCountBefore);
  });

  it("undo é IDEMPOTENTE: desfazer o mesmo lote duas vezes não falha e não afeta nada na segunda vez", async () => {
    const { batchId } = await applyValidBatch();
    const first = await undoImport(db as never, "admin1", batchId);
    expect(first.ok).toBe(true);
    const second = await undoImport(db as never, "admin1", batchId);
    expect(second.ok).toBe(true);
    expect(second.alreadyUndone).toBe(true);
    expect(second.undoneCount).toBe(0);
  });

  it("undo em lote inexistente retorna notFound", async () => {
    const result = await undoImport(db as never, "admin1", "lote-inexistente");
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });

  it("undo em lote nunca aplicado (só previsto) é bloqueado", async () => {
    const csv = toCsv([buildCsvRow()]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    const result = await undoImport(db as never, "admin1", preview.batchId!);
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
  });
});
