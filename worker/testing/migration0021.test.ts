// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 16 v1.3, seção 6 da ordem — valida migrations/0021_diagnostic_admin_content.sql
   DIRETAMENTE contra SQL real (node:sqlite), nunca só a cópia manual em
   worker/testing/fakeD1.ts — mesmo padrão de migration0004/0006/0007/0009-
   0012.test.ts. Cobre exatamente o que a ordem pede: coluna criada;
   default/valor esperado; fixture marcada corretamente; conteúdo real
   distinguível de fixture. Migrations 0001-0020 NUNCA são editadas — só
   lidas e aplicadas, exatamente como estão no repositório. */

const ROOT = resolve(__dirname, "../..");
const MIGRATIONS_DIR = resolve(ROOT, "migrations");

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
  "0009_editorial_batch_invariants.sql",
  "0010_editorial_bidirectional_invariants.sql",
  "0011_editorial_collection_mutation_receipts.sql",
  "0012_editorial_mutation_identity.sql",
  "0013_question_player_attempts.sql",
  "0014_error_notebook_spaced_review.sql",
  "0015_student_metrics_map.sql",
  "0016_daily_training_lists.sql",
  "0017_simulation_blocks.sql",
  "0018_weekly_reviews_goals.sql",
  "0019_teacher_student_access.sql",
  "0020_admin_user_management.sql",
  "0021_diagnostic_admin_content.sql",
];

function freshDbThrough0020(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of MIGRATION_FILES.slice(0, -1)) db.exec(readMigration(file));
  return db;
}

function freshDbWith0021(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of MIGRATION_FILES) db.exec(readMigration(file));
  return db;
}

describe("migrations/0021_diagnostic_admin_content.sql", () => {
  it("0001-0020 sozinhas: diagnostic_questions NÃO tem is_local_fixture (prova de que a lacuna era real)", () => {
    const db = freshDbThrough0020();
    const columns = db.prepare("PRAGMA table_info(diagnostic_questions)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain("is_local_fixture");
    db.close();
  });

  it("aplica limpo sobre 0001-0020, sem erro", () => {
    expect(() => freshDbWith0021()).not.toThrow();
  });

  it("coluna criada: is_local_fixture existe em diagnostic_questions, tipo INTEGER, NOT NULL", () => {
    const db = freshDbWith0021();
    const columns = db.prepare("PRAGMA table_info(diagnostic_questions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const column = columns.find((c) => c.name === "is_local_fixture");
    expect(column).toBeDefined();
    expect(column!.type).toBe("INTEGER");
    expect(column!.notnull).toBe(1);
    expect(column!.dflt_value).toBe("0");
    db.close();
  });

  it("default/valor esperado: uma linha inserida sem informar a coluna recebe 0 (real)", () => {
    const db = freshDbWith0021();
    db.exec(`INSERT INTO diagnostic_questions (id, prompt, position) VALUES ('q-default', 'Enunciado', 0)`);
    const row = db.prepare("SELECT is_local_fixture FROM diagnostic_questions WHERE id = 'q-default'").get() as { is_local_fixture: number };
    expect(row.is_local_fixture).toBe(0);
    db.close();
  });

  it("CHECK constraint aplicado: só 0 ou 1 são aceitos", () => {
    const db = freshDbWith0021();
    expect(() =>
      db.exec(`INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES ('q-invalid', 'Enunciado', 0, 2)`)
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("fixture marcada corretamente / conteúdo real distinguível de fixture: consulta filtrada separa as duas populações", () => {
    const db = freshDbWith0021();
    db.exec(`INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES ('q-real', 'Real', 0, 0)`);
    db.exec(`INSERT INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES ('q-fixture', 'Fixture', 1, 1)`);

    const real = db.prepare("SELECT id FROM diagnostic_questions WHERE is_local_fixture = 0").all() as Array<{ id: string }>;
    const fixture = db.prepare("SELECT id FROM diagnostic_questions WHERE is_local_fixture = 1").all() as Array<{ id: string }>;

    expect(real.map((r) => r.id)).toEqual(["q-real"]);
    expect(fixture.map((r) => r.id)).toEqual(["q-fixture"]);
    db.close();
  });

  it("índice de is_local_fixture foi criado (idx_diagnostic_questions_is_local_fixture)", () => {
    const db = freshDbWith0021();
    const indexes = db.prepare("PRAGMA index_list(diagnostic_questions)").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_diagnostic_questions_is_local_fixture");
    db.close();
  });

  it("aditiva e não destrutiva: nenhuma linha/tabela pré-existente é afetada (a fixture SQL local, aplicada depois, marca is_local_fixture = 1 em todas as 12 questões)", () => {
    const db = freshDbWith0021();
    const fixtureSql = readFileSync(resolve(ROOT, "scripts/fixtures/diagnostic-fixtures.local.sql"), "utf-8");
    db.exec(fixtureSql);
    const counts = db.prepare("SELECT is_local_fixture, COUNT(*) as total FROM diagnostic_questions GROUP BY is_local_fixture").all() as Array<{
      is_local_fixture: number;
      total: number;
    }>;
    expect(counts).toEqual([{ is_local_fixture: 1, total: 12 }]);
    db.close();
  });
});
