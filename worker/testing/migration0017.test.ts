// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 12 v1.0 — migration 0017 (Simulados em Blocos e Análise Factual de
   Desempenho) testada contra o SQL REAL, nunca só a cópia manual em
   worker/testing/fakeD1.ts — mesmo padrão de migration0007-0016.test.ts.
   Puramente aditiva sobre 0001-0016. */

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

function seedBlock(db: DatabaseSync, id: string, userId: string, opts: { blockType?: string; patternId?: string | null; status?: string } = {}): void {
  const blockType = opts.blockType ?? "mixed";
  const patternId = opts.patternId === undefined ? null : opts.patternId;
  const status = opts.status ?? "active";
  db.exec(
    `INSERT INTO simulation_blocks (id, user_id, block_type, primary_pattern_id, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
     VALUES ('${id}','${userId}','${blockType}',${patternId ? `'${patternId}'` : "NULL"},'${status}',5,1,5,'America/Sao_Paulo','2026-09-01')`
  );
}

function seedItem(db: DatabaseSync, id: string, blockId: string, userId: string, questionId: string, position: number, status = "pending"): void {
  db.exec(
    `INSERT INTO simulation_block_items (id, block_id, user_id, question_id, position, estimated_minutes, status)
     VALUES ('${id}','${blockId}','${userId}','${questionId}',${position},5,'${status}')`
  );
}

function markBlockMutation(db: DatabaseSync, blockId: string, mutationId: string): void {
  db.exec(`UPDATE simulation_blocks SET last_mutation_id = '${mutationId}' WHERE id = '${blockId}'`);
}
function markItemMutation(db: DatabaseSync, itemId: string, mutationId: string): void {
  db.exec(`UPDATE simulation_block_items SET last_mutation_id = '${mutationId}' WHERE id = '${itemId}'`);
}

describe("migration 0017 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0017 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0017 sobre o schema real das Sprints 1-11 (0001-0016), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 16));
    db.exec(readMigration("0017_simulation_blocks.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("simulation_blocks");
    expect(tables).toContain("simulation_block_items");
    expect(tables).toContain("simulation_block_events");
    expect(tables).toContain("daily_training_lists"); // 0016 intocada
    expect(tables).toContain("error_notebook_entries"); // 0014 intocada
  });

  it("0017 é inteiramente idempotente por reaplicação direta (só usa IF NOT EXISTS, nenhum ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0017_simulation_blocks.sql"))).not.toThrow();
  });

  it("0017 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM simulation_blocks").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("block_type fora do enum é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO simulation_blocks (id, user_id, block_type, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
         VALUES ('b1','u1','tipo_livre','active',5,1,5,'America/Sao_Paulo','2026-09-01')`
      )
    ).toThrow();
  });

  it("planned_item_count fora de {5,10,15} é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO simulation_blocks (id, user_id, block_type, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
         VALUES ('b1','u1','mixed','active',7,1,5,'America/Sao_Paulo','2026-09-01')`
      )
    ).toThrow();
    expect(() => seedBlock(db, "b2", "u1")).not.toThrow();
  });

  it("bloco pattern_focused SEM primary_pattern_id é rejeitado pelo CHECK combinado", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    expect(() =>
      db.exec(
        `INSERT INTO simulation_blocks (id, user_id, block_type, primary_pattern_id, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
         VALUES ('b1','u1','pattern_focused',NULL,'active',5,1,5,'America/Sao_Paulo','2026-09-01')`
      )
    ).toThrow();
  });

  it("bloco mixed COM primary_pattern_id é rejeitado pelo CHECK combinado", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    expect(() =>
      db.exec(
        `INSERT INTO simulation_blocks (id, user_id, block_type, primary_pattern_id, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
         VALUES ('b1','u1','mixed','p1','active',5,1,5,'America/Sao_Paulo','2026-09-01')`
      )
    ).toThrow();
  });

  it("bloco pattern_focused COM primary_pattern_id é aceito normalmente", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    expect(() => seedBlock(db, "b1", "u1", { blockType: "pattern_focused", patternId: "p1" })).not.toThrow();
  });

  it("actual_item_count deve ser > 0 e <= planned_item_count (nenhum bloco vazio, nenhum excesso)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO simulation_blocks (id, user_id, block_type, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
         VALUES ('b1','u1','mixed','active',5,0,5,'America/Sao_Paulo','2026-09-01')`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO simulation_blocks (id, user_id, block_type, status, planned_item_count, actual_item_count, estimated_minutes, timezone, block_date)
         VALUES ('b2','u1','mixed','active',5,6,5,'America/Sao_Paulo','2026-09-01')`
      )
    ).toThrow();
  });

  it("no máximo um bloco active por aluno — segundo bloco active para o mesmo aluno viola o índice único parcial", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedBlock(db, "b1", "u1");
    expect(() => seedBlock(db, "b2", "u1")).toThrow(/UNIQUE constraint failed/i);
  });

  it("dois blocos active para aluno DIFERENTES são permitidos", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedUser(db, "u2");
    seedBlock(db, "b1", "u1");
    expect(() => seedBlock(db, "b2", "u2")).not.toThrow();
  });

  it("um bloco 'completed' e um 'active' do MESMO aluno são permitidos (o índice só restringe active)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedBlock(db, "b1", "u1", { status: "completed" });
    expect(() => seedBlock(db, "b2", "u1", { status: "active" })).not.toThrow();
  });

  it("nenhuma questão repetida no MESMO bloco — segundo item com a mesma questão viola o índice único", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedBlock(db, "b1", "u1");
    seedItem(db, "i1", "b1", "u1", "q1", 0);
    expect(() => seedItem(db, "i2", "b1", "u1", "q1", 1)).toThrow(/UNIQUE constraint failed/i);
  });

  it("duas posições iguais no MESMO bloco violam o índice único de posição", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedQuestion(db, "q2", "C2");
    seedBlock(db, "b1", "u1");
    seedItem(db, "i1", "b1", "u1", "q1", 0);
    expect(() => seedItem(db, "i2", "b1", "u1", "q2", 0)).toThrow(/UNIQUE constraint failed/i);
  });

  it("status de item fora do enum é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedBlock(db, "b1", "u1");
    expect(() =>
      db.exec(
        `INSERT INTO simulation_block_items (id, block_id, user_id, question_id, position, estimated_minutes, status)
         VALUES ('i1','b1','u1','q1',0,5,'pausado')`
      )
    ).toThrow();
  });

  it("no máximo um item associado à MESMA question_attempt_id — segundo item com o mesmo attempt viola o índice único parcial", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    seedQuestion(db, "q2", "C2");
    db.exec(`INSERT INTO question_attempts (id, user_id, question_id, question_version, mode, status) VALUES ('a1','u1','q1',1,'practice','in_progress')`);
    seedBlock(db, "b1", "u1");
    seedItem(db, "i1", "b1", "u1", "q1", 0);
    db.exec("UPDATE simulation_block_items SET question_attempt_id = 'a1' WHERE id = 'i1'");
    seedItem(db, "i2", "b1", "u1", "q2", 1);
    expect(() => db.exec("UPDATE simulation_block_items SET question_attempt_id = 'a1' WHERE id = 'i2'")).toThrow(/UNIQUE constraint failed/i);
  });

  describe("trigger de identidade (mesmo mecanismo de 0013/0014/0016, seção 19 da ordem)", () => {
    it("evento de bloco (block_applied) cujo id NÃO bate com simulation_blocks.last_mutation_id reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedBlock(db, "b1", "u1");
      seedItem(db, "i1", "b1", "u1", "q1", 0);
      expect(() =>
        db.exec(`BEGIN; INSERT INTO simulation_block_events (id, block_id, user_id, event_type) VALUES ('id-errado','b1','u1','block_applied'); COMMIT;`)
      ).toThrow(/invariante violada/i);
      const count = db.prepare("SELECT COUNT(*) as total FROM simulation_block_events").get() as { total: number };
      expect(count.total).toBe(0);
    });

    it("block_applied exige actual_item_count == contagem real de itens do bloco", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedBlock(db, "b1", "u1"); // actual_item_count = 1, mas nenhum item real inserido ainda
      markBlockMutation(db, "b1", "ev1");
      expect(() => db.exec(`INSERT INTO simulation_block_events (id, block_id, user_id, event_type) VALUES ('ev1','b1','u1','block_applied')`)).toThrow(
        /invariante violada/i
      );
      seedItem(db, "i1", "b1", "u1", "q1", 0);
      markBlockMutation(db, "b1", "ev2");
      expect(() => db.exec(`INSERT INTO simulation_block_events (id, block_id, user_id, event_type) VALUES ('ev2','b1','u1','block_applied')`)).not.toThrow();
    });

    it("evento de item (item_started) sem simulation_block_items.last_mutation_id correspondente reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedBlock(db, "b1", "u1");
      seedItem(db, "i1", "b1", "u1", "q1", 0);
      expect(() =>
        db.exec(
          `BEGIN; INSERT INTO simulation_block_events (id, block_id, item_id, user_id, event_type) VALUES ('id-errado','b1','i1','u1','item_started'); COMMIT;`
        )
      ).toThrow(/invariante violada/i);
    });

    it("evento de item SEM item_id (NULL) para um event_type de item reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedBlock(db, "b1", "u1");
      seedItem(db, "i1", "b1", "u1", "q1", 0);
      markItemMutation(db, "i1", "ev1");
      expect(() =>
        db.exec(`INSERT INTO simulation_block_events (id, block_id, item_id, user_id, event_type) VALUES ('ev1','b1',NULL,'u1','item_started')`)
      ).toThrow(/invariante violada/i);
    });

    it("evento de item cujo bloco/usuário não batem com o item real também reverte", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedUser(db, "u2");
      seedQuestion(db, "q1", "C1");
      seedBlock(db, "b1", "u1");
      seedBlock(db, "b2", "u2");
      seedItem(db, "i1", "b1", "u1", "q1", 0);
      markItemMutation(db, "i1", "ev1");
      expect(() =>
        db.exec(`INSERT INTO simulation_block_events (id, block_id, item_id, user_id, event_type) VALUES ('ev1','b2','i1','u2','item_started')`)
      ).toThrow(/invariante violada/i);
    });

    it("evento com identidade correta é aceito normalmente (caminho feliz)", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedQuestion(db, "q1", "C1");
      seedBlock(db, "b1", "u1");
      seedItem(db, "i1", "b1", "u1", "q1", 0);
      markItemMutation(db, "i1", "ev1");
      expect(() =>
        db.exec(`INSERT INTO simulation_block_events (id, block_id, item_id, user_id, event_type) VALUES ('ev1','b1','i1','u1','item_started')`)
      ).not.toThrow();
    });
  });
});
