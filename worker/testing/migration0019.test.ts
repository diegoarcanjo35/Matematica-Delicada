// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 14 v1.0 — migration 0019 (vínculo autorizado professor-aluno)
   testada contra o SQL REAL, nunca só a cópia manual em
   worker/testing/fakeD1.ts — mesmo padrão de migration0007-0018.test.ts.
   Puramente aditiva sobre 0001-0018. */

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
];

function freshDb(files: string[] = MIGRATION_FILES): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(readMigration(file));
  return db;
}

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`);
}

function seedBond(db: DatabaseSync, id: string, teacherId: string, studentId: string, status = "active"): void {
  db.exec(
    `INSERT INTO teacher_student_access (id, teacher_id, student_id, status) VALUES ('${id}','${teacherId}','${studentId}','${status}')`
  );
}

describe("migration 0019 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0019 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0019 sobre o schema real das Sprints 1-13 (0001-0018), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 18));
    db.exec(readMigration("0019_teacher_student_access.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("teacher_student_access");
    expect(tables).toContain("weekly_study_goals"); // 0018 intocada
    expect(tables).toContain("users"); // 0001 intocada
  });

  it("0019 é inteiramente idempotente por reaplicação direta (só usa IF NOT EXISTS, nenhum ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0019_teacher_student_access.sql"))).not.toThrow();
  });

  it("0019 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM teacher_student_access").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("status fora do enum ('active'/'inactive') é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "t1");
    seedUser(db, "s1");
    expect(() =>
      db.exec(`INSERT INTO teacher_student_access (id, teacher_id, student_id, status) VALUES ('b1','t1','s1','pendente')`)
    ).toThrow();
  });

  it("professor == aluno é rejeitado pelo CHECK (teacher_id != student_id)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() => db.exec(`INSERT INTO teacher_student_access (id, teacher_id, student_id, status) VALUES ('b1','u1','u1','active')`)).toThrow();
  });

  it("vínculo duplicado do MESMO par (professor, aluno) viola o índice único, mesmo com status diferente", () => {
    const db = freshDb();
    seedUser(db, "t1");
    seedUser(db, "s1");
    seedBond(db, "b1", "t1", "s1", "active");
    expect(() => seedBond(db, "b2", "t1", "s1", "inactive")).toThrow(/UNIQUE constraint failed/i);
  });

  it("o MESMO aluno pode ter vínculos com DOIS professores diferentes", () => {
    const db = freshDb();
    seedUser(db, "t1");
    seedUser(db, "t2");
    seedUser(db, "s1");
    seedBond(db, "b1", "t1", "s1", "active");
    expect(() => seedBond(db, "b2", "t2", "s1", "active")).not.toThrow();
  });

  it("o MESMO professor pode ter vínculos com vários alunos diferentes", () => {
    const db = freshDb();
    seedUser(db, "t1");
    seedUser(db, "s1");
    seedUser(db, "s2");
    seedBond(db, "b1", "t1", "s1", "active");
    expect(() => seedBond(db, "b2", "t1", "s2", "active")).not.toThrow();
  });

  it("teacher_id inexistente é rejeitado pela FK (quando enforcement de FK está ligado)", () => {
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = ON");
    seedUser(db, "s1");
    expect(() => db.exec(`INSERT INTO teacher_student_access (id, teacher_id, student_id, status) VALUES ('b1','inexistente','s1','active')`)).toThrow();
  });

  it("índices por professor e por aluno existem (idx_teacher_student_access_teacher/idx_teacher_student_access_student)", () => {
    const db = freshDb();
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain("idx_teacher_student_access_pair");
    expect(indexes).toContain("idx_teacher_student_access_teacher");
    expect(indexes).toContain("idx_teacher_student_access_student");
  });

  it("um vínculo pode ser inativado por UPDATE, preservando histórico (nunca precisa de DELETE+INSERT)", () => {
    const db = freshDb();
    seedUser(db, "t1");
    seedUser(db, "s1");
    seedBond(db, "b1", "t1", "s1", "active");
    db.exec(`UPDATE teacher_student_access SET status = 'inactive', updated_at = datetime('now') WHERE id = 'b1'`);
    const row = db.prepare("SELECT status FROM teacher_student_access WHERE id = 'b1'").get() as { status: string };
    expect(row.status).toBe("inactive");
    const count = db.prepare("SELECT COUNT(*) as total FROM teacher_student_access").get() as { total: number };
    expect(count.total).toBe(1);
  });
});
