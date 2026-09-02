// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 15 v1.0/v1.1 — migration 0020 (admin_bootstrap_state + trigger de
   proteção do último admin) testada contra o SQL REAL, nunca só a cópia
   manual em worker/testing/fakeD1.ts — mesmo padrão de
   migration0007-0019.test.ts. Puramente aditiva sobre 0001-0019. */

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
];

function freshDb(files: string[] = MIGRATION_FILES): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(readMigration(file));
  return db;
}

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`);
}

function seedAdminRole(db: DatabaseSync, userId: string, rowId: string): void {
  db.exec(`INSERT OR IGNORE INTO roles (id, name) VALUES ('role-admin', 'admin')`);
  db.exec(`INSERT INTO user_roles (id, user_id, role_id, granted_by) VALUES ('${rowId}', '${userId}', 'role-admin', NULL)`);
}

describe("migration 0020 (SQL real, não cópia manual)", () => {
  it(
    "aplica as migrations 0001-0020 do zero, em ordem, sem erro",
    () => {
      expect(() => freshDb()).not.toThrow();
    },
    15_000 // primeira aplicação de 20 migrations em sequência no worker "frio" deste arquivo pode passar de 5s (limite padrão do Vitest) só por custo de inicialização — nunca um loop/travamento real, ver as demais asserções abaixo que também chamam freshDb() e passam normalmente.
  );

  it("aplica 0020 sobre o schema real das Sprints 1-14 (0001-0019), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 19));
    db.exec(readMigration("0020_admin_user_management.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("admin_bootstrap_state");
    expect(tables).toContain("teacher_student_access"); // 0019 intocada
    expect(tables).toContain("users"); // 0001 intocada
  });

  it("0020 é inteiramente idempotente por reaplicação direta (só usa IF NOT EXISTS, nenhum ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0020_admin_user_management.sql"))).not.toThrow();
  });

  it("0020 NÃO insere nenhum conteúdo (admin_bootstrap_state nasce vazia)", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM admin_bootstrap_state").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("só a linha id='singleton' é aceita em admin_bootstrap_state (CHECK)", () => {
    const db = freshDb();
    seedUser(db, "a1");
    seedUser(db, "a2");
    expect(() =>
      db.exec(
        `INSERT INTO admin_bootstrap_state (id, completed_by, promoted_user_id_1, promoted_user_id_2, mutation_id) VALUES ('outro-id','x','a1','a2','m1')`
      )
    ).toThrow();
  });

  it("uma segunda linha 'singleton' viola a PRIMARY KEY (garantia real do one-shot)", () => {
    const db = freshDb();
    seedUser(db, "a1");
    seedUser(db, "a2");
    seedUser(db, "a3");
    seedUser(db, "a4");
    db.exec(
      `INSERT INTO admin_bootstrap_state (id, completed_by, promoted_user_id_1, promoted_user_id_2, mutation_id) VALUES ('singleton','x','a1','a2','m1')`
    );
    expect(() =>
      db.exec(
        `INSERT INTO admin_bootstrap_state (id, completed_by, promoted_user_id_1, promoted_user_id_2, mutation_id) VALUES ('singleton','x','a3','a4','m2')`
      )
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("promoted_user_id_1 igual a promoted_user_id_2 é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "a1");
    expect(() =>
      db.exec(
        `INSERT INTO admin_bootstrap_state (id, completed_by, promoted_user_id_1, promoted_user_id_2, mutation_id) VALUES ('singleton','x','a1','a1','m1')`
      )
    ).toThrow();
  });

  it("remover o ÚNICO admin é bloqueado pelo trigger trg_user_roles_protect_last_admin", () => {
    const db = freshDb();
    seedUser(db, "admin1");
    seedAdminRole(db, "admin1", "ur1");
    expect(() => db.exec(`DELETE FROM user_roles WHERE id = 'ur1'`)).toThrow(/não é possível remover o último administrador/i);
    const count = db.prepare("SELECT COUNT(*) as total FROM user_roles WHERE role_id = 'role-admin'").get() as { total: number };
    expect(count.total).toBe(1);
  });

  it("remover UM admin quando existem DOIS é permitido pelo trigger", () => {
    const db = freshDb();
    seedUser(db, "admin1");
    seedUser(db, "admin2");
    seedAdminRole(db, "admin1", "ur1");
    seedAdminRole(db, "admin2", "ur2");
    expect(() => db.exec(`DELETE FROM user_roles WHERE id = 'ur1'`)).not.toThrow();
    const count = db.prepare("SELECT COUNT(*) as total FROM user_roles WHERE role_id = 'role-admin'").get() as { total: number };
    expect(count.total).toBe(1);
  });

  it("remover um papel QUE NÃO É admin nunca é bloqueado pelo trigger, mesmo sendo o único", () => {
    const db = freshDb();
    seedUser(db, "t1");
    db.exec(`INSERT OR IGNORE INTO roles (id, name) VALUES ('role-teacher', 'teacher')`);
    db.exec(`INSERT INTO user_roles (id, user_id, role_id, granted_by) VALUES ('ur-t1', 't1', 'role-teacher', NULL)`);
    expect(() => db.exec(`DELETE FROM user_roles WHERE id = 'ur-t1'`)).not.toThrow();
  });
});
