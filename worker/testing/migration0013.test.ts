// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 8 v1.1 — migration 0013 (Player de Questão) testada contra o SQL
   REAL, nunca só a cópia manual em worker/testing/fakeD1.ts — mesmo padrão
   de migration0007-0012.test.ts. Puramente aditiva sobre 0001-0012. */

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
    `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint, editorial_status) VALUES ('${id}', '${code}', 'Enunciado', 'media', 'autoral', 'fp-${id}', 'published')`
  );
}

function seedPattern(db: DatabaseSync, id: string): void {
  db.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${id}', 'PAD-${id}', 'padrao-${id}', 'Padrão ${id}', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
}

function insertAttempt(db: DatabaseSync, id: string, userId: string, questionId: string, mode: string, status = "in_progress"): void {
  db.exec(
    `INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('${id}','${userId}','${questionId}',1,'${mode}','${status}')`
  );
}

/* Sprint 8 v1.2 — desde a correção de atomicidade, todo INSERT em
   question_answer_events/question_recognition_events/question_help_events
   exige (via trigger AFTER INSERT) que question_attempts.last_mutation_id
   já esteja gravado com o MESMO id que o evento vai usar (ver comentário
   extenso no final de 0013). Os testes abaixo que testam as OUTRAS
   restrições dessas tabelas (CHECK/UNIQUE/FK), não a atomicidade em si,
   precisam simular essa identidade manualmente antes de cada INSERT que
   esperam que suceda — testes de atomicidade de verdade (o mecanismo do
   trigger em si) ficam em worker/testing/playerAtomicity.test.ts. */
function markMutation(db: DatabaseSync, attemptId: string, mutationId: string): void {
  db.exec(`UPDATE question_attempts SET last_mutation_id = '${mutationId}' WHERE id = '${attemptId}'`);
}

describe("migration 0013 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0013 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0013 sobre o schema real das Sprints 1-7 (0001-0012), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 12));
    db.exec(readMigration("0013_question_player_attempts.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      "question_attempts",
      "question_answer_events",
      "question_recognition_events",
      "question_help_events",
      "question_review_bookmarks",
      "question_problem_reports",
    ]) {
      expect(tables).toContain(t);
    }
    expect(tables).toContain("questions"); // 0008-0012 intocadas
  });

  it("0013 é inteiramente idempotente por reaplicação direta (só usa IF NOT EXISTS, nenhum ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0013_question_player_attempts.sql"))).not.toThrow();
  });

  it("0013 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM question_attempts").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("uma única tentativa in_progress por usuário+questão+modo — segunda tentativa viola o índice único", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    expect(() => insertAttempt(db, "a2", "u1", "q1", "learning")).toThrow(/UNIQUE constraint failed/i);
  });

  it("duas tentativas in_progress do MESMO usuário+questão em modos DIFERENTES são permitidas", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    expect(() => insertAttempt(db, "a2", "u1", "q1", "practice")).not.toThrow();
  });

  it("duas tentativas COMPLETED do mesmo usuário+questão+modo são permitidas (o índice único só restringe in_progress)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning", "completed");
    expect(() => insertAttempt(db, "a2", "u1", "q1", "learning", "completed")).not.toThrow();
  });

  it("mode fora do enum é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_attempts (id, user_id, question_id, question_version, mode) VALUES ('a1','u1','q1',1,'prova')`)
    ).toThrow();
  });

  it("status fora do enum é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','q1',1,'learning','pending')`)
    ).toThrow();
  });

  it("selected_alternative fora de A-E é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    expect(() => db.exec("UPDATE question_attempts SET selected_alternative = 'Z' WHERE id = 'a1'")).toThrow();
  });

  it("highest_help_layer fora de 0-4 é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    expect(() => db.exec("UPDATE question_attempts SET highest_help_layer = 5 WHERE id = 'a1'")).toThrow();
  });

  it("question_answer_events é insert-only na prática (nenhum código de produção emite UPDATE/DELETE) e aceita event_type só do enum", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    expect(() =>
      db.exec(
        `INSERT INTO question_answer_events (id, attempt_id, new_alternative, event_type) VALUES ('e1','a1','A','invalido')`
      )
    ).toThrow();
    markMutation(db, "a1", "e1");
    expect(() =>
      db.exec(`INSERT INTO question_answer_events (id, attempt_id, new_alternative, event_type) VALUES ('e1','a1','A','selected')`)
    ).not.toThrow();
  });

  it("question_help_events: camada única por tentativa (índice único attempt_id+layer) — segunda abertura da MESMA camada viola", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    markMutation(db, "a1", "h1");
    db.exec("INSERT INTO question_help_events (id, attempt_id, layer) VALUES ('h1','a1',1)");
    // 'h2' nunca bate com last_mutation_id (ainda 'h1') — o trigger de
    // identidade também rejeitaria, mas o índice único (attempt_id, layer)
    // já rejeita primeiro, então marcar a mutação para 'h2' não mudaria o
    // resultado deste caso.
    expect(() => db.exec("INSERT INTO question_help_events (id, attempt_id, layer) VALUES ('h2','a1',1)")).toThrow(/UNIQUE constraint failed/i);
    // Camada diferente da MESMA tentativa é permitida.
    markMutation(db, "a1", "h3");
    expect(() => db.exec("INSERT INTO question_help_events (id, attempt_id, layer) VALUES ('h3','a1',2)")).not.toThrow();
  });

  it("question_help_events: layer fora de 1-4 é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertAttempt(db, "a1", "u1", "q1", "learning");
    markMutation(db, "a1", "h1");
    expect(() => db.exec("INSERT INTO question_help_events (id, attempt_id, layer) VALUES ('h1','a1',0)")).toThrow();
    expect(() => db.exec("INSERT INTO question_help_events (id, attempt_id, layer) VALUES ('h1','a1',5)")).toThrow();
  });

  it("question_review_bookmarks: único por usuário+questão — segunda linha para o mesmo par viola", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    db.exec("INSERT INTO question_review_bookmarks (id, user_id, question_id) VALUES ('b1','u1','q1')");
    expect(() => db.exec("INSERT INTO question_review_bookmarks (id, user_id, question_id) VALUES ('b2','u1','q1')")).toThrow(
      /UNIQUE constraint failed/i
    );
  });

  it("question_problem_reports: categoria fora do enum fechado é rejeitada pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() =>
      db.exec(`INSERT INTO question_problem_reports (id, user_id, question_id, category) VALUES ('r1','u1','q1','categoria_livre')`)
    ).toThrow();
    expect(() =>
      db.exec(`INSERT INTO question_problem_reports (id, user_id, question_id, category) VALUES ('r1','u1','q1','statement_problem')`)
    ).not.toThrow();
  });

  it("question_recognition_events referencia um padrão publicado (FK técnica) e aceita a versão da tentativa", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedPattern(db, "p1");
    insertAttempt(db, "a1", "u1", "q1", "recognition");
    markMutation(db, "a1", "re1");
    expect(() =>
      db.exec(
        `INSERT INTO question_recognition_events (id, attempt_id, pattern_id, clue, strategy, attempt_version) VALUES ('re1','a1','p1','pista','estrategia',2)`
      )
    ).not.toThrow();
  });
});
