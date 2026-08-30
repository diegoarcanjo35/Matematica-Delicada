// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 5 v1.0 — prova exigida pela ordem, seção 5: "migrations 0001 a 0006
   devem funcionar sequencialmente do zero". Mesmo padrão de
   worker/testing/migration0004.test.ts/migration0005.test.ts: lê e executa
   o SQL real de migrations/*.sql com node:sqlite, sem cópia manual. */

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
  "0006_adaptive_schedule_foundation.sql",
];

const SCHEDULE_TABLES = [
  "schedule_activities",
  "schedule_activity_assignments",
  "schedule_activity_events",
  "schedule_preferences",
  "schedule_plan_previews",
];

function listTables(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(
    `INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`
  );
}

function seedActivity(db: DatabaseSync, id: string, minutes = 20): void {
  db.exec(
    `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin)
     VALUES ('${id}', 'treino_de_questoes', 'T', 'O', ${minutes}, 'C', 'E', 'manual', 'system')`
  );
}

describe("migration 0006 (real SQL, não cópia manual)", () => {
  it("aplica as migrations 0001-0006 do zero, em ordem, sem erro", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    const tables = listTables(db);
    for (const table of SCHEDULE_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it("aplica 0006 sobre o schema real das Sprints 1-4 (0001-0005), sem alterar tabelas existentes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readMigration("0001_init.sql"));
    db.exec(readMigration("0002_rate_limit_counters.sql"));
    db.exec(readMigration("0003_student_profiles_onboarding.sql"));
    db.exec(readMigration("0004_initial_diagnostic.sql"));
    db.exec(readMigration("0005_diagnostic_invariants.sql"));

    const tablesBefore = listTables(db);
    for (const table of SCHEDULE_TABLES) {
      expect(tablesBefore).not.toContain(table);
    }

    db.exec(readMigration("0006_adaptive_schedule_foundation.sql"));

    const tablesAfter = listTables(db);
    for (const table of SCHEDULE_TABLES) {
      expect(tablesAfter).toContain(table);
    }
    expect(tablesAfter).toContain("diagnostic_attempts");
    expect(tablesAfter).toContain("student_profiles");
  });

  it("0006 é idempotente: reaplicar não falha e não duplica estrutura", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) {
      db.exec(readMigration(file));
    }
    expect(() => db.exec(readMigration("0006_adaptive_schedule_foundation.sql"))).not.toThrow();

    const tables = listTables(db);
    const scheduleTableCount = tables.filter((name) => SCHEDULE_TABLES.includes(name)).length;
    expect(scheduleTableCount).toBe(SCHEDULE_TABLES.length);
  });

  it("schedule_activities rejeita type/completion_mode/origin fora do CHECK", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) db.exec(readMigration(file));

    expect(() =>
      db.exec(
        `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin)
         VALUES ('a1', 'tipo_bogus', 'T', 'O', 10, 'C', 'E', 'manual', 'system')`
      )
    ).toThrow();

    expect(() =>
      db.exec(
        `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin)
         VALUES ('a2', 'treino_de_questoes', 'T', 'O', 10, 'C', 'E', 'modo_bogus', 'system')`
      )
    ).toThrow();

    expect(() =>
      db.exec(
        `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin)
         VALUES ('a3', 'treino_de_questoes', 'T', 'O', 10, 'C', 'E', 'manual', 'origem_bogus')`
      )
    ).toThrow();
  });

  it("schedule_activities rejeita estimated_minutes <= 0", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) db.exec(readMigration(file));

    expect(() =>
      db.exec(
        `INSERT INTO schedule_activities (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin)
         VALUES ('a1', 'treino_de_questoes', 'T', 'O', 0, 'C', 'E', 'manual', 'system')`
      )
    ).toThrow();
  });

  it("uma atividade concreta não pode ocupar duas posições no mesmo dia do mesmo aluno", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) db.exec(readMigration(file));
    seedUser(db, "u1");
    seedActivity(db, "act1");
    seedActivity(db, "act2");

    db.exec(
      "INSERT INTO schedule_activity_assignments (id, user_id, activity_id, planned_date, position) VALUES ('as1','u1','act1','2026-09-01',0)"
    );

    expect(() =>
      db.exec(
        "INSERT INTO schedule_activity_assignments (id, user_id, activity_id, planned_date, position) VALUES ('as2','u1','act2','2026-09-01',0)"
      )
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("duas atribuições pendentes (planned_date NULL) do mesmo usuário nunca colidem no índice único", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) db.exec(readMigration(file));
    seedUser(db, "u1");
    seedActivity(db, "act1");
    seedActivity(db, "act2");

    expect(() => {
      db.exec(
        "INSERT INTO schedule_activity_assignments (id, user_id, activity_id, planned_date, position) VALUES ('as1','u1','act1',NULL,NULL)"
      );
      db.exec(
        "INSERT INTO schedule_activity_assignments (id, user_id, activity_id, planned_date, position) VALUES ('as2','u1','act2',NULL,NULL)"
      );
    }).not.toThrow();
  });

  it("diagnostic_attempts continua com seu próprio invariante (índice da 0005) intacto após a 0006", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of MIGRATION_FILES) db.exec(readMigration(file));
    seedUser(db, "u1");
    db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a1','u1','in_progress')");
    expect(() =>
      db.exec("INSERT INTO diagnostic_attempts (id, user_id, status) VALUES ('a2','u1','in_progress')")
    ).toThrow(/UNIQUE constraint failed/i);
  });
});
