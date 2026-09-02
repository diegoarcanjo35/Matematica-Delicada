// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 11 v1.0 — migration 0016 (Treino Diário Real e Listas
   Adaptativas) testada contra o SQL REAL, nunca só a cópia manual em
   worker/testing/fakeD1.ts — mesmo padrão de migration0007-0013.test.ts.
   Puramente aditiva sobre 0001-0015. */

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
];

function freshDb(files: string[] = MIGRATION_FILES): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(readMigration(file));
  return db;
}

function seedUser(db: DatabaseSync, id: string): void {
  db.exec(`INSERT INTO users (id, name, email, email_normalized, password_hash) VALUES ('${id}','N','${id}@e.com','${id}@e.com','h')`);
}

function seedPattern(db: DatabaseSync, id: string): void {
  db.exec(
    `INSERT INTO patterns (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status)
     VALUES ('${id}', 'PAD-${id}', 'padrao-${id}', 'Padrão ${id}', 'F', 'D', 'E', 'X', 'R', 'published')`
  );
}

function seedQuestion(db: DatabaseSync, id: string, code: string): void {
  db.exec(
    `INSERT INTO questions (id, code, enunciado, dificuldade, origem, fingerprint, editorial_status) VALUES ('${id}', '${code}', 'Enunciado', 'media', 'autoral', 'fp-${id}', 'published')`
  );
}

function seedList(db: DatabaseSync, id: string, userId: string, date: string, status = "active"): void {
  db.exec(
    `INSERT INTO daily_training_lists (id, user_id, training_date, timezone, status, estimated_minutes, item_count) VALUES ('${id}','${userId}','${date}','America/Sao_Paulo','${status}',10,1)`
  );
}

function seedItem(db: DatabaseSync, id: string, listId: string, userId: string, questionId: string, position: number, status = "pending"): void {
  db.exec(
    `INSERT INTO daily_training_items (id, list_id, user_id, question_id, origin, reason, player_mode, position, estimated_minutes, status)
     VALUES ('${id}','${listId}','${userId}','${questionId}','development','pattern_in_development','learning',${position},5,'${status}')`
  );
}

/** Mesma convenção de migration0013.test.ts: como os triggers de
 *  identidade exigem last_mutation_id = id do evento ANTES do INSERT do
 *  evento em si, os testes que exercitam OUTRAS restrições (CHECK/UNIQUE/
 *  FK) precisam simular essa identidade manualmente primeiro. */
function markListMutation(db: DatabaseSync, listId: string, mutationId: string): void {
  db.exec(`UPDATE daily_training_lists SET last_mutation_id = '${mutationId}' WHERE id = '${listId}'`);
}
function markItemMutation(db: DatabaseSync, itemId: string, mutationId: string): void {
  db.exec(`UPDATE daily_training_items SET last_mutation_id = '${mutationId}' WHERE id = '${itemId}'`);
}

describe("migration 0016 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0016 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0016 sobre o schema real das Sprints 1-10 (0001-0015), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 15));
    db.exec(readMigration("0016_daily_training_lists.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("daily_training_lists");
    expect(tables).toContain("daily_training_items");
    expect(tables).toContain("daily_training_events");
    expect(tables).toContain("error_notebook_entries"); // 0014 intocada
    expect(tables).toContain("schedule_activity_assignments"); // 0006 intocada
  });

  it("0016 é inteiramente idempotente por reaplicação direta (só usa IF NOT EXISTS, nenhum ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0016_daily_training_lists.sql"))).not.toThrow();
  });

  it("0016 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM daily_training_lists").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("no máximo uma lista active por (user_id, training_date) — segunda lista active para o mesmo dia viola o índice único parcial", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedList(db, "l1", "u1", "2026-09-01");
    expect(() => seedList(db, "l2", "u1", "2026-09-01")).toThrow(/UNIQUE constraint failed/i);
  });

  it("duas listas 'active' em datas DIFERENTES são permitidas", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedList(db, "l1", "u1", "2026-09-01");
    expect(() => seedList(db, "l2", "u1", "2026-09-02")).not.toThrow();
  });

  it("uma lista 'completed' e uma 'active' no MESMO dia são permitidas (o índice só restringe active)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedList(db, "l1", "u1", "2026-09-01", "completed");
    expect(() => seedList(db, "l2", "u1", "2026-09-01", "active")).not.toThrow();
  });

  it("status de lista fora do enum é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO daily_training_lists (id, user_id, training_date, timezone, status, estimated_minutes, item_count) VALUES ('l1','u1','2026-09-01','America/Sao_Paulo','pausada',10,1)`
      )
    ).toThrow();
  });

  it("item_count deve ser > 0 — lista com item_count 0 é rejeitada pelo CHECK (nenhuma lista vazia persistida)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO daily_training_lists (id, user_id, training_date, timezone, status, estimated_minutes, item_count) VALUES ('l1','u1','2026-09-01','America/Sao_Paulo','active',0,0)`
      )
    ).toThrow();
  });

  it("nenhuma questão repetida na MESMA lista — segundo item com a mesma questão viola o índice único", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedList(db, "l1", "u1", "2026-09-01");
    seedItem(db, "i1", "l1", "u1", "q1", 0);
    expect(() => seedItem(db, "i2", "l1", "u1", "q1", 1)).toThrow(/UNIQUE constraint failed/i);
  });

  it("duas posições iguais na MESMA lista violam o índice único de posição", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedQuestion(db, "q2", "C2");
    seedList(db, "l1", "u1", "2026-09-01");
    seedItem(db, "i1", "l1", "u1", "q1", 0);
    expect(() => seedItem(db, "i2", "l1", "u1", "q2", 0)).toThrow(/UNIQUE constraint failed/i);
  });

  it("origin/reason fora do enum fechado são rejeitados pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedList(db, "l1", "u1", "2026-09-01");
    expect(() =>
      db.exec(
        `INSERT INTO daily_training_items (id, list_id, user_id, question_id, origin, reason, player_mode, position, estimated_minutes)
         VALUES ('i1','l1','u1','q1','origem_livre','pattern_in_development','learning',0,5)`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO daily_training_items (id, list_id, user_id, question_id, origin, reason, player_mode, position, estimated_minutes)
         VALUES ('i1','l1','u1','q1','development','razao_livre','learning',0,5)`
      )
    ).toThrow();
  });

  it("skip_reason fora do enum fechado é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedList(db, "l1", "u1", "2026-09-01");
    seedItem(db, "i1", "l1", "u1", "q1", 0);
    expect(() => db.exec("UPDATE daily_training_items SET status = 'skipped', skip_reason = 'motivo_livre' WHERE id = 'i1'")).toThrow();
    expect(() => db.exec("UPDATE daily_training_items SET status = 'skipped', skip_reason = 'not_now' WHERE id = 'i1'")).not.toThrow();
  });

  it("no máximo um item associado à MESMA question_attempt_id — segundo item com o mesmo attempt viola o índice único parcial", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    seedQuestion(db, "q1", "C1");
    seedQuestion(db, "q2", "C2");
    db.exec(`INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','q1',1,'learning','in_progress')`);
    seedList(db, "l1", "u1", "2026-09-01");
    seedItem(db, "i1", "l1", "u1", "q1", 0);
    db.exec("UPDATE daily_training_items SET question_attempt_id = 'a1' WHERE id = 'i1'");
    seedItem(db, "i2", "l1", "u1", "q2", 1);
    expect(() => db.exec("UPDATE daily_training_items SET question_attempt_id = 'a1' WHERE id = 'i2'")).toThrow(/UNIQUE constraint failed/i);
  });

  describe("trigger de identidade (mesmo mecanismo de 0013/0014, seção 15 da ordem)", () => {
    it("evento de lista (list_created) cujo id NÃO bate com daily_training_lists.last_mutation_id reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedList(db, "l1", "u1", "2026-09-01");
      seedItem(db, "i1", "l1", "u1", "q1", 0);
      expect(() =>
        db.exec(`BEGIN; INSERT INTO daily_training_events (id, list_id, user_id, event_type) VALUES ('id-errado','l1','u1','list_created'); COMMIT;`)
      ).toThrow(/invariante violada/i);
      const count = db.prepare("SELECT COUNT(*) as total FROM daily_training_events").get() as { total: number };
      expect(count.total).toBe(0);
    });

    it("list_created exige item_count == contagem real de itens da lista", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedList(db, "l1", "u1", "2026-09-01"); // item_count = 1, mas nenhum item real inserido ainda
      markListMutation(db, "l1", "ev1");
      expect(() => db.exec(`INSERT INTO daily_training_events (id, list_id, user_id, event_type) VALUES ('ev1','l1','u1','list_created')`)).toThrow(
        /invariante violada/i
      );
      // Depois de inserir o item real, a MESMA identidade agora bate.
      seedItem(db, "i1", "l1", "u1", "q1", 0);
      markListMutation(db, "l1", "ev2");
      expect(() => db.exec(`INSERT INTO daily_training_events (id, list_id, user_id, event_type) VALUES ('ev2','l1','u1','list_created')`)).not.toThrow();
    });

    it("evento de item (item_started) sem daily_training_items.last_mutation_id correspondente reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedList(db, "l1", "u1", "2026-09-01");
      seedItem(db, "i1", "l1", "u1", "q1", 0);
      expect(() =>
        db.exec(
          `BEGIN; INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type) VALUES ('id-errado','l1','i1','u1','item_started'); COMMIT;`
        )
      ).toThrow(/invariante violada/i);
    });

    it("evento de item SEM item_id (NULL) para um event_type de item reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedList(db, "l1", "u1", "2026-09-01");
      seedItem(db, "i1", "l1", "u1", "q1", 0);
      markItemMutation(db, "i1", "ev1");
      expect(() =>
        db.exec(`INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type) VALUES ('ev1','l1',NULL,'u1','item_started')`)
      ).toThrow(/invariante violada/i);
    });

    it("evento de item cuja lista/usuário não batem com o item real também reverte (mesma identidade, lista/usuário errados)", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedUser(db, "u2");
      seedQuestion(db, "q1", "C1");
      seedList(db, "l1", "u1", "2026-09-01");
      seedList(db, "l2", "u2", "2026-09-01");
      seedItem(db, "i1", "l1", "u1", "q1", 0);
      markItemMutation(db, "i1", "ev1");
      // event_type de item aponta para i1 (que pertence a l1/u1), mas o
      // evento em si declara list_id/user_id de OUTRO aluno.
      expect(() =>
        db.exec(`INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type) VALUES ('ev1','l2','i1','u2','item_started')`)
      ).toThrow(/invariante violada/i);
    });

    it("evento com identidade correta é aceito normalmente (caminho feliz)", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedList(db, "l1", "u1", "2026-09-01");
      seedItem(db, "i1", "l1", "u1", "q1", 0);
      markItemMutation(db, "i1", "ev1");
      expect(() =>
        db.exec(`INSERT INTO daily_training_events (id, list_id, item_id, user_id, event_type) VALUES ('ev1','l1','i1','u1','item_started')`)
      ).not.toThrow();
    });
  });
});
