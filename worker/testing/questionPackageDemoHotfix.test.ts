// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { FakeD1Database } from "./fakeD1";
import { createUser } from "../src/repositories/userRepository";
import { previewPackage } from "../src/services/questionPackageImportService";
import { IMPORT_CSV_V2_HEADERS } from "../src/lib/questionImportV2";

/* Hotfix pós-Sprint 24.1, Seções 1 e 8 da ordem — o ZIP que a Andreia
   tentou importar usava `questoes-teste-corrigido.csv` (nome errado) e não
   tinha `manifest.json`, então o contrato atual (`ALLOWED_ROOT_ENTRIES =
   ["questoes.csv", "manifest.json"]`, ver questionPackageImportService.ts)
   rejeita o pacote — isso é o VALIDADOR funcionando corretamente, nunca um
   bug. Esta suíte prova as duas pontas: (1) reproduz o mesmo tipo de rejeição
   que ela viu, com a MESMA mensagem de erro que o preview real devolve; (2)
   entrega um pacote de demonstração 100% válido, no contrato REAL (não no
   texto da própria ordem, que usa nomes em inglês desatualizados). */

let db: FakeD1Database;

beforeEach(async () => {
  db = new FakeD1Database();
  db.sqlite.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('pat-demo-1', 'PAD-DEMO-01', 'padrao-demo-escala', 'Escala e Proporção', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
  await createUser(db as never, { id: "demo-editor-1", name: "Editora Demo", email: "demo-editor@teste.dev", emailNormalized: "demo-editor@teste.dev", passwordHash: "hash" });
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

function escapeCsv(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function buildCsvV2(rows: Array<Record<string, string>>): string {
  const header = IMPORT_CSV_V2_HEADERS.join(",");
  const lines = rows.map((row) => IMPORT_CSV_V2_HEADERS.map((h) => escapeCsv(row[h] ?? "")).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

const demoCsvRow: Record<string, string> = {
  codigo: "DEMO-001",
  enunciado: "Um mapa está desenhado na escala 1:500000. Qual é a distância real, em quilômetros, correspondente a 2cm no mapa?",
  resolucao_comentada: "Na escala 1:500000, 1cm no mapa equivale a 500000cm (5km) na realidade. Logo, 2cm equivalem a 10km.",
  dificuldade: "media",
  origem: "autoral",
  prova: "ENEM",
  ano: "2024",
  alt_a: "2km",
  alt_b: "5km",
  alt_c: "10km",
  alt_d: "20km",
  alt_e: "50km",
  correta: "C",
  macete: "Multiplique a medida no mapa pelo denominador da escala e converta a unidade.",
  padrao_principal: "Escala e Proporção",
  padroes_secundarios: "",
  tags: "escala;proporcao;demo",
  titular_direitos: "Matemática Delicada",
  base_licenca: "Interno",
  texto_atribuicao: "",
};

function buildDemoZip(): Uint8Array {
  const manifest = {
    version: 1,
    questions: [
      {
        code: "DEMO-001",
        images: [
          { file: "imagens/enunciado-mapa.png", placement: "enunciado", altText: "Mapa ilustrativo com escala gráfica 1:500000" },
          { file: "imagens/alt-c.jpg", placement: "alternativa", alternativeLetter: "C", altText: "Diagrama de apoio da alternativa C" },
        ],
      },
    ],
  };
  return zipSync({
    "questoes.csv": new TextEncoder().encode(buildCsvV2([demoCsvRow])),
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    "imagens/enunciado-mapa.png": PNG_BYTES,
    "imagens/alt-c.jpg": JPEG_BYTES,
  });
}

describe("ZIP inválido — mesma classe de rejeição que a Andreia viu (nome de arquivo raiz errado + sem manifest)", () => {
  it("nome de arquivo raiz diferente de questoes.csv é rejeitado como 'arquivo inesperado'", async () => {
    const zip = zipSync({
      "questoes-teste-corrigido.csv": new TextEncoder().encode(buildCsvV2([demoCsvRow])),
    });
    const result = await previewPackage(db as never, "demo-editor-1", zip);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => /inesperad|questoes\.csv/i.test(e.message))).toBe(true);
  });

  it("ZIP sem manifest.json é rejeitado (segundo arquivo obrigatório do contrato ausente)", async () => {
    const zip = zipSync({ "questoes.csv": new TextEncoder().encode(buildCsvV2([demoCsvRow])) });
    const result = await previewPackage(db as never, "demo-editor-1", zip);
    expect(result.ok).toBe(false);
  });
});

describe("ZIP válido — pacote de demonstração da Seção 8 do hotfix (contrato real: questoes.csv + manifest.json + imagens/)", () => {
  it("preview aceita o pacote de demonstração, reconhece as 2 imagens, sem nenhum erro", async () => {
    const zip = buildDemoZip();
    const result = await previewPackage(db as never, "demo-editor-1", zip);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.imageCount).toBe(2);
    expect(result.questions?.length).toBe(1);
  });
});
