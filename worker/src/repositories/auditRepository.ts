export type AuditEventType =
  | "signup"
  | "login_success"
  | "login_failure"
  | "logout"
  | "email_confirmed"
  /** Sprint 16 v1.0 (A1) — falha REAL de envio (provedor retornou erro ou o
   *  fetch falhou), nunca engolida em silêncio. metadata: { kind:
   *  "email_confirmation" | "password_reset" } — nunca o e-mail do
   *  destinatário nem o corpo/token. */
  | "email_send_failed"
  | "password_reset_requested"
  | "password_reset_completed"
  | "session_revoked"
  | "onboarding_started"
  | "onboarding_progress_saved"
  | "onboarding_completed"
  | "onboarding_preferences_updated"
  | "diagnostic_started"
  | "diagnostic_progress_saved"
  | "diagnostic_help_opened"
  | "diagnostic_completed"
  | "diagnostic_restarted"
  | "schedule_plan_previewed"
  | "schedule_plan_applied"
  | "schedule_activity_started"
  | "schedule_activity_completed"
  | "schedule_activity_rescheduled"
  | "schedule_activity_dismissed"
  | "schedule_activity_blocked"
  | "schedule_conflict_detected"
  | "editorial_role_granted"
  | "editorial_question_import_previewed"
  | "editorial_question_import_applied"
  | "editorial_question_import_undone"
  | "editorial_question_updated"
  | "question_viewed"
  | "question_attempt_started"
  | "question_pattern_selected"
  | "question_help_opened"
  | "question_answer_selected"
  | "question_answer_changed"
  | "question_answer_confirmed"
  | "question_attempt_completed"
  | "question_saved_for_review"
  | "question_problem_reported"
  | "error_notebook_entry_created"
  | "error_notebook_entry_updated"
  | "error_notebook_review_started"
  | "error_notebook_review_completed"
  | "error_notebook_entry_corrected"
  | "error_notebook_entry_archived"
  | "daily_training_applied"
  | "daily_training_item_started"
  | "daily_training_item_completed"
  | "daily_training_item_skipped"
  | "daily_training_completed"
  | "daily_training_abandoned"
  | "simulation_block_applied"
  | "simulation_item_started"
  | "simulation_item_completed"
  | "simulation_item_skipped"
  | "simulation_block_completed"
  | "simulation_block_abandoned"
  | "weekly_goal_created"
  | "weekly_goal_updated"
  | "weekly_goal_completed"
  | "weekly_goal_abandoned"
  // Sprint 15 v1.0/v1.1 — Administração Essencial + Bootstrap Administrativo
  // Seguro (ordem seção 16; adendo seção L). `admin_role_assigned`/
  // `admin_role_removed` cobrem toda mutação de papel feita pela área
  // admin (inclusive as duas concessões iniciais do bootstrap — seção L:
  // "a atribuição inicial de admin também deve ficar auditável"; o evento
  // de bootstrap em si é sempre um `admin_role_assigned` PLUS um
  // `admin_bootstrap_completed` separado, nunca um substituindo o outro).
  | "admin_role_assigned"
  | "admin_role_removed"
  | "admin_teacher_student_link_created"
  | "admin_teacher_student_link_reactivated"
  | "admin_teacher_student_link_deactivated"
  | "admin_bootstrap_completed"
  // Sprint 16 v1.2 — Fechamento Funcional Final (ordem seções 2-4): os três
  // pipelines administrativos mínimos de conteúdo real (Diagnóstico,
  // Cronograma, Padrões). Nunca registram o CONTEÚDO em si (enunciado,
  // texto de opções, etc.) — só o `id` do recurso e, quando fizer
  // diferença para auditoria, o `action` (mesma disciplina de metadata
  // mínimo do resto do audit_log).
  | "admin_diagnostic_question_created"
  | "admin_diagnostic_question_deleted"
  | "admin_schedule_activity_created"
  | "admin_schedule_activity_updated"
  | "admin_schedule_activity_deleted"
  | "admin_pattern_created"
  | "admin_pattern_updated"
  | "admin_pattern_published"
  | "admin_pattern_inactivated";

/** Nunca registra senha, token bruto ou dado sensível — só metadados mínimos e justificados. */
export async function recordAuditEvent(
  db: D1Database,
  id: string,
  eventType: AuditEventType,
  userId: string | null,
  metadata?: Record<string, string | number | boolean>
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (id, user_id, event_type, metadata) VALUES (?, ?, ?, ?)")
    .bind(id, userId, eventType, metadata ? JSON.stringify(metadata) : null)
    .run();
}

/** Sprint 15 v1.0/v1.1 — versão em `db.batch()` de `recordAuditEvent`, para
 *  compor mutações atômicas (mutação real + auditoria no MESMO lote,
 *  mesmo padrão de weeklyReviewService.ts/dailyTrainingService.ts). `id`
 *  deve ser determinístico a partir do `mutationId` da requisição (nunca
 *  aleatório) — é essa identidade, e não o conteúdo do evento, que garante
 *  "retry idempotente não duplica auditoria" (audit_log.id é PRIMARY KEY:
 *  uma segunda tentativa com o MESMO id nunca chega a inserir uma segunda
 *  linha, porque o serviço detecta a mutação já aplicada ANTES de tentar o
 *  batch de novo — ver adminService.ts/adminBootstrapService.ts). */
export function buildAuditEventStatement(
  db: D1Database,
  params: { id: string; eventType: AuditEventType; userId: string | null; metadata?: Record<string, string | number | boolean> }
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (id, user_id, event_type, metadata) VALUES (?, ?, ?, ?)")
    .bind(params.id, params.userId, params.eventType, params.metadata ? JSON.stringify(params.metadata) : null);
}
