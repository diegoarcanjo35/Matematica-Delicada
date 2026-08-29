/* Repositório do perfil/onboarding do aluno — Sprint 3 v1.0. Um perfil por
   usuário (user_id é PRIMARY KEY). Toda escrita usa statements parametrizados;
   nomes de coluna dinâmicos só vêm do mapa fechado ONBOARDING_COLUMNS
   (nunca de entrada do usuário) — mesmo padrão de tokenRepository.TOKEN_TABLES. */

export interface StudentProfileRow {
  user_id: string;
  current_grade: string | null;
  enem_year: number | null;
  goal_type: string | null;
  goal_value: number | null;
  current_correct_estimate: number | null;
  available_days: string | null; // JSON array de Weekday
  daily_minutes: number | null;
  difficulties: string | null; // JSON array de string
  time_preference: string | null;
  accessibility_needs: string | null;
  diagnostic_choice: string | null;
  current_step: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Colunas graváveis por PATCH — mapa fechado, na ordem em que os valores são
 *  aceitos pelo serviço (nunca aceita nome de coluna vindo do corpo da
 *  requisição diretamente como identificador SQL). */
export const ONBOARDING_COLUMNS = [
  "current_grade",
  "enem_year",
  "goal_type",
  "goal_value",
  "current_correct_estimate",
  "available_days",
  "daily_minutes",
  "difficulties",
  "time_preference",
  "accessibility_needs",
  "diagnostic_choice",
  "current_step",
] as const;
export type OnboardingColumn = (typeof ONBOARDING_COLUMNS)[number];

/** Subconjunto editável depois da conclusão (Configurações) — regra explícita
 *  e centralizada, para não duplicar entre rotas (seção 6/11 da ordem). */
export const ONBOARDING_COLUMNS_EDITABLE_AFTER_COMPLETION: ReadonlySet<OnboardingColumn> = new Set([
  "daily_minutes",
  "available_days",
  "time_preference",
  "accessibility_needs",
]);

export async function findProfile(db: D1Database, userId: string): Promise<StudentProfileRow | null> {
  const row = await db
    .prepare("SELECT * FROM student_profiles WHERE user_id = ?")
    .bind(userId)
    .first<StudentProfileRow>();
  return row ?? null;
}

/** Cria o perfil (se ainda não existir) e aplica o patch — atômico no mesmo
 *  lote do D1: se a criação falhar, o patch também é revertido (Sprint 3
 *  segue o padrão de atomicidade estabelecido na Sprint 2 v1.3). Idempotente:
 *  chamadas repetidas com o mesmo patch produzem o mesmo estado final. */
export async function upsertProfilePatch(
  db: D1Database,
  userId: string,
  patch: Partial<Record<OnboardingColumn, unknown>>
): Promise<StudentProfileRow> {
  const columns = (Object.keys(patch) as OnboardingColumn[]).filter((key) =>
    (ONBOARDING_COLUMNS as readonly string[]).includes(key)
  );

  const statements = [
    db
      .prepare(
        `INSERT INTO student_profiles (user_id, status, started_at, created_at, updated_at)
         VALUES (?, 'in_progress', datetime('now'), datetime('now'), datetime('now'))
         ON CONFLICT (user_id) DO NOTHING`
      )
      .bind(userId),
  ];

  if (columns.length > 0) {
    const setClause = columns.map((column) => `${column} = ?`).join(", ");
    const values = columns.map((column) => patch[column]);
    statements.push(
      db
        .prepare(`UPDATE student_profiles SET ${setClause}, updated_at = datetime('now') WHERE user_id = ?`)
        .bind(...values, userId)
    );
  }

  await db.batch(statements);

  const row = await findProfile(db, userId);
  if (!row) throw new Error("Falha ao gravar o perfil de onboarding.");
  return row;
}

/** Conclui o onboarding de forma idempotente: se já concluído, não repete a
 *  gravação nem o timestamp de conclusão (Sprint 3, seção 6: "conclusão deve
 *  ser idempotente"). Retorna false se a linha não existia (nada foi feito). */
export async function markCompleted(db: D1Database, userId: string): Promise<{ changed: boolean }> {
  const result = await db
    .prepare(
      `UPDATE student_profiles
       SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE user_id = ? AND status != 'completed'`
    )
    .bind(userId)
    .run();
  return { changed: result.meta.changes === 1 };
}
