// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Correção Final v1.2, seção 4/6 — prova de que o invariante "no máximo uma
   diagnostic_attempts in_progress por usuário" existe de verdade no SCHEMA
   (não só na aplicação), lendo e executando o SQL real de migrations/*.sql
   com node:sqlite — mesmo padrão de worker/testing/migration0004.test.ts. */

const MIGRATIONS_DIR = resolve(__dirname, "../../migrations");

function readMigration(filename: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), "utf-8");
}

const MIGRATION_FILES = [
  "0001_init.sql",
  "0002_rate_limit_counters.sql",
  "0003_student_profiles_onboarding.sql",
  "0004_initial_diagnostic.sql",
  "0005_diagnostic_invariants.sql",
];

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(
    `INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`
  );
}

describe("migration 0005 (real SQL, não cópia manual)", () => {
  it("aplica as migrations 0001-0005 do zero, em ordem, sem erro", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    const indexRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_diagnostic_attempts_one_active_per_user");
    expect(indexRow).toBeDefined();
  });

  it("aplica 0005 sobre o schema real de 0001-0004, sem reescrever a migration anterior", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0001_init.sql"));
    db.exec(readMigration("0002_rate_limit_counters.sql"));
    db.exec(readMigration("0003_student_profiles_onboarding.sql"));
    db.exec(readMigration("0004_initial_diagnostic.sql"));

    // Tabelas da 0004 já existem e continuam intactas após a 0005.
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    expect(tablesBefore.map((row) => row.name)).toContain("diagnostic_attempts");

    expect(() => db.exec(readMigration("0005_diagnostic_invariants.sql"))).not.toThrow();
  });

  it("0005 é idempotente: reaplicar não falha e não duplica o índice", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    expect(() => db.exec(readMigration("0005_diagnostic_invariants.sql"))).not.toThrow();

    const indexRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .all("idx_diagnostic_attempts_one_active_per_user");
    expect(indexRows).toHaveLength(1);
  });

  it("schema rejeita diretamente duas tentativas in_progress do mesmo usuário", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    seedUser(db, "u1");
    db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','in_progress')");

    expect(() =>
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a2','u1','in_progress')")
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("múltiplas tentativas completed/abandoned do mesmo usuário continuam permitidas", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    seedUser(db, "u1");

    expect(() => {
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','completed')");
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a2','u1','completed')");
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a3','u1','abandoned')");
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a4','u1','abandoned')");
    }).not.toThrow();

    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM diagnostic_attempts WHERE user_id = 'u1'")
      .get() as { count: number };
    expect(countRow.count).toBe(4);
  });

  it("uma tentativa in_progress convivendo com várias completed/abandoned do mesmo usuário é permitido", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    seedUser(db, "u1");

    expect(() => {
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','abandoned')");
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a2','u1','completed')");
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a3','u1','in_progress')");
    }).not.toThrow();

    // Diferentes usuários podem, cada um, ter sua própria in_progress.
    seedUser(db, "u2");
    expect(() =>
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a4','u2','in_progress')")
    ).not.toThrow();
  });
});
