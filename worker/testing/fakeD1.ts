import { DatabaseSync } from "node:sqlite";

/* Sprint 2 v1.3 — seam de teste para provar atomicidade real no D1.
   Este projeto não tem miniflare/@cloudflare/vitest-pool-workers instalado,
   então não há como rodar um D1 local dentro do Vitest. Em vez de mockar
   .run()/.batch() com contagem de chamadas (o que provaria só que as
   funções foram chamadas, não que o banco fica consistente), este fake
   embute um SQLite real (node:sqlite, nativo do Node — sem dependência
   nova) e implementa db.batch() como uma transação BEGIN/COMMIT/ROLLBACK
   verdadeira, incluindo rollback completo quando qualquer statement falha —
   o mesmo comportamento documentado da API D1 real
   (https://developers.cloudflare.com/d1/worker-api/d1-database/).

   Vive inteiramente fora de worker/src/ (não é varrido por
   `tsc -p worker/tsconfig.json`, que restringe `types` a
   @cloudflare/workers-types e não conhece node:sqlite) e nunca é importado
   por código de produção — não entra no bundle do Worker. Nenhum
   comportamento de falha foi adicionado ao código de produção: a injeção de
   falha (failNextMatching) só existe aqui. */

const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  email_confirmed_at TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  user_agent TEXT
);

CREATE TABLE email_confirmation_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users (id),
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE TABLE student_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  current_grade TEXT,
  enem_year INTEGER,
  goal_type TEXT,
  goal_value INTEGER,
  current_correct_estimate INTEGER,
  available_days TEXT,
  daily_minutes INTEGER,
  difficulties TEXT,
  time_preference TEXT,
  accessibility_needs TEXT,
  diagnostic_choice TEXT,
  current_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'not_started',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface FakeD1RunResult {
  success: true;
  meta: { changes: number; last_row_id: number };
  results: [];
}

class FakeD1PreparedStatement {
  constructor(
    private readonly fakeDb: FakeD1Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this.fakeDb, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const stmt = this.fakeDb.sqlite.prepare(this.sql);
    const row = stmt.get(...(this.params as never[]));
    return (row as T | undefined) ?? null;
  }

  async run(): Promise<FakeD1RunResult> {
    this.fakeDb.maybeThrowForSql(this.sql);
    const stmt = this.fakeDb.sqlite.prepare(this.sql);
    const info = stmt.run(...(this.params as never[]));
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      results: [],
    };
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    const stmt = this.fakeDb.sqlite.prepare(this.sql);
    const rows = stmt.all(...(this.params as never[]));
    return { success: true, results: rows as T[], meta: { changes: 0 } };
  }
}

export class FakeD1Database {
  readonly sqlite: DatabaseSync;
  private failOnce: RegExp | null = null;
  // Serializa batches concorrentes na ordem de chegada — replica o
  // comportamento de single-writer do SQLite/D1 e evita que duas transações
  // "fake" se interleavem por causa dos microtasks do async/await do JS.
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(SCHEMA);
  }

  /** Injeta uma falha forçada na PRÓXIMA statement cujo SQL bater com o
   *  padrão — consumida uma única vez. Só existe neste fake de teste. */
  failNextMatching(pattern: RegExp): void {
    this.failOnce = pattern;
  }

  maybeThrowForSql(sql: string): void {
    if (this.failOnce && this.failOnce.test(sql)) {
      this.failOnce = null;
      throw new Error("forced_failure_for_test");
    }
  }

  prepare(sql: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, sql);
  }

  batch(statements: FakeD1PreparedStatement[]): Promise<FakeD1RunResult[]> {
    const run = async (): Promise<FakeD1RunResult[]> => {
      this.sqlite.exec("BEGIN");
      try {
        const results: FakeD1RunResult[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    };
    const next = this.writeLock.then(run, run);
    this.writeLock = next.catch(() => undefined);
    return next;
  }
}
