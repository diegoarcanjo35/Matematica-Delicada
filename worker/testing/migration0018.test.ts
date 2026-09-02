// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 13 v1.0 — migration 0018 (Relatório Semanal e Metas Realistas)
   testada contra o SQL REAL, nunca só a cópia manual em
   worker/testing/fakeD1.ts — mesmo padrão de migration0007-0017.test.ts.
   Puramente aditiva sobre 0001-0017. */

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

function seedGoal(db: DatabaseSync, id: string, userId: string, opts: { weekStart?: string; status?: string } = {}): void {
  const weekStart = opts.weekStart ?? "2026-08-31";
  const status = opts.status ?? "active";
  db.exec(
    `INSERT INTO weekly_study_goals (id, user_id, week_start, timezone, target_minutes, target_questions, status)
     VALUES ('${id}','${userId}','${weekStart}','America/Sao_Paulo',150,30,'${status}')`
  );
}

function markGoalMutation(db: DatabaseSync, goalId: string, mutationId: string, version = 1): void {
  db.exec(`UPDATE weekly_study_goals SET last_mutation_id = '${mutationId}', version = ${version} WHERE id = '${goalId}'`);
}

describe("migration 0018 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0018 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0018 sobre o schema real das Sprints 1-12 (0001-0017), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 17));
    db.exec(readMigration("0018_weekly_reviews_goals.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("weekly_study_goals");
    expect(tables).toContain("weekly_goal_patterns");
    expect(tables).toContain("weekly_goal_events");
    expect(tables).toContain("simulation_blocks"); // 0017 intocada
    expect(tables).toContain("daily_training_lists"); // 0016 intocada
  });

  it("0018 é inteiramente idempotente por reaplicação direta (só usa IF NOT EXISTS, nenhum ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0018_weekly_reviews_goals.sql"))).not.toThrow();
  });

  it("0018 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM weekly_study_goals").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("status fora do enum é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO weekly_study_goals (id, user_id, week_start, timezone, target_minutes, target_questions, status)
         VALUES ('g1','u1','2026-08-31','America/Sao_Paulo',150,30,'pausada')`
      )
    ).toThrow();
  });

  it("target_minutes <= 0 é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO weekly_study_goals (id, user_id, week_start, timezone, target_minutes, target_questions, status)
         VALUES ('g1','u1','2026-08-31','America/Sao_Paulo',0,30,'active')`
      )
    ).toThrow();
  });

  it("target_questions <= 0 é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    expect(() =>
      db.exec(
        `INSERT INTO weekly_study_goals (id, user_id, week_start, timezone, target_minutes, target_questions, status)
         VALUES ('g1','u1','2026-08-31','America/Sao_Paulo',150,0,'active')`
      )
    ).toThrow();
  });

  it("no máximo uma meta active por (usuário, week_start) — segunda meta active viola o índice único parcial", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedGoal(db, "g1", "u1");
    expect(() => seedGoal(db, "g2", "u1")).toThrow(/UNIQUE constraint failed/i);
  });

  it("metas active para semanas DIFERENTES do mesmo aluno são permitidas", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedGoal(db, "g1", "u1", { weekStart: "2026-08-31" });
    expect(() => seedGoal(db, "g2", "u1", { weekStart: "2026-09-07" })).not.toThrow();
  });

  it("uma meta 'abandoned' e uma 'active' na MESMA semana do mesmo aluno são permitidas (o índice só restringe active)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedGoal(db, "g1", "u1", { status: "abandoned" });
    expect(() => seedGoal(db, "g2", "u1", { status: "active" })).not.toThrow();
  });

  it("priority_position fora de 1..3 é rejeitado pelo CHECK", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    seedGoal(db, "g1", "u1");
    expect(() =>
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position) VALUES ('wp1','g1','u1','p1',4)`)
    ).toThrow();
    expect(() =>
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position) VALUES ('wp1','g1','u1','p1',0)`)
    ).toThrow();
  });

  it("mutation_id é obrigatório (NOT NULL) — PO v1.1, correção A: toda linha de padrão precisa da identidade da mutação que a inseriu", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    seedGoal(db, "g1", "u1");
    expect(() =>
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position) VALUES ('wp1','g1','u1','p1',1)`)
    ).toThrow(/NOT NULL constraint failed/i);
  });

  it("padrão duplicado na MESMA meta viola o índice único (goal_id, pattern_id)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    seedGoal(db, "g1", "u1");
    db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'m1')`);
    expect(() =>
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp2','g1','u1','p1',2,'m1')`)
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("posição duplicada na MESMA meta viola o índice único (goal_id, priority_position) — no máximo 3 padrões por construção", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    seedPattern(db, "p2");
    seedGoal(db, "g1", "u1");
    db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'m1')`);
    expect(() =>
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp2','g1','u1','p2',1,'m1')`)
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("mesmo padrão em DUAS metas diferentes é permitido (unicidade é só dentro da mesma meta)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedPattern(db, "p1");
    seedGoal(db, "g1", "u1", { weekStart: "2026-08-31" });
    seedGoal(db, "g2", "u1", { weekStart: "2026-09-07" });
    db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'m1')`);
    expect(() =>
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp2','g2','u1','p1',1,'m2')`)
    ).not.toThrow();
  });

  describe("trigger de identidade (mesmo mecanismo de 0013/0014/0016/0017)", () => {
    it("evento cujo id NÃO bate com weekly_study_goals.last_mutation_id reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedGoal(db, "g1", "u1");
      expect(() =>
        db.exec(
          `BEGIN; INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, to_status, goal_version) VALUES ('id-errado','g1','u1','goal_created','active',1); COMMIT;`
        )
      ).toThrow(/invariante violada/i);
      const count = db.prepare("SELECT COUNT(*) as total FROM weekly_goal_events").get() as { total: number };
      expect(count.total).toBe(0);
    });

    it("evento cujo goal_version NÃO bate com a versão real da meta também reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 1);
      expect(() =>
        db.exec(`INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, to_status, goal_version) VALUES ('ev1','g1','u1','goal_created','active',2)`)
      ).toThrow(/invariante violada/i);
    });

    it("evento de meta de OUTRO usuário (mesma identidade de mutationId, usuário errado) reverte", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedUser(db, "u2");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 1);
      expect(() =>
        db.exec(`INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, to_status, goal_version) VALUES ('ev1','g1','u2','goal_created','active',1)`)
      ).toThrow(/invariante violada/i);
    });

    it("evento com identidade e versão corretas é aceito normalmente (caminho feliz)", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 1);
      expect(() =>
        db.exec(`INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, to_status, goal_version) VALUES ('ev1','g1','u1','goal_created','active',1)`)
      ).not.toThrow();
    });
  });

  describe("PO v1.1, correção A — bloco do trigger que valida weekly_goal_patterns por identidade (patterns_expected_count)", () => {
    it("patterns_expected_count fora de 0..3 é rejeitado pelo CHECK", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 1);
      expect(() =>
        db.exec(
          `INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, to_status, goal_version, patterns_expected_count) VALUES ('ev1','g1','u1','goal_created','active',1,4)`
        )
      ).toThrow();
    });

    it("patterns_expected_count NULO (mutação que não toca padrões) nunca valida weekly_goal_patterns — aceita mesmo com linhas de OUTRA mutação sobrando", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedPattern(db, "p1");
      seedGoal(db, "g1", "u1");
      // Linha de padrão de uma mutação ANTERIOR, nunca tocada por este evento.
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'ev-anterior')`);
      markGoalMutation(db, "g1", "ev1", 2);
      expect(() =>
        db.exec(`INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, from_status, to_status, goal_version) VALUES ('ev1','g1','u1','goal_updated','active','active',2)`)
      ).not.toThrow();
    });

    it("patterns_expected_count preenchido mas SEM nenhuma linha carimbada com este mutation_id (DELETE silenciosamente não removeu, e nenhum INSERT novo aconteceu) reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedPattern(db, "p1");
      seedGoal(db, "g1", "u1");
      // Linha órfã de uma mutação ANTERIOR — simula um DELETE que deveria
      // ter removido esta linha, mas silenciosamente afetou 0 linhas.
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'ev-anterior')`);
      markGoalMutation(db, "g1", "ev1", 2);
      expect(() =>
        db.exec(
          `INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, from_status, to_status, goal_version, patterns_expected_count) VALUES ('ev1','g1','u1','goal_updated','active','active',2,0)`
        )
      ).toThrow(/invariante violada/i);
    });

    it("patterns_expected_count preenchido mas a contagem REAL carimbada com este mutation_id diverge do declarado reverte a transação inteira", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedPattern(db, "p1");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 2);
      // Só 1 linha foi de fato carimbada com 'ev1', mas o evento afirma 2.
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'ev1')`);
      expect(() =>
        db.exec(
          `INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, from_status, to_status, goal_version, patterns_expected_count) VALUES ('ev1','g1','u1','goal_updated','active','active',2,2)`
        )
      ).toThrow(/invariante violada/i);
    });

    it("patterns_expected_count preenchido, coleção genuinamente substituída (todas as linhas carimbadas com este mutation_id, contagem batendo) é aceito normalmente (caminho feliz)", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedPattern(db, "p1");
      seedPattern(db, "p2");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 2);
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp1','g1','u1','p1',1,'ev1')`);
      db.exec(`INSERT INTO weekly_goal_patterns (id, goal_id, user_id, pattern_id, priority_position, mutation_id) VALUES ('wp2','g1','u1','p2',2,'ev1')`);
      expect(() =>
        db.exec(
          `INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, from_status, to_status, goal_version, patterns_expected_count) VALUES ('ev1','g1','u1','goal_updated','active','active',2,2)`
        )
      ).not.toThrow();
    });

    it("patterns_expected_count = 0 (limpeza explícita) com a coleção genuinamente vazia é aceito normalmente (caminho feliz)", () => {
      const db = freshDb();
      seedUser(db, "u1");
      seedGoal(db, "g1", "u1");
      markGoalMutation(db, "g1", "ev1", 2);
      expect(() =>
        db.exec(
          `INSERT INTO weekly_goal_events (id, goal_id, user_id, event_type, from_status, to_status, goal_version, patterns_expected_count) VALUES ('ev1','g1','u1','goal_updated','active','active',2,0)`
        )
      ).not.toThrow();
    });
  });
});

/* A prova de ROLLBACK REAL de um db.batch() inteiro (núcleo + padrões +
   evento) diante de uma falha forçada em qualquer statement é feita contra
   o FakeD1Database real (worker/testing/fakeD1.ts, que implementa
   BEGIN/COMMIT/ROLLBACK verdadeiro) em
   worker/testing/weeklyReviewAtomicity.test.ts — nunca aqui: `db.exec` de
   múltiplas statements do node:sqlite não faz rollback automático ao
   lançar no meio de um `BEGIN...COMMIT` textual (diferente de
   FakeD1Database.batch(), que envolve cada lote num try/catch com
   ROLLBACK explícito) — este arquivo testa só CHECK/UNIQUE/trigger
   isolados, mesmo escopo de migration0007-0017.test.ts. */
