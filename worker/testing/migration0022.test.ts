// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 18, seção 8/19 da ordem — valida migrations/0022_question_images_placement_r2.sql
   DIRETAMENTE contra SQL real (node:sqlite), nunca só a cópia manual em
   worker/testing/fakeD1.ts — mesmo padrão de migration0009-0012/0021.test.ts.
   Cobre exatamente os itens 30-34 da política de testes desta sprint:
   aplica do zero junto com 0001-0021; aplica sobre schema já migrado; dados
   legados de question_images sobrevivem; FK check limpo; índices/triggers
   editoriais históricos preservados. Migrations 0001-0021 NUNCA são
   editadas — só lidas e aplicadas, exatamente como estão no repositório. */

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
  "0022_question_images_placement_r2.sql",
];

function freshDbThrough0021(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of MIGRATION_FILES.slice(0, -1)) db.exec(readMigration(file));
  return db;
}

function freshDbWith0022(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of MIGRATION_FILES) db.exec(readMigration(file));
  return db;
}

function insertQuestion(db: DatabaseSync, id: string, code: string): void {
  db.exec(
    `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint)
     VALUES ('${id}', '${code}', 'Enunciado', 'media', 'autoral', 'fp-${id}')`
  );
}

describe("migrations/0022_question_images_placement_r2.sql", () => {
  it("item 30 — aplica do zero junto com 0001-0021, sem erro", () => {
    expect(() => freshDbWith0022()).not.toThrow();
  });

  it("0001-0021 sozinhas: question_images NÃO tem placement (prova de que a lacuna era real)", () => {
    const db = freshDbThrough0021();
    const columns = db.prepare("PRAGMA table_info(question_images)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain("placement");
    db.close();
  });

  it("item 31 — aplica sobre schema já migrado (0001-0021 primeiro, depois 0022 isolada), sem erro", () => {
    const db = freshDbThrough0021();
    expect(() => db.exec(readMigration("0022_question_images_placement_r2.sql"))).not.toThrow();
    db.close();
  });

  it("colunas novas existem com o tipo/default esperado", () => {
    const db = freshDbWith0022();
    const columns = db.prepare("PRAGMA table_info(question_images)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName.placement).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'enunciado'" });
    expect(byName.alternative_letter).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(byName.storage_kind).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'local'" });
    expect(byName.mime_type).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(byName.size_bytes).toMatchObject({ type: "INTEGER", notnull: 0 });
    db.close();
  });

  it("item 32 — dados legados de question_images sobrevivem: linha antiga (sem as colunas novas) recebe os defaults corretos", () => {
    const db = freshDbThrough0021();
    insertQuestion(db, "q1", "C1");
    db.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position) VALUES ('img1', 'q1', 'assets/questoes/foo.png', 'Descrição', 0)`);
    db.exec(readMigration("0022_question_images_placement_r2.sql"));
    const row = db.prepare("SELECT * FROM question_images WHERE id = 'img1'").get() as Record<string, unknown>;
    expect(row.asset_ref).toBe("assets/questoes/foo.png");
    expect(row.placement).toBe("enunciado");
    expect(row.alternative_letter).toBeNull();
    expect(row.storage_kind).toBe("local");
    expect(row.mime_type).toBeNull();
    expect(row.size_bytes).toBeNull();
    db.close();
  });

  it("item 33 — FK check limpo após a migration", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    db.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position) VALUES ('img1', 'q1', 'assets/questoes/foo.png', 'Descrição', 0)`);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toEqual([]);
    db.close();
  });

  it("item 34 — índices/triggers editoriais históricos preservados (0009-0012 e 0008 continuam presentes)", () => {
    const db = freshDbWith0022();
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(triggers).toContain("trg_questions_require_history_after_update"); // 0009
    expect(triggers).toContain("trg_editorial_mutation_checks_by_identity"); // 0012 (substitui 0010/0011)
    expect(triggers).toContain("trg_question_images_placement_coherence_insert"); // 0022, novo
    expect(triggers).toContain("trg_question_images_placement_coherence_update"); // 0022, novo

    const indexes = (db.prepare("PRAGMA index_list(question_images)").all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain("idx_question_images_question"); // 0008
    expect(indexes).toContain("idx_question_images_placement"); // 0022, novo
    db.close();
  });

  it("novo índice existe: idx_question_images_placement", () => {
    const db = freshDbWith0022();
    const indexes = db.prepare("PRAGMA index_list(question_images)").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_question_images_placement");
    db.close();
  });

  it("CHECK: placement só aceita 'enunciado'/'alternativa'", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement) VALUES ('img1', 'q1', 'assets/questoes/foo.png', 'D', 0, 'invalido')`)
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("CHECK: alternative_letter só aceita NULL ou A-E", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(
        `INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, alternative_letter) VALUES ('img1', 'q1', 'assets/questoes/foo.png', 'D', 0, 'alternativa', 'Z')`
      )
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("CHECK: storage_kind só aceita 'local'/'r2'", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, storage_kind) VALUES ('img1', 'q1', 'assets/questoes/foo.png', 'D', 0, 'invalido')`)
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("TRIGGER de coerência bloqueia placement='alternativa' sem alternative_letter (INSERT)", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, alternative_letter) VALUES ('img1', 'q1', 'questions/q1/img1.png', 'D', 0, 'alternativa', NULL)`)
    ).toThrow(/invariante violada/);
    db.close();
  });

  it("TRIGGER de coerência bloqueia placement='enunciado' com alternative_letter preenchido (INSERT)", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, alternative_letter) VALUES ('img1', 'q1', 'assets/questoes/foo.png', 'D', 0, 'enunciado', 'A')`)
    ).toThrow(/invariante violada/);
    db.close();
  });

  it("TRIGGER de coerência bloqueia UPDATE que quebra a coerência", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    db.exec(
      `INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, alternative_letter) VALUES ('img1', 'q1', 'questions/q1/img1.png', 'D', 0, 'alternativa', 'A')`
    );
    expect(() => db.exec(`UPDATE question_images SET placement = 'enunciado' WHERE id = 'img1'`)).toThrow(/invariante violada/);
    db.close();
  });

  it("combinação coerente (placement='alternativa' + letra válida) é aceita normalmente", () => {
    const db = freshDbWith0022();
    insertQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(
        `INSERT INTO question_images (id, question_id, asset_ref, alt_text, position, placement, alternative_letter, storage_kind, mime_type, size_bytes) VALUES ('img1', 'q1', 'questions/q1/img1.png', 'D', 0, 'alternativa', 'B', 'r2', 'image/png', 12345)`
      )
    ).not.toThrow();
    const row = db.prepare("SELECT * FROM question_images WHERE id = 'img1'").get() as Record<string, unknown>;
    expect(row.placement).toBe("alternativa");
    expect(row.alternative_letter).toBe("B");
    expect(row.storage_kind).toBe("r2");
    expect(row.mime_type).toBe("image/png");
    expect(row.size_bytes).toBe(12345);
    db.close();
  });
});
