// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 6 v1.0 — provas exigidas pela seção 6.1 da ordem. Mesmo padrão de
   worker/testing/migration0004/0005/0006.test.ts: lê e executa o SQL REAL de
   migrations/*.sql e de scripts/fixtures/*.sql com node:sqlite, sem nenhuma
   cópia manual do DDL. */

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
];

const PATTERN_TABLES = ["patterns", "pattern_attributes", "pattern_relations", "student_pattern_progress"];

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

function insertPattern(db: DatabaseSync, id: string, code: string, slug: string, status = "published"): void {
  db.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${id}', '${code}', '${slug}', 'N', 'F', 'D', 'E', 'X', 'R', '${status}')`
  );
}

describe("migration 0007 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0007 do zero, em ordem, sem erro", () => {
    const db = freshDb();
    const tables = listTables(db);
    for (const table of PATTERN_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it("aplica 0007 sobre o schema real das Sprints 1-5 (0001-0006), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 6));

    const tablesBefore = listTables(db);
    for (const table of PATTERN_TABLES) {
      expect(tablesBefore).not.toContain(table);
    }

    db.exec(readMigration("0007_patterns_foundation.sql"));

    const tablesAfter = listTables(db);
    for (const table of PATTERN_TABLES) {
      expect(tablesAfter).toContain(table);
    }
    // As tabelas das sprints anteriores continuam intactas.
    expect(tablesAfter).toContain("schedule_activity_assignments");
    expect(tablesAfter).toContain("diagnostic_attempts");
    expect(tablesAfter).toContain("student_profiles");
    expect(tablesAfter).toContain("users");
  });

  it("0007 é idempotente: reaplicar não falha e não duplica estrutura", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0007_patterns_foundation.sql"))).not.toThrow();

    const tables = listTables(db);
    const patternTableCount = tables.filter((name) => PATTERN_TABLES.includes(name)).length;
    expect(patternTableCount).toBe(PATTERN_TABLES.length);
  });

  it("o invariante da 0005 (uma tentativa in_progress por aluno) continua intacto depois da 0007", () => {
    const db = freshDb();
    seedUser(db, "u1");
    db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','in_progress')");
    expect(() =>
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a2','u1','in_progress')")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("`code` é único", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    expect(() => insertPattern(db, "p2", "PAD-01", "slug-b")).toThrow(/UNIQUE constraint failed/i);
  });

  it("`slug` é único", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    expect(() => insertPattern(db, "p2", "PAD-02", "slug-a")).toThrow(/UNIQUE constraint failed/i);
  });

  it("editorial_status fora do enum fechado é bloqueado", () => {
    const db = freshDb();
    expect(() => insertPattern(db, "p1", "PAD-01", "slug-a", "status_bogus")).toThrow(/CHECK constraint failed/i);
  });

  it("os seis status editoriais do enum são aceitos", () => {
    const db = freshDb();
    const statuses = ["draft", "in_review", "changes_requested", "approved", "published", "archived"];
    statuses.forEach((status, index) => {
      expect(() => insertPattern(db, `p${index}`, `PAD-${index}`, `slug-${index}`, status)).not.toThrow();
    });
  });

  it("attribute_type fora do enum fechado é bloqueado", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    expect(() =>
      db.exec("INSERT INTO pattern_attributes (id, pattern_id, attribute_type, content) VALUES ('a1','p1','tipo_bogus','x')")
    ).toThrow(/CHECK constraint failed/i);
  });

  it("os oito tipos de atributo multivalorado do enum são aceitos", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    const types = [
      "frequent_clue",
      "recurring_phrase",
      "recurring_visual_element",
      "alternative_strategy",
      "required_content",
      "prerequisite_content",
      "common_mistake",
      "tag",
    ];
    types.forEach((type, index) => {
      expect(() =>
        db.exec(
          `INSERT INTO pattern_attributes (id, pattern_id, attribute_type, position, content) VALUES ('a${index}','p1','${type}',${index},'x')`
        )
      ).not.toThrow();
    });
  });

  it("auto-relação (padrão relacionado a si mesmo) é bloqueada pelo CHECK", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    expect(() =>
      db.exec("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES ('r1','p1','p1','related')")
    ).toThrow(/CHECK constraint failed/i);
  });

  it("a mesma relação exata (origem, destino, tipo) não pode ser duplicada", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    insertPattern(db, "p2", "PAD-02", "slug-b");
    db.exec("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES ('r1','p1','p2','related')");
    expect(() =>
      db.exec("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES ('r2','p1','p2','related')")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("dois tipos DIFERENTES de relação entre o mesmo par continuam permitidos", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    insertPattern(db, "p2", "PAD-02", "slug-b");
    expect(() => {
      db.exec("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES ('r1','p1','p2','related')");
      db.exec("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES ('r2','p1','p2','prerequisite')");
    }).not.toThrow();
  });

  it("relation_type fora do enum fechado é bloqueado", () => {
    const db = freshDb();
    insertPattern(db, "p1", "PAD-01", "slug-a");
    insertPattern(db, "p2", "PAD-02", "slug-b");
    expect(() =>
      db.exec("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES ('r1','p1','p2','tipo_bogus')")
    ).toThrow(/CHECK constraint failed/i);
  });

  it("o progresso é único por aluno+padrão (chave primária composta)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    insertPattern(db, "p1", "PAD-01", "slug-a");
    db.exec("INSERT INTO student_pattern_progress (user_id, pattern_id) VALUES ('u1','p1')");
    expect(() => db.exec("INSERT INTO student_pattern_progress (user_id, pattern_id) VALUES ('u1','p1')")).toThrow(
      /UNIQUE constraint failed|PRIMARY KEY/i
    );
  });

  it("dois alunos diferentes podem ter progresso no MESMO padrão", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedUser(db, "u2");
    insertPattern(db, "p1", "PAD-01", "slug-a");
    expect(() => {
      db.exec("INSERT INTO student_pattern_progress (user_id, pattern_id) VALUES ('u1','p1')");
      db.exec("INSERT INTO student_pattern_progress (user_id, pattern_id) VALUES ('u2','p1')");
    }).not.toThrow();
  });

  it("os três índices aceitam NULL e permanecem NULL — nunca viram zero no banco", () => {
    const db = freshDb();
    seedUser(db, "u1");
    insertPattern(db, "p1", "PAD-01", "slug-a");
    db.exec("INSERT INTO student_pattern_progress (user_id, pattern_id) VALUES ('u1','p1')");

    const row = db
      .prepare(
        "SELECT recognition_index, resolution_index, mastery_index FROM student_pattern_progress WHERE user_id = 'u1' AND pattern_id = 'p1'"
      )
      .get() as { recognition_index: unknown; resolution_index: unknown; mastery_index: unknown };

    expect(row.recognition_index).toBeNull();
    expect(row.resolution_index).toBeNull();
    expect(row.mastery_index).toBeNull();
  });

  it("os três índices aceitam valores REAL quando (no futuro) houver fórmula", () => {
    const db = freshDb();
    seedUser(db, "u1");
    insertPattern(db, "p1", "PAD-01", "slug-a");
    db.exec(
      "INSERT INTO student_pattern_progress (user_id, pattern_id, recognition_index, resolution_index, mastery_index) VALUES ('u1','p1',0.5,0.25,0.75)"
    );
    const row = db
      .prepare("SELECT recognition_index FROM student_pattern_progress WHERE user_id = 'u1'")
      .get() as { recognition_index: number };
    expect(row.recognition_index).toBeCloseTo(0.5);
  });

  it("a migration 0007 NÃO insere nenhum conteúdo (nenhum padrão, atributo, relação ou progresso)", () => {
    const db = freshDb();
    for (const table of PATTERN_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number };
      expect(row.total).toBe(0);
    }
  });
});

describe("docs/PADROES_ENEM.md — evolução do enum attribute_type (Correção A, v1.1)", () => {
  function readDoc(): string {
    return readFileSync(resolve(ROOT, "docs/PADROES_ENEM.md"), "utf-8");
  }

  it("NÃO afirma que um novo attribute_type dispensa migration", () => {
    const doc = readDoc();
    expect(doc).not.toMatch(/um novo tipo de atributo passa a ser uma extensão do CHECK do enum, não uma migration/i);
    expect(doc).not.toMatch(/extensão do CHECK do enum,\s*não uma migration/i);
  });

  it("afirma explicitamente que evoluir o enum EXIGE migration versionada", () => {
    const doc = readDoc();
    expect(doc).toMatch(/exige\s+uma\s+migration\s+versionada/i);
    expect(doc).toMatch(/nunca\s+é\s+reescrita/i);
  });
});

describe("seed local de padrões (scripts/fixtures/patterns-fixtures.local.sql)", () => {
  function readFixture(): string {
    return readFileSync(resolve(FIXTURES_DIR, "patterns-fixtures.local.sql"), "utf-8");
  }

  it("aplica sobre o schema real e cria os cinco padrões citados no Documento Mestre", () => {
    const db = freshDb();
    db.exec(readFixture());
    const rows = db.prepare("SELECT name FROM patterns ORDER BY code ASC").all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      "Razão em Gráfico",
      "Escala",
      "Porcentagem Direta",
      "Mediana e Frequência",
      "Projeção Ortogonal",
    ]);
  });

  it("é idempotente: reaplicar não falha e não duplica nenhuma linha", () => {
    const db = freshDb();
    db.exec(readFixture());
    const countAll = () =>
      PATTERN_TABLES.map(
        (table) => (db.prepare(`SELECT COUNT(*) as total FROM ${table}`).get() as { total: number }).total
      );
    const before = countAll();

    expect(() => db.exec(readFixture())).not.toThrow();
    expect(countAll()).toEqual(before);
  });

  it("todo texto pedagógico do seed carrega a marcação de conteúdo provisório", () => {
    const db = freshDb();
    db.exec(readFixture());
    const rows = db
      .prepare(
        "SELECT recognition_phrase, description, main_strategy, introductory_example, strategic_summary FROM patterns"
      )
      .all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        expect(value).toContain("CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR");
      }
    }
  });

  it("o seed NÃO cria nenhuma linha de progresso de aluno", () => {
    const db = freshDb();
    db.exec(readFixture());
    const row = db.prepare("SELECT COUNT(*) as total FROM student_pattern_progress").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("o seed marca todos os padrões como fixture local (is_local_fixture = 1)", () => {
    const db = freshDb();
    db.exec(readFixture());
    const row = db.prepare("SELECT COUNT(*) as total FROM patterns WHERE is_local_fixture = 0").get() as {
      total: number;
    };
    expect(row.total).toBe(0);
  });

  it("nenhuma estrutura multivalorada do seed usa lista separada por vírgula num único campo", () => {
    const db = freshDb();
    db.exec(readFixture());
    // Cada conteúdo/tag é uma LINHA própria em pattern_attributes; um valor
    // com vírgula indicaria que voltamos a empacotar lista em string.
    const rows = db
      .prepare("SELECT content FROM pattern_attributes WHERE attribute_type IN ('required_content', 'tag')")
      .all() as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.content).not.toContain(",");
    }
  });
});
