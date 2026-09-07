// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1Database } from "./fakeD1";
import {
  chunk,
  IN_CLAUSE_CHUNK_SIZE,
  D1_MAX_BOUND_PARAMS_PER_QUERY,
  PatternCatalog,
  loadPatternCatalog,
  queryExistingCodes,
  queryExistingFingerprints,
  queryExistingPatternIds,
  buildImportValidationContext,
  loadApplyRevalidationSets,
  extractCodeAndFingerprintInputs,
  computeRowFingerprint,
} from "../src/lib/importValidationContext";

/* Sprint 19.2 da ordem — testes do helper/contexto de validação em lote
   (worker/src/lib/importValidationContext.ts), que elimina o N+1 de
   consultas D1 da importação (CSV V1, CSV V2, Pacote ZIP). Cobre: chunk()
   (respeita o teto de bound params), PatternCatalog (resolução por
   código/nome, detecção de ambiguidade — nunca escolhida arbitrariamente),
   e as consultas em lote (queryExistingCodes/Fingerprints/PatternIds) —
   inclusive a contagem REAL de round-trips D1 via
   `FakeD1Database.getD1CallCount()` (item E da seção 10 da ordem: 500
   códigos/fingerprints, chunking respeitando <=100 params, dentro do
   orçamento de chamadas). */

describe("chunk() — respeita o teto de bound params por consulta", () => {
  it("divide em grupos do tamanho pedido, último grupo parcial", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("array vazio produz zero grupos", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("array menor que o tamanho do grupo produz um único grupo", () => {
    expect(chunk([1, 2], 90)).toEqual([[1, 2]]);
  });

  it("IN_CLAUSE_CHUNK_SIZE fica com margem abaixo do teto real de 100 parâmetros do D1", () => {
    expect(IN_CLAUSE_CHUNK_SIZE).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS_PER_QUERY);
    expect(D1_MAX_BOUND_PARAMS_PER_QUERY).toBe(100);
  });

  it("500 itens nunca geram um grupo maior que IN_CLAUSE_CHUNK_SIZE (prova estrutural do respeito ao teto de bound params)", () => {
    const items = Array.from({ length: 500 }, (_, i) => `item-${i}`);
    const groups = chunk(items, IN_CLAUSE_CHUNK_SIZE);
    expect(groups.length).toBe(Math.ceil(500 / IN_CLAUSE_CHUNK_SIZE));
    for (const g of groups) expect(g.length).toBeLessThanOrEqual(IN_CLAUSE_CHUNK_SIZE);
    expect(groups.flat()).toEqual(items);
  });
});

describe("PatternCatalog — resolução em memória, nunca por consulta", () => {
  const entries = [
    { id: "p1", code: "PAD-01", name: "Escala e Proporção" },
    { id: "p2", code: "PAD-02", name: "Função Afim" },
    // Colisão deliberada: "name" NÃO é UNIQUE no schema real (só
    // code/slug são) — dois padrões distintos podem, em tese, ter o MESMO
    // nome. A resolução por nome/código precisa detectar isso como
    // ambíguo, nunca escolher um dos dois arbitrariamente.
    { id: "p3", code: "PAD-03", name: "Função Afim" },
  ];
  const catalog = new PatternCatalog(entries);

  it("resolveByCodeExact — encontra por código exato (V1)", () => {
    expect(catalog.resolveByCodeExact("PAD-01")).toEqual({ pattern: entries[0], ambiguous: false });
  });

  it("resolveByCodeExact — nunca resolve por NOME (V1 é só código)", () => {
    expect(catalog.resolveByCodeExact("Escala e Proporção")).toEqual({ pattern: null, ambiguous: false });
  });

  it("resolveByCodeExact — não encontrado", () => {
    expect(catalog.resolveByCodeExact("PAD-99")).toEqual({ pattern: null, ambiguous: false });
  });

  it("resolveByCodeExact — string vazia/só espaços nunca é ambígua nem encontrada", () => {
    expect(catalog.resolveByCodeExact("   ")).toEqual({ pattern: null, ambiguous: false });
  });

  it("resolveByNameOrCode — encontra por nome exato (sem colisão)", () => {
    expect(catalog.resolveByNameOrCode("Escala e Proporção")).toEqual({ pattern: entries[0], ambiguous: false });
  });

  it("resolveByNameOrCode — encontra por código exato", () => {
    expect(catalog.resolveByNameOrCode("PAD-01")).toEqual({ pattern: entries[0], ambiguous: false });
  });

  it("resolveByNameOrCode — fallback case-insensitive quando o exato não bate", () => {
    expect(catalog.resolveByNameOrCode("escala e proporção")).toEqual({ pattern: entries[0], ambiguous: false });
    expect(catalog.resolveByNameOrCode("pad-01")).toEqual({ pattern: entries[0], ambiguous: false });
  });

  it("resolveByNameOrCode — DUAS entradas distintas com o MESMO nome: ambíguo, nunca escolhido arbitrariamente", () => {
    const result = catalog.resolveByNameOrCode("Função Afim");
    expect(result.ambiguous).toBe(true);
    expect(result.pattern).toBeNull();
  });

  it("resolveByNameOrCode — ambiguidade também detectada no fallback case-insensitive", () => {
    const result = catalog.resolveByNameOrCode("função afim");
    expect(result.ambiguous).toBe(true);
    expect(result.pattern).toBeNull();
  });

  it("resolveByNameOrCode — não encontrado", () => {
    expect(catalog.resolveByNameOrCode("Padrão Inexistente")).toEqual({ pattern: null, ambiguous: false });
  });

  it("getById — lookup direto, sem nova consulta", () => {
    expect(catalog.getById("p2")).toEqual(entries[1]);
    expect(catalog.getById("nao-existe")).toBeNull();
  });
});

let db: FakeD1Database;

beforeEach(() => {
  db = new FakeD1Database();
});

describe("loadPatternCatalog — UMA consulta, catálogo inteiro em memória", () => {
  it("carrega todos os padrões numa única chamada D1", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published'),
              ('pat-2', 'PAD-02', 'padrao-2', 'Padrão 2', 'F', 'D', 'E', 'X', 'R', 'published')`
    );
    db.resetD1CallCount();
    const catalog = await loadPatternCatalog(db as never);
    expect(db.getD1CallCount()).toBe(1);
    expect(catalog.resolveByCodeExact("PAD-02").pattern?.id).toBe("pat-2");
  });
});

describe("queryExistingCodes/Fingerprints/PatternIds — consultas em lote (chunked)", () => {
  it("encontra só os códigos que existem, nunca uma consulta por código", async () => {
    db.sqlite.exec(
      `INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('u1', 'U', 'u@x.com', 'u@x.com', 'h')`
    );
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('q1', 'EXISTE-1', 'E', 'media', 'autoral', 'fp-existe-1')`
    );
    db.resetD1CallCount();
    const found = await queryExistingCodes(db as never, ["EXISTE-1", "NAO-EXISTE", "", "EXISTE-1"]);
    expect(found).toEqual(new Set(["EXISTE-1"]));
    expect(db.getD1CallCount()).toBe(1); // um único grupo (poucos itens) — uma única consulta.
  });

  it("500 códigos distintos: chunking gera poucas consultas (nunca 500), sempre dentro do orçamento de chamadas", async () => {
    db.sqlite.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('u1', 'U', 'u@x.com', 'u@x.com', 'h')`);
    // Metade dos 500 códigos já existe no banco — prova que o resultado
    // combina corretamente os chunks, não só que "não estoura".
    const stmt = db.sqlite.prepare(`INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES (?, ?, 'E', 'media', 'autoral', ?)`);
    for (let i = 0; i < 250; i++) stmt.run(`q-${i}`, `CODE-${i}`, `fp-${i}`);

    const codes = Array.from({ length: 500 }, (_, i) => `CODE-${i}`);
    db.resetD1CallCount();
    const found = await queryExistingCodes(db as never, codes);
    expect(found.size).toBe(250);
    expect(found.has("CODE-0")).toBe(true);
    expect(found.has("CODE-499")).toBe(false);
    // Nunca uma consulta por código (500) — só ceil(500/IN_CLAUSE_CHUNK_SIZE).
    expect(db.getD1CallCount()).toBe(Math.ceil(500 / IN_CLAUSE_CHUNK_SIZE));
    expect(db.getD1CallCount()).toBeLessThan(50); // dentro do orçamento de "queries per Worker invocation".
  });

  it("queryExistingFingerprints — mesmo comportamento em lote", async () => {
    db.sqlite.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('u1', 'U', 'u@x.com', 'u@x.com', 'h')`);
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('q1', 'C1', 'E', 'media', 'autoral', 'fp-existe')`
    );
    db.resetD1CallCount();
    const found = await queryExistingFingerprints(db as never, ["fp-existe", "fp-nao-existe"]);
    expect(found).toEqual(new Set(["fp-existe"]));
    expect(db.getD1CallCount()).toBe(1);
  });

  it("queryExistingPatternIds — mesmo comportamento em lote (usado só no apply)", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
    );
    db.resetD1CallCount();
    const found = await queryExistingPatternIds(db as never, ["pat-1", "pat-inexistente"]);
    expect(found).toEqual(new Set(["pat-1"]));
    expect(db.getD1CallCount()).toBe(1);
  });

  it("lista vazia nunca gera consulta nenhuma", async () => {
    db.resetD1CallCount();
    const found = await queryExistingCodes(db as never, []);
    expect(found.size).toBe(0);
    expect(db.getD1CallCount()).toBe(0);
  });
});

describe("buildImportValidationContext / loadApplyRevalidationSets — montagem completa", () => {
  it("combina catálogo + códigos + fingerprints existentes em poucas chamadas", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
    );
    db.sqlite.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('u1', 'U', 'u@x.com', 'u@x.com', 'h')`);
    db.sqlite.exec(
      `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('q1', 'EXISTE', 'E', 'media', 'autoral', 'fp-existe')`
    );
    db.resetD1CallCount();
    const ctx = await buildImportValidationContext(db as never, ["EXISTE", "NOVO"], ["fp-existe", "fp-novo"]);
    expect(ctx.existingCodes).toEqual(new Set(["EXISTE"]));
    expect(ctx.existingFingerprints).toEqual(new Set(["fp-existe"]));
    expect(ctx.patterns.resolveByCodeExact("PAD-01").pattern?.id).toBe("pat-1");
    expect(db.getD1CallCount()).toBe(3); // 1 catálogo + 1 codes + 1 fingerprints.
  });

  it("loadApplyRevalidationSets — três consultas em lote (codes, fingerprints, patternIds)", async () => {
    db.sqlite.exec(
      `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
       VALUES ('pat-1', 'PAD-01', 'padrao-1', 'Padrão 1', 'F', 'D', 'E', 'X', 'R', 'published')`
    );
    db.resetD1CallCount();
    const sets = await loadApplyRevalidationSets(db as never, { codes: ["A"], fingerprints: ["fp-a"], patternIds: ["pat-1", "pat-inexistente"] });
    expect(sets.existingCodes.size).toBe(0);
    expect(sets.existingFingerprints.size).toBe(0);
    expect(sets.existingPatternIds).toEqual(new Set(["pat-1"]));
    expect(db.getD1CallCount()).toBe(3);
  });
});

describe("extractCodeAndFingerprintInputs / computeRowFingerprint — pré-passo puro (sem D1)", () => {
  const headerIndex = { codigo: 0, enunciado: 1, alt_a: 2, alt_b: 3, alt_c: 4, alt_d: 5, alt_e: 6, correta: 7 };
  const row = ["COD-1", "Enunciado de teste.", "A", "B", "C", "D", "E", "B"];

  it("extrai código/enunciado/alternativas sem tocar o banco", () => {
    const result = extractCodeAndFingerprintInputs(row, headerIndex);
    expect(result.code).toBe("COD-1");
    expect(result.enunciado).toBe("Enunciado de teste.");
    expect(result.alternativas.find((a) => a.isCorrect)?.letter).toBe("B");
  });

  it("computeRowFingerprint calcula o MESMO fingerprint duas vezes para a mesma linha (determinístico, nenhuma consulta D1)", async () => {
    db.resetD1CallCount();
    const first = await computeRowFingerprint(row, headerIndex);
    const second = await computeRowFingerprint(row, headerIndex);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint.length).toBeGreaterThan(0);
    expect(db.getD1CallCount()).toBe(0); // puramente local — SHA-256, nunca uma query.
  });

  it("enunciado vazio nunca calcula fingerprint (evita hash de conteúdo vazio)", async () => {
    const result = await computeRowFingerprint(["COD-2", "", "A", "B", "C", "D", "E", "B"], headerIndex);
    expect(result.fingerprint).toBe("");
  });
});
