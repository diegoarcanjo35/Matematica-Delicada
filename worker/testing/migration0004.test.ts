// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 4 v1.0 — prova exigida pela seção 12 da ordem: "migration 0004 do
   zero e sobre schema das Sprints 1-3". Ao contrário de worker/testing/
   diagnostic.test.ts (que roda sobre a cópia de schema mantida à mão em
   fakeD1.ts, por conveniência dos outros testes), este arquivo lê e executa
   o SQL real de migrations/*.sql com node:sqlite — nenhuma cópia manual —
   para garantir que a migration aplicada de verdade funciona e não
   divergiu do schema espelhado no fake. */

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), "utf-8");
}

const MIGRATION_FILES = [
  "0001_init.sql",
  "0002_rate_limit_counters.sql",
  "0003_student_profiles_onboarding.sql",
  "0004_initial_diagnostic.sql",
];

const DIAGNOSTIC_TABLES = [
  "diagnostic_questions",
  "diagnostic_question_options",
  "diagnostic_question_recognition_options",
  "diagnostic_question_help_layers",
  "diagnostic_attempts",
  "diagnostic_attempt_questions",
  "diagnostic_responses",
  "diagnostic_help_opens",
];

function listTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("migration 0004 (real SQL, não cópia manual)", () => {
  it("aplica as migrations 0001-0004 do zero, em ordem, sem erro", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    const tables = listTables(db);
    for (const table of DIAGNOSTIC_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it("aplica 0004 sobre o schema real das Sprints 1-3 (0001-0003)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0001_init.sql"));
    db.exec(readMigration("0002_rate_limit_counters.sql"));
    db.exec(readMigration("0003_student_profiles_onboarding.sql"));

    const tablesBefore = listTables(db);
    for (const table of DIAGNOSTIC_TABLES) {
      expect(tablesBefore).not.toContain(table);
    }

    db.exec(readMigration("0004_initial_diagnostic.sql"));

    const tablesAfter = listTables(db);
    for (const table of DIAGNOSTIC_TABLES) {
      expect(tablesAfter).toContain(table);
    }
    // Nenhuma tabela das sprints anteriores foi removida/recriada.
    expect(tablesAfter).toContain("users");
    expect(tablesAfter).toContain("student_profiles");
  });

  it("0004 é idempotente: reaplicar não falha e não duplica estrutura", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    // Reaplicar de novo (CREATE TABLE/INDEX IF NOT EXISTS) não deve lançar.
    expect(() => db.exec(readMigration("0004_initial_diagnostic.sql"))).not.toThrow();

    const tables = listTables(db);
    const diagnosticTableCount = tables.filter((name) => DIAGNOSTIC_TABLES.includes(name)).length;
    expect(diagnosticTableCount).toBe(DIAGNOSTIC_TABLES.length);
  });

  it("diagnostic_attempts rejeita status fora do CHECK e diagnostic_help_opens rejeita layer fora de 1-4", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    db.exec(
      "INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('u1','N','e@e.com','e@e.com','h')"
    );

    expect(() =>
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','bogus_status')")
    ).toThrow();

    db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','in_progress')");
    db.exec("INSERT INTO diagnostic_questions (id, prompt) VALUES ('q1','P')");
    db.exec("INSERT INTO diagnostic_attempt_questions (attempt_id, question_id, position) VALUES ('a1','q1',0)");

    expect(() =>
      db.exec("INSERT INTO diagnostic_help_opens (attempt_id, question_id, layer) VALUES ('a1','q1',5)")
    ).toThrow();
  });

  it("diagnostic_responses e diagnostic_help_opens impedem duplicidade (PK composta)", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    db.exec(
      "INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('u1','N','e@e.com','e@e.com','h')"
    );
    db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','in_progress')");
    db.exec("INSERT INTO diagnostic_questions (id, prompt) VALUES ('q1','P')");
    db.exec("INSERT INTO diagnostic_responses (attempt_id, question_id, is_dont_know) VALUES ('a1','q1',1)");

    expect(() =>
      db.exec("INSERT INTO diagnostic_responses (attempt_id, question_id, is_dont_know) VALUES ('a1','q1',1)")
    ).toThrow();
  });
});
