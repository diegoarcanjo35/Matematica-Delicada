// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

/* Sprint 7 v1.4 — prova exigida pela correção: o trigger
   `trg_editorial_mutation_checks_bidirectional` é testado contra o SQL REAL
   de migrations/0010_editorial_bidirectional_invariants.sql (nunca só a
   cópia manual em worker/testing/fakeD1.ts) — mesmo padrão de
   migration0009.test.ts. Cobre as garantias que 0009 sozinha não dava:
   (1) histórico/coleções existem/mudaram mas o núcleo NÃO mudou (UPDATE
   central afetou 0 linhas silenciosamente); (2) uma coleção foi substituída
   sem a mudança de núcleo correspondente — sem cair no falso-positivo de
   uma contagem coincidente (resolvido com `version_stamp`); (3) um reenvio
   idempotente legítimo (histórico já gravado por uma chamada ANTERIOR, com
   um id diferente) não é confundido com uma divergência real (resolvido
   checando o histórico por `question_id`+`version`, nunca por id
   específico). */

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

describe("migration 0010 (SQL real, não cópia manual)", () => {
  it("aplica as migrations 0001-0010 do zero, em ordem, sem erro", () => {
    expect(() => freshDb()).not.toThrow();
  });

  it("aplica 0010 sobre o schema real das Sprints 1-7 (0001-0009), sem alterar tabelas existentes", () => {
    const db = freshDb(MIGRATION_FILES.slice(0, 9));
    db.exec(readMigration("0010_editorial_bidirectional_invariants.sql"));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("editorial_mutation_checks");
    // 0009 permanece intocada.
    expect(tables).toContain("questions");
    expect(tables).toContain("question_history");
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(triggers).toContain("trg_editorial_mutation_checks_bidirectional");
    expect(triggers).toContain("trg_questions_require_history_after_update");
  });

  it("a TABELA e o TRIGGER novos de 0010 são idempotentes por reaplicação direta (usam IF NOT EXISTS)", () => {
    // Reaplica só a parte final do arquivo (CREATE TABLE/TRIGGER IF NOT
    // EXISTS) — a única que genuinamente suporta reaplicação, exatamente
    // como em 0007/0008/0009.
    const db = freshDb();
    const fullSql = readMigration("0010_editorial_bidirectional_invariants.sql");
    const reapplyOnlySql = fullSql.slice(fullSql.indexOf("CREATE TABLE IF NOT EXISTS editorial_mutation_checks"));
    expect(() => db.exec(reapplyOnlySql)).not.toThrow();
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).filter(
      (r) => r.name === "trg_editorial_mutation_checks_bidirectional"
    );
    expect(triggers).toHaveLength(1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).filter(
      (r) => r.name === "editorial_mutation_checks"
    );
    expect(tables).toHaveLength(1);
  });

  it("as 5 linhas ALTER TABLE de 0010 NÃO são idempotentes por reaplicação manual direta — documentado e esperado (SQLite não suporta ADD COLUMN IF NOT EXISTS nesta versão; D1/Wrangler nunca reaplicam o mesmo arquivo de migration)", () => {
    const db = freshDb();
    expect(() => db.exec(readMigration("0010_editorial_bidirectional_invariants.sql"))).toThrow(/duplicate column name/i);
  });

  it("a migration 0010 NÃO insere nenhum conteúdo", () => {
    const db = freshDb();
    const row = db.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number };
    expect(row.total).toBe(0);
  });

  it("0009 permanece EXATAMENTE como antes: seu trigger continua isolado, abortando por conta própria quando version muda sem histórico", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    expect(() => db.exec("UPDATE questions SET version = version + 1 WHERE id = 'q1'")).toThrow(/invariante violada/i);
    const row = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(row.version).toBe(1);
  });

  it("marcador com núcleo E histórico consistentes (ambos na versão esperada) é aceito", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    insertHistory(db, "h1", "q1", "u1", 2);
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2 })).not.toThrow();
  });

  it("REVERSO da falha coberta por 0009: histórico existe, mas o núcleo NÃO mudou (UPDATE central afetou 0 linhas silenciosamente, sem lançar) — marcador aborta a transação inteira", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");

    expect(() => {
      db.exec("BEGIN");
      try {
        // Histórico legítimo é inserido normalmente (não viola nada sozinho).
        insertHistory(db, "h1", "q1", "u1", 2);
        // O UPDATE central é construído com um WHERE que NUNCA bate (versão
        // errada) — afeta 0 linhas, SEM lançar exceção (exatamente o cenário
        // que o trigger de 0009 não cobre, pois só reage a uma linha que
        // realmente mudou).
        db.prepare("UPDATE questions SET editorial_status = editorial_status WHERE id = ? AND version = 999").run("q1");
        // O statement final e incondicional do lote: SEMPRE dispara seu
        // trigger, que aqui detecta a divergência (histórico existe, núcleo
        // não mudou) e aborta TUDO.
        insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2 });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/invariante violada/i);

    // Nenhum resíduo: nem histórico, nem marcador, nem versão do núcleo.
    const question = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(question.version).toBe(1);
    const history = db.prepare("SELECT COUNT(*) as total FROM question_history WHERE question_id = 'q1'").get() as { total: number };
    expect(history.total).toBe(0);
    const marker = db.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number };
    expect(marker.total).toBe(0);
  });

  it("IDEMPOTÊNCIA — reenvio legítimo cujo histórico real já foi gravado por uma chamada ANTERIOR, com um id DIFERENTE do desta tentativa, não é confundido com uma divergência: checagem é por (question_id, version), nunca por id específico", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // A PRIMEIRA chamada já teve sucesso: histórico h-original gravado,
    // núcleo já avançou para v2.
    insertHistory(db, "h-original", "q1", "u1", 2);
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");

    // Uma SEGUNDA tentativa (reenvio/retry) chega depois, com um id de
    // marcador/mutação PRÓPRIO e diferente — mas aponta para a MESMA
    // versão-alvo (2), porque é uma repetição da mesma operação original.
    // Não deve ser tratada como divergência: o histórico PARA ESTA VERSÃO
    // já existe (não importa de qual chamada), e o núcleo já está lá.
    expect(() => insertMutationCheck(db, { id: "m-retry", questionId: "q1", expectedVersion: 2 })).not.toThrow();
  });

  it("núcleo mudou e histórico existe, mas a coleção de alternativas NÃO tem a contagem esperada CARIMBADA com a versão-alvo (substituição incompleta) — marcador aborta tudo", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");

    expect(() => {
      db.exec("BEGIN");
      try {
        insertHistory(db, "h1", "q1", "u1", 2);
        // Só 1 alternativa inserida (deveria ser 5) — coleção incompleta,
        // mesmo carimbada corretamente com version_stamp = 2.
        db.exec(
          "INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, position, version_stamp) VALUES ('a1','q1','A','Alternativa A',1,0,2)"
        );
        db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
        insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, alternativesExpectedCount: 5 });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }).toThrow(/invariante violada/i);

    const question = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(question.version).toBe(1);
    const alternatives = db.prepare("SELECT COUNT(*) as total FROM question_alternatives WHERE question_id = 'q1'").get() as { total: number };
    expect(alternatives.total).toBe(0);
    const marker = db.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number };
    expect(marker.total).toBe(0);
  });

  it("núcleo mudou, histórico existe e a coleção de alternativas TEM a contagem esperada CARIMBADA com a versão-alvo (substituição completa e consistente) — aceito, nada revertido", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");

    db.exec("BEGIN");
    insertHistory(db, "h1", "q1", "u1", 2);
    for (const letter of ["A", "B", "C", "D", "E"]) {
      db.exec(
        `INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, position, version_stamp) VALUES ('a${letter}','q1','${letter}','Alternativa ${letter}',${letter === "A" ? 1 : 0},0,2)`
      );
    }
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, alternativesExpectedCount: 5 })).not.toThrow();
    db.exec("COMMIT");

    const alternatives = db.prepare("SELECT COUNT(*) as total FROM question_alternatives WHERE question_id = 'q1'").get() as { total: number };
    expect(alternatives.total).toBe(5);
  });

  it("REGRESSÃO (fuga de falso-positivo corrigida) — 5 alternativas ANTIGAS (carimbadas com a versão anterior) sobrevivem intocadas a um guard que falhou; o COUNT bruto (5) coincidiria por acaso com o esperado (5) numa checagem só-por-contagem, mas version_stamp NÃO bate (1, não 2) — corretamente reconhecido como CONSISTENTE com o núcleo também não ter mudado (ambos falsos), sem aborto — exatamente o comportamento que permite ao serviço devolver 409 graciosamente em vez de vazar uma exceção de banco não tratada; ANTES desta correção (checagem por contagem crua, sem version_stamp), este mesmíssimo cenário abortaria por engano", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // 5 alternativas já existiam ANTES desta mutação, carimbadas com a
    // versão 1 (a versão atual/pré-mutação) — nunca tocadas por este lote.
    for (const letter of ["A", "B", "C", "D", "E"]) {
      db.exec(
        `INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, position, version_stamp) VALUES ('old-${letter}','q1','${letter}','Antiga ${letter}',${letter === "A" ? 1 : 0},0,1)`
      );
    }

    // Simula uma tentativa de PATCH com expectedVersion desatualizada:
    // guard de TODOS os statements (delete/insert/core) falha
    // consistentemente — nada muda. O marcador final ainda assim roda (é
    // incondicional) e declara a expectativa que a mutação TERIA, se tivesse
    // sido bem-sucedida (versão resultante 2, 5 alternativas) — mas como
    // NADA de fato aconteceu, o trigger deve reconhecer isso como
    // consistente (núcleo não mudou E alternativas não foram substituídas
    // por esta mutação), sem abortar.
    expect(() => {
      db.exec("BEGIN");
      db.prepare(
        "DELETE FROM question_alternatives WHERE question_id = ? AND EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = 999)"
      ).run("q1", "q1");
      db.prepare("UPDATE questions SET editorial_status = editorial_status WHERE id = ? AND version = 999").run("q1");
      insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, alternativesExpectedCount: 5 });
      db.exec("COMMIT");
    }).not.toThrow();

    // As 5 alternativas ANTIGAS continuam lá, intocadas, ainda carimbadas
    // com a versão antiga (1) — nunca confundidas com um "5 esperado, 5
    // real" só por coincidência de contagem.
    const alternatives = db
      .prepare("SELECT COUNT(*) as total FROM question_alternatives WHERE question_id = 'q1' AND version_stamp = 1")
      .get() as { total: number };
    expect(alternatives.total).toBe(5);
    const question = db.prepare("SELECT version FROM questions WHERE id = 'q1'").get() as { version: number };
    expect(question.version).toBe(1);
  });

  it("contagem esperada IGUAL A ZERO (coleção enviada vazia, ex. tags: []) NÃO é checada por contagem — mesmo quando o guard falha e o núcleo não muda, uma contagem carimbada é sempre 0 (vácuo), o que coincidiria trivialmente com o esperado (0) e abortaria por engano se não fosse esta exceção deliberada", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Guard falha (versão errada) — núcleo NÃO muda, nenhuma tag é
    // tocada. O marcador ainda assim declara tagsExpectedCount = 0 (a
    // mutação PRETENDIA limpar as tags). Sem a exceção "> 0", isto
    // abortaria por engano (0 == 0 "coincide" com o esperado, mas o núcleo
    // não mudou — falso positivo). Com a exceção, a checagem de tags é
    // simplesmente pulada, e só o núcleo<->histórico (ambos consistentes:
    // núcleo não mudou, sem histórico correspondente) é avaliado.
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 999, tagsExpectedCount: 0 })).not.toThrow();
  });

  it("coleção não tocada por esta mutação (contagem null) nunca é checada, mesmo que divirja do estado real", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Nenhuma linha de DNA existe — mas como esta mutação NÃO tocou DNA
    // (dna_expected_count fica null), a checagem correspondente é ignorada.
    insertHistory(db, "h1", "q1", "u1", 2);
    db.exec("UPDATE questions SET version = 2 WHERE id = 'q1'");
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2, dnaExpectedCount: null })).not.toThrow();
  });

  it("marcador cujo núcleo está na versão esperada mas cujo histórico para essa versão nunca foi gravado é abortado", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Núcleo já está na versão 1 (estado inicial de seedQuestion) — logo
    // `EXISTS(questions WHERE version = 1)` é verdadeiro — mas nenhum
    // question_history para (q1, version=1) foi de fato gravado. Divergência.
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 1 })).toThrow(/invariante violada/i);
    const marker = db.prepare("SELECT COUNT(*) as total FROM editorial_mutation_checks").get() as { total: number };
    expect(marker.total).toBe(0);
  });

  it("marcador cujo núcleo NÃO está na versão esperada e cujo histórico para essa versão também não existe é aceito (ambos ausentes, consistente)", () => {
    const db = freshDb();
    seedUser(db, "u1");
    seedQuestion(db, "q1", "C1");
    // Núcleo está na v1, mas expectedVersion pede v2 (não bate) — falso — e
    // nenhum histórico para (q1, version=2) existe — falso. Ambos falsos
    // juntos: consistente, mesmo sem nenhuma mutação real ter ocorrido (uso
    // defensivo/didático do trigger, não um caso de produção esperado).
    expect(() => insertMutationCheck(db, { id: "m1", questionId: "q1", expectedVersion: 2 })).not.toThrow();
  });
});
