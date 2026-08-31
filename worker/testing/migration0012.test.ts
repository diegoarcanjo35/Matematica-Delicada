// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 7 v1.6 — prova exigida pela correção: o trigger consolidado
   `trg_editorial_mutation_checks_by_identity` é testado contra o SQL REAL
   de migrations/0012_editorial_mutation_identity.sql (nunca só a cópia
   manual em worker/testing/fakeD1.ts) — mesmo padrão de
   migration0009/0010/0011.test.ts. Corrige o colapso de identidade em
   0010 E 0011 (ambos checavam "existe ALGO para esta versão?", nunca "isto
   é resultado DESTA mutação?") — reproduzido em
   worker/testing/questions.test.ts, describe "Sprint 7 v1.6". Esta migration
   RETIRA (DROP) os dois triggers de 0010/0011 e os substitui por um único
   trigger consolidado, atrelado a `last_mutation_id`/identidade — nunca a
   um número de versão sozinho. Os ARQUIVOS de 0010/0011 continuam
   intocados (testados isoladamente, sem 0012 aplicada, em
   migration0010.test.ts/migration0011.test.ts). */

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

function insertHistory(db: DatabaseSync, id: string, questionId: string, userId: string, version: number): void {
  db.exec(
    `INSERT INTO question_history (id, question_id, user_id, action, from_status, to_status, version) VALUES ('${id}','${questionId}','${userId}','updated','draft','draft',${version})`
  );
}

function insertReceipt(db: DatabaseSync, id: string, questionId: string, collection: string, expectedVersion: number): void {
  db.exec(
    `INSERT INTO question_collection_mutation_receipts (id, question_id, collection, expected_version) VALUES ('${id}','${questionId}','${collection}',${expectedVersion})`
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

describe("migration 0012 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0012 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0012 sobre o schema real das Sprints 1-7 (0001-0011): adiciona last_mutation_id, remove os DOIS triggers de 0010 E 0011, cria o trigger consolidado por identidade — sem editar os ARQUIVOS de 0009/0010/0011", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 11));
    db.exec(readMigration("0012_editorial_mutation_identity.sql"));
    const columns = (db.prepare("PRAGMA table_info(questions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("last_mutation_id");
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(triggers).toContain("trg_editorial_mutation_checks_by_identity");
    expect(triggers).not.toContain("trg_editorial_mutation_checks_collection_receipts"); // trigger de 0011, retirado
    expect(triggers).not.toContain("trg_editorial_mutation_checks_bidirectional"); // trigger de 0010, retirado
    // 0009 é a ÚNICA das três migrations anteriores cujo trigger permanece
    // ativo (ver nota extensa em 0012 sobre por que ele é seguro).
    expect(triggers).toContain("trg_questions_require_history_after_update");
  });

  it("0009 permanece EXATAMENTE como antes e continua ativo: seu trigger não sofre do bug de identidade (audita o PRÓPRIO UPDATE que rodou, nunca compara com um marcador externo) e continua funcionando após 0012", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() => db.exec("UPDATE questions SET version = version + 1 WHERE id = 'q1'")).toThrow(/invariante violada/i);
  });

  it("0010 e 0011, testadas ISOLADAMENTE sem 0012 aplicada (migration0010.test.ts/migration0011.test.ts), continuam com seus arquivos .sql originais intocados — 0012 nunca edita esses arquivos, só o schema resultante quando aplicada por cima", () => {
    // Confere que os ARQUIVOS de 0010/0011 ainda contêm seus triggers
    // originais tal como escritos naquelas migrations (prova textual de que
    // não foram editados) — o DROP acontece apenas no schema, via SQL
    // executado por 0012, nunca alterando os .sql anteriores.
    const sql0010 = readMigration("0010_editorial_bidirectional_invariants.sql");
    const sql0011 = readMigration("0011_editorial_collection_mutation_receipts.sql");
    expect(sql0010).toContain("CREATE TRIGGER IF NOT EXISTS trg_editorial_mutation_checks_bidirectional");
    expect(sql0011).toContain("CREATE TRIGGER IF NOT EXISTS trg_editorial_mutation_checks_collection_receipts");
  });

  it("a linha ALTER TABLE de 0012 NÃO é idempotente por reaplicação manual direta — mesma ressalva documentada em 0010 (SQLite não suporta ADD COLUMN IF NOT EXISTS nesta versão; D1/Wrangler nunca reaplicam o mesmo arquivo de migration)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0012_editorial_mutation_identity.sql"))).toThrow(/duplicate column name/i);
  });

  it("0012 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM questions WHERE last_mutation_id IS NOT NULL").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("núcleo avançou POR CAUSA desta mutação (last_mutation_id bate) e o histórico desta mutação existe → aceito", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "mutA", "q1", "u1", 2);
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2 })).not.toThrow();
  });

  it("REPRODUÇÃO DO BUG (agora corrigida) — núcleo está na versão esperada, mas por causa de OUTRA mutação (last_mutation_id != esta): histórico desta mutação nunca existe → aceito como CONSISTENTE (ambos falsos: 'meu histórico' e 'núcleo avançou por mim'), nunca um falso aborto", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Mutação A teve sucesso genuíno: histórico A, núcleo em v2 por causa de A.
    insertHistory(db, "mutA", "q1", "u1", 2);
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    // Mutação B (identidade diferente) nunca conseguiu nada — seu histórico
    // nunca foi gravado. Seu marcador declara expectedVersion=2 (o que ELA
    // calculou), mesmo o núcleo estando em v2 por causa de A, não de B.
    expect(() => insertMutationCheck(db, { id: "mutB", questionId: "q1", expectedVersion: 2 })).not.toThrow();
  });

  it("núcleo NÃO avançou (last_mutation_id não bate com esta mutação) mas o histórico desta mutação existe → abortado (anomalia real: histórico órfão)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "mutA", "q1", "u1", 2);
    // Núcleo NUNCA avançou de fato (nem para A, nem para ninguém).
    expect(() => insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2 })).toThrow(/invariante violada/i);
  });

  it("recibo por IDENTIDADE: mutação cujo recibo (id = '<mutationId>:question_tags') existe e cujo núcleo avançou POR CAUSA DELA → aceito", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "mutA", "q1", "u1", 2); // satisfaz também o trigger de 0009
    insertReceipt(db, "mutA:question_tags", "q1", "question_tags", 2);
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).not.toThrow();
  });

  it("REPRODUÇÃO DO BUG (agora corrigida) — recibo de OUTRA mutação (A) existe, núcleo está em v2 por causa de A, mas a mutação B (identidade diferente, sem recibo próprio) NÃO é confundida: aceito como consistente", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "mutA", "q1", "u1", 2); // satisfaz também o trigger de 0009
    insertReceipt(db, "mutA:question_tags", "q1", "question_tags", 2);
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    // B nunca escreveu recibo próprio (id 'mutB:question_tags' não existe).
    expect(() => insertMutationCheck(db, { id: "mutB", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).not.toThrow();
  });

  it("recibo por identidade existe, mas o núcleo NÃO avançou por causa desta mutação → abortado", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertReceipt(db, "mutA:question_tags", "q1", "question_tags", 2);
    // Núcleo nunca avançou.
    expect(() => insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 0 })).toThrow(/invariante violada/i);
  });

  /* --------------------------------------------------------------------- */
  /* Consolidação: o trigger de CONTAGEM por coleção de 0010                */
  /* (`trg_editorial_mutation_checks_bidirectional`) foi retirado e sua     */
  /* lógica (contagem exata por `version_stamp`, para N>0) incorporada ao   */
  /* trigger consolidado, agora SEMPRE atrelada à identidade (recibo +      */
  /* `last_mutation_id`), nunca só à versão.                                */
  /* --------------------------------------------------------------------- */

  it("coleção N>0: identidade bate, recibo existe E a contagem carimbada por version_stamp bate exatamente com o esperado → aceito", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "mutA", "q1", "u1", 2);
    insertReceipt(db, "mutA:question_tags", "q1", "question_tags", 2);
    for (const letter of ["x", "y"]) {
      db.exec(
        `INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES ('t-${letter}','q1','tag-${letter}',0,2)`
      );
    }
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 2 })).not.toThrow();
  });

  it("ANOMALIA CLASSE-1 (re-verificada sob o mecanismo de identidade): identidade bate, recibo existe, mas a CONTAGEM carimbada não bate com o esperado (uma linha faltando) → abortado", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "mutA", "q1", "u1", 2);
    insertReceipt(db, "mutA:question_tags", "q1", "question_tags", 2);
    // Só 1 tag carimbada, mas a mutação declarou esperar 2.
    db.exec("INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES ('t-x','q1','tag-x',0,2)");
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2, tagsExpectedCount: 2 })).toThrow(/invariante violada/i);
  });

  it("RISCO RESIDUAL FECHADO — mutação A avança v1->v2 SEM tocar patterns; mutação B (identidade diferente, expectedVersion=1 obsoleta) declara patterns como tocada (qualquer contagem) → aceito como consistente, NUNCA um falso aborto, mesmo patterns nunca tendo sido carimbada para v2 por ninguém", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // A só tocou tags — patterns nunca recebeu nenhuma linha com version_stamp=2.
    insertHistory(db, "mutA", "q1", "u1", 2);
    insertReceipt(db, "mutA:question_tags", "q1", "question_tags", 2);
    db.exec("INSERT INTO question_tags (id, question_id, content, position, version_stamp) VALUES ('t-x','q1','tag-x',0,2)");
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");

    // B (identidade diferente) tenta declarar patterns com N>0 — sem nenhum
    // recibo próprio, e sem NADA carimbado para patterns em version_stamp=2
    // (nem por A, nem por ninguém). Antes da consolidação, o trigger de
    // 0010 (por versão) veria core@v2=true e count(patterns,2)=0 != 3 (o
    // que B declarou) → false != true → ABORTARIA um conflito legítimo.
    // Agora, como B nunca é dona de v2 (last_mutation_id='mutA', não 'mutB'),
    // o lado direito do XNOR já é falso — e o lado esquerdo (recibo
    // ausente) também é falso — consistente, sem aborto.
    expect(() =>
      insertMutationCheck(db, { id: "mutB", questionId: "q1", expectedVersion: 2, patternsExpectedCount: 3 })
    ).not.toThrow();

    // E, simetricamente, se B declarasse patterns=0 (o outro valor que
    // coincidiria por acidente com a contagem real, que é 0) — também teria
    // que ser aceito, pelo mesmo motivo (identidade, não coincidência).
    expect(() =>
      insertMutationCheck(db, { id: "mutC", questionId: "q1", expectedVersion: 2, patternsExpectedCount: 0 })
    ).not.toThrow();
  });

  it("dentro de uma transação explícita, a divergência de identidade reverte a transação INTEIRA, inclusive o UPDATE central que rodou antes no mesmo lote", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Simula A tendo sucesso ANTES, numa transação separada e já commitada.
    db.exec("BEGIN");
    insertHistory(db, "mutA", "q1", "u1", 2);
    db.exec("UPDATE questions SET version = 2, last_mutation_id = 'mutA' WHERE id = 'q1'");
    insertMutationCheck(db, { id: "mutA", questionId: "q1", expectedVersion: 2 });
    db.exec("COMMIT");
    db.exec("DELETE FROM editorial_mutation_checks WHERE id = 'mutA'"); // limpeza (simula v1.5)

    // Agora B tenta, mas seu UPDATE central foi construído com um bug que
    // muda a versão SEM setar last_mutation_id corretamente (simula uma
    // regressão futura no builder) — enquanto o histórico de B usa o guard
    // certo e insere de verdade.
    expect(() => {
      db.exec("BEGIN");
      try {
        insertHistory(db, "mutB", "q1", "u1", 3);
        // UPDATE que muda version mas "esquece" de setar last_mutation_id = 'mutB'.
        db.exec("UPDATE questions SET version = 3 WHERE id = 'q1' AND version = 2");
        insertMutationCheck(db, { id: "mutB", questionId: "q1", expectedVersion: 3 });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/invariante violada/i);

    const question = db.prepare("SELECT version, last_mutation_id FROM questions WHERE id = 'q1'").get() as {
      version: number;
      last_mutation_id: string | null;
    };
    expect(question.version).toBe(2); // reverteu para o estado de A, nunca chegou a 3
    expect(question.last_mutation_id).toBe("mutA");
    const historyB = db.prepare("SELECT COUNT(*) as total FROM question_history WHERE id = 'mutB'").get() as { total: number };
    expect(historyB.total).toBe(0);
  });
});
