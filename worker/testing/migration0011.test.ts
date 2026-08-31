// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 7 v1.5 — prova exigida pela correção: o trigger
   `trg_editorial_mutation_checks_collection_receipts` é testado contra o
   SQL REAL de migrations/0011_editorial_collection_mutation_receipts.sql
   (nunca só a cópia manual em worker/testing/fakeD1.ts) — mesmo padrão de
   migration0009.test.ts/migration0010.test.ts. Fecha o buraco que 0010
   sozinha deixava para coleções ESVAZIADAS (`*_expected_count = 0`), cuja
   contagem carimbada por version_stamp é sempre zero e por isso não prova
   nada. NÃO edita 0009/0010 — ambas continuam com seus próprios triggers,
   testados em arquivos separados, intocados por este. */

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

function insertMutationCheck(
  db: DatabaseSync,
  params: {
    id: string;
    questionId: string;
    expectedVersion: number;
    alternativesExpectedCount?: number | null;
    dnaExpectedCount?: number | null;
    patternsExpectedCount?: number | null;
    tagsExpectedCount?: number | null;
    imagesExpectedCount?: number | null;
  }
): void {
  const stmt = db.prepare(
    `INSERT INTO editorial_mutation_checks
       (id, question_id, expected_version, alternatives_expected_count, dna_expected_count, patterns_expected_count, tags_expected_count, images_expected_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(
    params.id,
    params.questionId,
    params.expectedVersion,
    params.alternativesExpectedCount ?? null,
    params.dnaExpectedCount ?? null,
    params.patternsExpectedCount ?? null,
    params.tagsExpectedCount ?? null,
    params.imagesExpectedCount ?? null
  );
}

function insertReceipt(db: DatabaseSync, id: string, questionId: string, collection: string, expectedVersion: number): void {
  db.exec(
    `INSERT INTO question_collection_mutation_receipts (id, question_id, collection, expected_version) VALUES ('${id}','${questionId}','${collection}',${expectedVersion})`
  );
}

describe("migration 0011 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0011 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0011 sobre o schema real das Sprints 1-7 (0001-0010), sem alterar tabelas/triggers existentes de 0009/0010", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 10));
    db.exec(readMigration("0011_editorial_collection_mutation_receipts.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("question_collection_mutation_receipts");
    expect(tables).toContain("editorial_mutation_checks"); // 0010 intocada
    expect(tables).toContain("questions"); // 0009 intocada
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(triggers).toContain("trg_editorial_mutation_checks_collection_receipts");
    expect(triggers).toContain("trg_editorial_mutation_checks_bidirectional"); // 0010 intocada
    expect(triggers).toContain("trg_questions_require_history_after_update"); // 0009 intocada
  });

  it("0011 é INTEIRAMENTE idempotente por reaplicação direta (só usa IF NOT EXISTS — ao contrário de 0010, não precisou de ALTER TABLE)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0011_editorial_collection_mutation_receipts.sql"))).not.toThrow();
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).filter(
      (r) => r.name === "trg_editorial_mutation_checks_collection_receipts"
    );
    expect(triggers).toHaveLength(1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).filter(
      (r) => r.name === "question_collection_mutation_receipts"
    );
    expect(tables).toHaveLength(1);
  });

  it("a migration 0011 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM question_collection_mutation_receipts").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("0009 e 0010 permanecem EXATAMENTE como antes: seus triggers continuam isolados e funcionando", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // 0009: version muda sem histórico -> aborta.
    expect(() => db.exec("UPDATE questions SET version = version + 1 WHERE id = 'q1'")).toThrow(/invariante violada/i);
    // 0010: marcador com núcleo/histórico divergentes -> aborta.
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 1 })).toThrow(/invariante violada/i);
  });

  it("coleção TOCADA (expected_count não-null), núcleo NA versão esperada e recibo correspondente existe -> aceito", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    db.exec(
      "INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('h1','q1','u1','updated','draft','draft',2)"
    );
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
    insertReceipt(db, "r1", "q1", "question_tags", 2);
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).not.toThrow();
  });

  it("GAP FECHADO — coleção ESVAZIADA (expected_count = 0): núcleo mudou mas o recibo NÃO existe (DELETE guardado teria afetado 0 linhas silenciosamente) -> abortado, mesmo a contagem coincidindo trivialmente em 0", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    db.exec(
      "INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('h1','q1','u1','updated','draft','draft',2)"
    );
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
    // NENHUM recibo é inserido para 'question_tags' — simula o DELETE
    // guardado da coleção tendo silenciosamente afetado 0 linhas.
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).toThrow(/invariante violada/i);
  });

  it("recibo existe mas o núcleo NÃO está na versão esperada -> abortado (direção oposta)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Núcleo fica em v1 (nunca avança) mas um recibo para v2 existe.
    insertReceipt(db, "r1", "q1", "question_tags", 2);
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).toThrow(/invariante violada/i);
  });

  it("guard falha CONSISTENTEMENTE em toda a mutação (409 legítimo): núcleo NÃO muda e recibo também NÃO existe -> ACEITO, nunca uma exceção de banco (mesma classe de correção já aplicada em 0010 para contagem)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Núcleo fica em v1; marcador declara expectativa de v2 (como se a
    // mutação tivesse sido tentada); nenhum recibo foi gravado (guard
    // falhou identicamente para o DELETE e para o recibo).
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).not.toThrow();
  });

  it("coleção NÃO tocada (expected_count null) nunca é checada, mesmo sem nenhum recibo", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    db.exec(
      "INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('h1','q1','u1','updated','draft','draft',2)"
    );
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
    // tagsExpectedCount omitido (null) — mutação não tocou tags.
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2 })).not.toThrow();
  });

  it("dentro de uma transação explícita, a ausência do recibo reverte a transação INTEIRA — inclusive o UPDATE central que rodou antes no mesmo lote", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    db.exec(
      "INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES ('t-old','q1','tag-antiga',0,1)"
    );

    expect(() => {
      db.exec("BEGIN");
      try {
        db.exec(
          "INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('h1','q1','u1','updated','draft','draft',2)"
        );
        // DELETE real da coleção RODA e limpa de verdade...
        db.exec("DELETE FROM question_tags WHERE question_id = 'q1'");
        db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
        // ...mas o recibo correspondente é OMITIDO (simula um bug futuro
        // que esqueceu de gravar o recibo, ou o guard do recibo divergindo
        // do guard do DELETE por algum motivo).
        insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/invariante violada/i);

    const question = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(question.version).toBe(1);
    const history = db.prepare("SELECT COUNT(*) as total FROM question_history WHERE question_id = 'q1'").get() as { total: number };
    expect(history.total).toBe(0);
    // O DELETE que "rodou" também foi revertido — a tag antiga voltou.
    const tags = db.prepare("SELECT COUNT(*) as total FROM question_tags WHERE question_id = 'q1'").get() as { total: number };
    expect(tags.total).toBe(1);
  });
});
