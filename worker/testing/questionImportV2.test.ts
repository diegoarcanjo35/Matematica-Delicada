// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { previewImport } from "../src/services/questionImportService";
import { buildTemplateCsvV2, IMPORT_CSV_V2_HEADERS } from "../src/lib/questionImportV2";

/* Sprint 19, seção 3/19 da ordem — CSV V2 (template simplificado, sem
   imagem, sem campos legados de DNA). Mesmo padrão de harness de
   worker/testing/questionImports.test.ts (FakeD1Database real, usuários
   reais). */

let db: FakeD1Database;

beforeEach(async () => {
  db = new FakeD1Database();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-1', 'PAD-01', 'padrao-escala', 'Escala e Proporção', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
  await createUser(db as never, { id: "editor1", name: "Editora Teste", email: "editor1@teste.dev", emailNormalized: "editor1@teste.dev", passwordHash: "hash" });
});

function buildV2Row(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {
    codigo: "V2-001",
    enunciado: "Enunciado de teste V2 suficientemente longo para passar na validação.",
    resolucao_comentada: "Resolução comentada de teste.",
    dificuldade: "media",
    origem: "autoral",
    prova: "ENEM",
    ano: "2024",
    alt_a: "Alternativa A",
    alt_b: "Alternativa B",
    alt_c: "Alternativa C",
    alt_d: "Alternativa D",
    alt_e: "Alternativa E",
    correta: "B",
    macete: "Macete de teste.",
    padrao_principal: "Escala e Proporção",
    padroes_secundarios: "",
    tags: "teste;v2",
    titular_direitos: "Fixture",
    base_licenca: "Interno",
    texto_atribuicao: "",
  };
  return { ...base, ...overrides };
}

function toCsvV2(rows: Array<Record<string, string>>): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = IMPORT_CSV_V2_HEADERS.join(",");
  const lines = rows.map((row) => IMPORT_CSV_V2_HEADERS.map((h) => escape(row[h] ?? "")).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("Sprint 19 — CSV V2 (itens 1-6/9 da política de testes)", () => {
  it("item 1 — template V2 possui SOMENTE os campos definidos, sem linha de exemplo inválida", () => {
    const template = buildTemplateCsvV2();
    const lines = template.trim().split("\r\n");
    expect(lines).toHaveLength(1); // só cabeçalho.
    expect(lines[0].split(",")).toEqual([...IMPORT_CSV_V2_HEADERS]);
    // Nunca colunas do V1/legadas.
    expect(template).not.toMatch(/imagem_ref|imagem_alt|pista|pegadinha|resolucao_dna|aprendizado_erro|conteudo\b/);
  });

  it("item 9 — template não contém exemplo inválido (nenhum código de padrão hardcoded como PAD-01)", () => {
    const template = buildTemplateCsvV2();
    expect(template).not.toMatch(/PAD-01/);
  });

  it("item 2 — CSV V2 válido gera preview aplicável", async () => {
    const csv = toCsvV2([buildV2Row()]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
  });

  it("item 3 — macete mapeia para dna.estrategia; demais campos de DNA legados ficam vazios", async () => {
    const csv = toCsvV2([buildV2Row({ macete: "Somar as duas parcelas." })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
    // O payload persistido não é exposto pela API — verificado indiretamente
    // via aplicação real na suíte de questionPackageImport/questions; aqui
    // confirmamos que o preview aceita `macete` como único campo de DNA e
    // não exige nenhum dos legados (nenhum erro de campo ausente).
  });

  it("item 4 — padrão principal resolve por NOME", async () => {
    const csv = toCsvV2([buildV2Row({ padrao_principal: "Escala e Proporção" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
  });

  it("item 5 — padrão principal resolve por CÓDIGO (compatibilidade técnica)", async () => {
    const csv = toCsvV2([buildV2Row({ padrao_principal: "PAD-01" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
  });

  it("padrão principal resolve por nome com diferença de maiúsculas/minúsculas (normalizado)", async () => {
    const csv = toCsvV2([buildV2Row({ padrao_principal: "escala e proporção" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
  });

  it("item 6 — padrão inexistente bloqueia com mensagem clara (nunca cria padrão)", async () => {
    const csv = toCsvV2([buildV2Row({ padrao_principal: "Padrão Que Não Existe" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(1);
    expect(preview.errors![0].field).toBe("padrao_principal");
    expect(preview.errors![0].message).toMatch(/não existe/);
    const patternCount = (db.sqlite.prepare("SELECT COUNT(*) as total FROM patterns").get() as { total: number }).total;
    expect(patternCount).toBe(1); // nenhum novo padrão criado.
  });

  it("padrões secundários também resolvem por nome/código, separados por ';'", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-2', 'PAD-02', 'padrao-2', 'Padrão Secundário', 'F', 'D', 'E', 'X', 'R', 'published')`
    );
    const csv = toCsvV2([buildV2Row({ padroes_secundarios: "PAD-02" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
  });

  it("campos obrigatórios do V2 (macete, padrao_principal) bloqueiam quando vazios", async () => {
    const csv = toCsvV2([buildV2Row({ macete: "", padrao_principal: "" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBeGreaterThanOrEqual(2);
    const fields = preview.errors!.map((e) => e.field);
    expect(fields).toContain("macete");
    expect(fields).toContain("padrao_principal");
  });

  it("cabeçalho V2 é detectado automaticamente (mesmo endpoint que o V1)", async () => {
    const csv = toCsvV2([buildV2Row({ codigo: "V2-AUTO" })]);
    const preview = await previewImport(db as never, "editor1", bytes(csv));
    expect(preview.ok).toBe(true);
    expect(preview.errorCount).toBe(0);
  });
});
