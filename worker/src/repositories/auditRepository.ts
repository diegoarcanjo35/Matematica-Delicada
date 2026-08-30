export type AuditEventType =
  | "signup"
  | "login_success"
  | "login_failure"
  | "logout"
  | "email_confirmed"
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
  | "editorial_question_updated";

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
