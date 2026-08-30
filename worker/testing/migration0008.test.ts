// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 7 v1.0 — provas exigidas pelas seções 11.1 e 11.2 da ordem. Mesmo
   padrão de worker/testing/migration0007.test.ts: lê e executa o SQL REAL
   de migrations/*.sql e de scripts/fixtures/*.sql com node:sqlite. */

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS_DIR = resolve(ROOT, "migrations");
const FIXTURES_DIR = resolve(ROOT, "scripts/fixtures");

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), "utf-8");
}

const MIGRATION_FILES = [
  "0001_init.sql",
  "0002_rate_limit_counters.sql",
  "0003_student_profiles_onboarding.sql",
  "0004_initial_diagnostic.sql",
  "0005_diagnostic_invariants.sql",
  "0006_adaptive_schedule_foundation.sql",
  "0007_patterns_foundation.sql",
  "0008_question_bank_editorial.sql",
];

const QUESTION_TABLES = [
  "roles",
  "user_roles",
  "questions",
  "question_alternatives",
  "question_images",
  "question_patterns",
  "question_tags",
  "question_dna",
  "question_history",
  "question_import_batches",
  "question_import_items",
];

function listTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function freshDb(files: string[] = MIGRATION_FILES): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(readMigration(file));
  return db;
}

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(
    `INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`
  );
}

function insertPattern(db: DatabaseSync, id: string, code: string): void {
  db.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary)
     VALUES ('${id}', '${code}', '${code.toLowerCase()}', 'N', 'F', 'D', 'E', 'X', 'R')`
  );
}

function insertQuestion(db: DatabaseSync, id: string, code: string, overrides: Record<string, string | number> = {}): void {
  const fields = { dificuldade: "media", origem: "autoral", fingerprint: `fp-${id}`, editorial_status: "draft", ...overrides };
  db.exec(
    `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint, editorial_status)
     VALUES ('${id}', '${code}', 'Enunciado de teste', '${fields.dificuldade}', '${fields.origem}', '${fields.fingerprint}', '${fields.editorial_status}')`
  );
}

describe("migration 0008 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0008 do zero, em ordem, sem erro", () => {
    const db = freshDb();
    const tables = listTables(db);
    for (const table of QUESTION_TABLES) expect(tables).toContain(table);
  });

  it("aplica 0008 sobre o schema real das Sprints 1-6, sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 7));
    const before = listTables(db);
    for (const table of QUESTION_TABLES) expect(before).not.toContain(table);

    db.exec(readMigration("0008_question_bank_editorial.sql"));
    const after = listTables(db);
    for (const table of QUESTION_TABLES) expect(after).toContain(table);
    expect(after).toContain("patterns");
    expect(after).toContain("schedule_activity_assignments");
    expect(after).toContain("users");
  });

  it("0008 é idempotente: reaplicar não falha e não duplica estrutura", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0008_question_bank_editorial.sql"))).not.toThrow();
    const tables = listTables(db);
    const count = tables.filter((name) => QUESTION_TABLES.includes(name)).length;
    expect(count).toBe(QUESTION_TABLES.length);
  });

  it("a migration 0008 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    for (const table of QUESTION_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number };
      expect(row.total).toBe(0);
    }
  });

  /* -------------------------------- RBAC (11.1) -------------------------------- */

  it("roles.name é restrito ao enum fechado dos seis papéis", () => {
    const db = freshDb();
    expect(() => db.exec("INSERT INTO roles (id, name) VALUES ('r1', 'editor')")).not.toThrow();
    expect(() => db.exec("INSERT INTO roles (id, name) VALUES ('r2', 'papel_bogus')")).toThrow(/CHECK constraint failed/i);
  });

  it("roles.name é único", () => {
    const db = freshDb();
    db.exec("INSERT INTO roles (id, name) VALUES ('r1', 'editor')");
    expect(() => db.exec("INSERT INTO roles (id, name) VALUES ('r2', 'editor')")).toThrow(/UNIQUE constraint failed/i);
  });

  it("user_roles impede a mesma concessão duplicada (user_id, role_id)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    db.exec("INSERT INTO roles (id, name) VALUES ('r1', 'editor')");
    db.exec("INSERT INTO user_roles (id, user_id, role_id) VALUES ('ur1', 'u1', 'r1')");
    expect(() => db.exec("INSERT INTO user_roles (id, user_id, role_id) VALUES ('ur2', 'u1', 'r1')")).toThrow(/UNIQUE constraint failed/i);
  });

  it("um usuário pode ter editor E admin simultaneamente (papéis não são exclusivos)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    db.exec("INSERT INTO roles (id, name) VALUES ('r1', 'editor')");
    db.exec("INSERT INTO roles (id, name) VALUES ('r2', 'admin')");
    expect(() => {
      db.exec("INSERT INTO user_roles (id, user_id, role_id) VALUES ('ur1', 'u1', 'r1')");
      db.exec("INSERT INTO user_roles (id, user_id, role_id) VALUES ('ur2', 'u1', 'r2')");
    }).not.toThrow();
  });

  /* ------------------------------- Schema (11.2) -------------------------------- */

  it("dificuldade fora do enum fechado é bloqueada", () => {
    const db = freshDb();
    expect(() => insertQuestion(db, "q1", "C1", { dificuldade: "bogus" })).toThrow(/CHECK constraint failed/i);
  });

  it("origem fora do enum fechado é bloqueada", () => {
    const db = freshDb();
    expect(() => insertQuestion(db, "q1", "C1", { origem: "bogus" })).toThrow(/CHECK constraint failed/i);
  });

  it("editorial_status fora do enum fechado é bloqueado", () => {
    const db = freshDb();
    expect(() => insertQuestion(db, "q1", "C1", { editorial_status: "bogus" })).toThrow(/CHECK constraint failed/i);
  });

  it("code é único", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "DUP-1");
    expect(() => insertQuestion(db, "q2", "DUP-1", { fingerprint: "fp-other" })).toThrow(/UNIQUE constraint failed/i);
  });

  it("fingerprint duplicada NÃO é bloqueada pelo banco (é sinalização de duplicidade, verificada no serviço)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1", { fingerprint: "fp-same" });
    expect(() => insertQuestion(db, "q2", "C2", { fingerprint: "fp-same" })).not.toThrow();
  });

  it("alternativas: só A-E são aceitas", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec("INSERT INTO question_alternatives (id, question_id, letter, text, position) VALUES ('a1','q1','F','x',0)")
    ).toThrow(/CHECK constraint failed/i);
  });

  it("alternativas: uma letra por questão (UNIQUE question_id+letter)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    db.exec("INSERT INTO question_alternatives (id, question_id, letter, text, position) VALUES ('a1','q1','A','x',0)");
    expect(() =>
      db.exec("INSERT INTO question_alternatives (id, question_id, letter, text, position) VALUES ('a2','q1','A','y',1)")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("alternativas: texto vazio é bloqueado pelo CHECK", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec("INSERT INTO question_alternatives (id, question_id, letter, text, position) VALUES ('a1','q1','A','   ',0)")
    ).toThrow(/CHECK constraint failed/i);
  });

  it("alternativas: o banco NÃO garante sozinho 'exatamente uma correta' (precisa do serviço) — duas corretas são aceitas pelo CHECK de linha única", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    expect(() => {
      db.exec("INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, position) VALUES ('a1','q1','A','x',1,0)");
      db.exec("INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, position) VALUES ('a2','q1','B','y',1,1)");
    }).not.toThrow();
  });

  it("imagem: alt_text pode nascer vazio (completude é exigida no serviço, não no banco)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    expect(() => db.exec("INSERT INTO question_images (id, question_id, asset_ref) VALUES ('i1','q1','assets/questoes/x.png')")).not.toThrow();
    const row = db.prepare("SELECT alt_text FROM question_images WHERE id = 'i1'").get() as { alt_text: string };
    expect(row.alt_text).toBe("");
  });

  it("padrão principal: FK aponta para patterns.id (nunca slug/code)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    insertPattern(db, "p1", "PAD-01");
    expect(() => db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp1','q1','p1','principal')")).not.toThrow();
  });

  it("padrão: só um principal por questão (índice único parcial)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    insertPattern(db, "p1", "PAD-01");
    insertPattern(db, "p2", "PAD-02");
    db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp1','q1','p1','principal')");
    expect(() =>
      db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp2','q1','p2','principal')")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("padrão: o mesmo padrão não pode ser vinculado duas vezes à mesma questão (principal+secundário ou duplicado)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    insertPattern(db, "p1", "PAD-01");
    db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp1','q1','p1','principal')");
    expect(() =>
      db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp2','q1','p1','secundario')")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("dois padrões secundários diferentes na mesma questão são permitidos", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    insertPattern(db, "p1", "PAD-01");
    insertPattern(db, "p2", "PAD-02");
    insertPattern(db, "p3", "PAD-03");
    expect(() => {
      db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp1','q1','p1','principal')");
      db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp2','q1','p2','secundario')");
      db.exec("INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES ('qp3','q1','p3','secundario')");
    }).not.toThrow();
  });

  it("tags: não permite duplicidade da mesma tag na mesma questão", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1");
    db.exec("INSERT INTO question_tags (id, question_id, content) VALUES ('t1','q1','geometria')");
    expect(() => db.exec("INSERT INTO question_tags (id, question_id, content) VALUES ('t2','q1','geometria')")).toThrow(/UNIQUE constraint failed/i);
  });

  it("question_history é append-only por convenção — nenhum código de produção emite UPDATE/DELETE (prova estática)", () => {
    const source = readFileSync(resolve(ROOT, "worker/src/repositories/questionRepository.ts"), "utf-8");
    const importSource = readFileSync(resolve(ROOT, "worker/src/repositories/questionImportRepository.ts"), "utf-8");
    expect(source).not.toMatch(/UPDATE\s+question_history/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+question_history\s+WHERE\s+id/i);
    expect(importSource).toMatch(/DELETE FROM \$\{table\}/); // só o helper genérico de undo, guardado por lote
  });

  it("questions publicadas continuam existindo no banco sem constraint especial de imutabilidade (a proteção é do serviço, não do CHECK)", () => {
    const db = freshDb();
    insertQuestion(db, "q1", "C1", { editorial_status: "published" });
    expect(() => db.exec("UPDATE questions SET enunciado = 'outro' WHERE id = 'q1'")).not.toThrow();
    // A prova de que o SERVIÇO bloqueia isso está em questions.test.ts —
    // aqui só documentamos que o banco por si só permite (por isso o
    // guard SQL do UPDATE em questionRepository.ts restringe
    // editorial_status IN ('draft','changes_requested')).
  });
});

describe("seed local de questões (scripts/fixtures/questions-fixtures.local.sql)", () => {
  function readFixture(name: string): string {
    return readFileSync(resolve(FIXTURES_DIR, name), "utf-8");
  }

  it("aplica sobre o schema real (com padrões já semeados) e cria as questões fixture", () => {
    const db = freshDb();
    db.exec(readFixture("patterns-fixtures.local.sql"));
    db.exec(readFixture("questions-fixtures.local.sql"));
    const row = db.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number };
    expect(row.total).toBeGreaterThan(0);
  });

  it("é idempotente: reaplicar não falha e não duplica nenhuma linha", () => {
    const db = freshDb();
    db.exec(readFixture("patterns-fixtures.local.sql"));
    db.exec(readFixture("questions-fixtures.local.sql"));
    const countAll = () => (db.prepare("SELECT COUNT(*) as total FROM questions").get() as { total: number }).total;
    const before = countAll();
    expect(() => db.exec(readFixture("questions-fixtures.local.sql"))).not.toThrow();
    expect(countAll()).toBe(before);
  });

  it("todo enunciado/resolução do seed carrega o prefixo exato de fixture técnica", () => {
    const db = freshDb();
    db.exec(readFixture("patterns-fixtures.local.sql"));
    db.exec(readFixture("questions-fixtures.local.sql"));
    const rows = db.prepare("SELECT enunciado, resolucao_comentada FROM questions").all() as Array<{ enunciado: string; resolucao_comentada: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.enunciado).toContain("FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL");
      expect(row.resolucao_comentada).toContain("FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL");
    }
  });

  it("todas as questões do seed estão marcadas como fixture local (is_local_fixture = 1)", () => {
    const db = freshDb();
    db.exec(readFixture("patterns-fixtures.local.sql"));
    db.exec(readFixture("questions-fixtures.local.sql"));
    const row = db.prepare("SELECT COUNT(*) as total FROM questions WHERE is_local_fixture = 0").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("todas as questões do seed estão vinculadas apenas aos cinco padrões da Sprint 6", () => {
    const db = freshDb();
    db.exec(readFixture("patterns-fixtures.local.sql"));
    db.exec(readFixture("questions-fixtures.local.sql"));
    const rows = db
      .prepare(
        `SELECT DISTINCT pattern_id FROM question_patterns`
      )
      .all() as Array<{ pattern_id: string }>;
    const allowed = new Set(["fixture-pat-01", "fixture-pat-02", "fixture-pat-03", "fixture-pat-04", "fixture-pat-05"]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(allowed.has(row.pattern_id)).toBe(true);
  });

  it("o seed NÃO cria nenhum papel nem concessão de papel (RBAC nunca nasce de seed de conteúdo)", () => {
    const db = freshDb();
    db.exec(readFixture("patterns-fixtures.local.sql"));
    db.exec(readFixture("questions-fixtures.local.sql"));
    const row = db.prepare("SELECT COUNT(*) as total FROM user_roles").get() as { total: number };
    expect(row.total).toBe(0);
  });
});
