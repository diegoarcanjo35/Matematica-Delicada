// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 7 v1.3 — prova exigida pela correção final: o trigger
   `trg_questions_require_history_after_update` é testado contra o SQL REAL
   de migrations/0009_editorial_batch_invariants.sql (nunca só a cópia
   manual em worker/testing/fakeD1.ts) — mesmo padrão de
   migration0007.test.ts/migration0008.test.ts. */

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
];

function freshDb(files: string[] = MIGRATION_FILES): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(readMigration(file));
  return db;
}

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`);
}

function seedQuestion(db: DatabaseSync, id: string, code: string): void {
  db.exec(
    `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint) VALUES ('${id}', '${code}', 'Enunciado', 'media', 'autoral', 'fp-${id}')`
  );
}

describe("migration 0009 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0009 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0009 sobre o schema real das Sprints 1-7 (0001-0008), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 8));
    db.exec(readMigration("0009_editorial_batch_invariants.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("questions");
    expect(tables).toContain("question_history");
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(triggers).toContain("trg_questions_require_history_after_update");
  });

  it("0009 é idempotente: reaplicar não falha e não duplica o trigger", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0009_editorial_batch_invariants.sql"))).not.toThrow();
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).filter(
      (r) => r.name === "trg_questions_require_history_after_update"
    );
    expect(triggers).toHaveLength(1);
  });

  it("a migration 0009 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM question_history").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("UPDATE em questions.version SEM question_history correspondente é ABORTADO pelo trigger (RAISE ABORT)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() => db.exec("UPDATE questions SET version = version + 1 WHERE id = 'q1'")).toThrow(/invariante violada/i);
    const row = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(row.version).toBe(1); // rollback do próprio statement
  });

  it("UPDATE em questions.version COM question_history correspondente (mesma version) é aceito", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    db.exec("INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('h1','q1','u1','updated','draft','draft',2)");
    expect(() => db.exec("UPDATE questions SET version = version + 1 WHERE id = 'q1'")).not.toThrow();
    const row = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(row.version).toBe(2);
  });

  it("UPDATE em questions que NÃO muda version nunca dispara o trigger (mesmo sem histórico nenhum)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() => db.exec("UPDATE questions SET editorial_status = 'in_review' WHERE id = 'q1'")).not.toThrow();
    const row = db.prepare("SELECT editorial_status FROM questions WHERE id = 'q1'").get() as { editorial_status: string };
    expect(row.editorial_status).toBe("in_review");
  });

  it("dentro de uma transação explícita, um UPDATE inválido (sem histórico) reverte a transação INTEIRA — inclusive mudanças de statements anteriores no mesmo lote", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedQuestion(db, "q2", "C2");

    expect(() => {
      db.exec("BEGIN");
      try {
        // Muda q2 de forma legítima e inócua (não mexe em version).
        db.prepare("UPDATE questions SET editorial_status = 'in_review' WHERE id = ?").run("q2");
        // q1: muda version SEM histórico correspondente — deveria abortar tudo.
        db.prepare("UPDATE questions SET version = version + 1 WHERE id = ?").run("q1");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/invariante violada/i);

    // A mudança em q2, que tecnicamente "rodou" antes do erro, também foi
    // revertida — a transação inteira nunca commitou.
    const q2 = db.prepare("SELECT editorial_status FROM questions WHERE id = 'q2'").get() as { editorial_status: string };
    expect(q2.editorial_status).toBe("draft");
    const q1 = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(q1.version).toBe(1);
  });
});
