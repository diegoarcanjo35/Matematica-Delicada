/* Repositório administrativo do Cronograma — Sprint 16 v1.2, seção 3 da
   ordem. Separado de scheduleRepository.ts (fluxo do aluno — atribuições,
   preview, aplicação) por desenho, mesma disciplina de isolamento leitura
   pedagógica/gestão administrativa aplicada a Diagnóstico/Padrões nesta
   mesma sprint. Toda escrita aqui SEMPRE grava `is_local_fixture = 0`
   (nunca cria fixture — seção 3 da ordem).

   schedule_activities (migration 0006) NÃO tem coluna de versão/mutação —
   ao contrário de `questions`/`patterns`, esta é uma tabela de CATÁLOGO
   pequeno (dezenas de linhas, editadas ocasionalmente por 1-2 admins),
   nunca um alvo de mutação concorrente de alto risco (mesmo raciocínio de
   proporcionalidde já documentado em adminService.ts: "esforço proporcional
   ao risco real"). Por isso o UPDATE aqui é incondicional — a idempotência
   de CREATE vem da identidade do `id` (= mutationId, mesmo padrão de
   diagnosticAdminRepository.ts); a de UPDATE vem de uma checagem de
   igualdade de conteúdo no SERVIÇO antes de escrever (nunca duas escritas
   idênticas em sequência), não de um guard de versão no SQL. */

import { listRealActivities, type ScheduleActivityRow } from "./scheduleRepository";

/** Sprint 16 v1.3 — `listRealActivities` passou a viver em
 *  scheduleRepository.ts (também usada pelo fluxo do aluno fora do dev
 *  local com fixtures — ver scheduleService.ts) e é só reexportada aqui,
 *  para não duplicar a consulta em dois arquivos. */
export { listRealActivities };

export type AdminScheduleActivityRow = ScheduleActivityRow;

export async function findRealActivity(db: D1Database, id: string): Promise<AdminScheduleActivityRow | null> {
  const row = await db
    .prepare("SELECT * FROM schedule_activities WHERE id = ? AND is_local_fixture = 0")
    .bind(id)
    .first<AdminScheduleActivityRow>();
  return row ?? null;
}

/** Usada pelo serviço para recusar a exclusão de uma atividade ainda em uso
 *  por atribuições reais de algum aluno — remover a definição deixaria
 *  atribuições órfãs apontando para um `activity_id` inexistente. */
export async function countAssignmentsForActivity(db: D1Database, activityId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as total FROM schedule_activity_assignments WHERE activity_id = ?")
    .bind(activityId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export interface ActivityFields {
  type: string;
  title: string;
  objective: string;
  estimatedMinutes: number;
  completionCriteria: string;
  explanation: string;
  completionMode: string;
  origin: string;
  resourceRef: string | null;
  dismissible: boolean;
}

export function buildInsertActivityStatement(db: D1Database, id: string, fields: ActivityFields): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO schedule_activities
         (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin, resource_ref, dismissible, is_local_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(
      id,
      fields.type,
      fields.title,
      fields.objective,
      fields.estimatedMinutes,
      fields.completionCriteria,
      fields.explanation,
      fields.completionMode,
      fields.origin,
      fields.resourceRef,
      fields.dismissible ? 1 : 0
    );
}

/** UPDATE incondicional, guardado só por `id` + `is_local_fixture = 0`
 *  (nunca edita uma fixture local através deste pipeline) — ver nota de
 *  proporcionalidade no topo do arquivo sobre por que não há guard de
 *  versão aqui. */
export function buildUpdateActivityStatement(db: D1Database, id: string, fields: ActivityFields): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE schedule_activities SET
         type = ?, title = ?, objective = ?, estimated_minutes = ?, completion_criteria = ?,
         explanation = ?, completion_mode = ?, origin = ?, resource_ref = ?, dismissible = ?, updated_at = datetime('now')
       WHERE id = ? AND is_local_fixture = 0`
    )
    .bind(
      fields.type,
      fields.title,
      fields.objective,
      fields.estimatedMinutes,
      fields.completionCriteria,
      fields.explanation,
      fields.completionMode,
      fields.origin,
      fields.resourceRef,
      fields.dismissible ? 1 : 0,
      id
    );
}

export function buildDeleteActivityStatement(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare("DELETE FROM schedule_activities WHERE id = ? AND is_local_fixture = 0").bind(id);
}
