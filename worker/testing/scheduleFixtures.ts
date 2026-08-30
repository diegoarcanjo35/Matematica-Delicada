/* CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR.
   Espelho, em TypeScript, do conteúdo conceitual de
   scripts/fixtures/schedule-fixtures.local.sql — usado só pelos testes
   unitários (worker/testing/*.test.ts) via FakeD1Database. */

export const TEST_ACTIVITIES = [
  {
    id: "test-sched-a1",
    type: "diagnostico",
    title: "[PROVISÓRIO] Concluir diagnóstico inicial",
    objective: "Mapear seu ponto de partida.",
    estimatedMinutes: 20,
    completionCriteria: "Diagnóstico marcado como concluído.",
    explanation: "Demonstração técnica baseada somente na disponibilidade configurada.",
    completionMode: "manual",
    origin: "diagnostic",
    dismissible: 1,
  },
  {
    id: "test-sched-a2",
    type: "revisao_espacada",
    title: "[PROVISÓRIO] Revisão espaçada de teste",
    objective: "Exercitar a revisão espaçada.",
    estimatedMinutes: 15,
    completionCriteria: "Revisão marcada como concluída.",
    explanation: "Demonstração técnica baseada somente na disponibilidade configurada.",
    completionMode: "manual",
    origin: "review",
    dismissible: 1,
  },
  {
    id: "test-sched-a3",
    type: "treino_de_questoes",
    title: "[PROVISÓRIO] Treino de questões de teste",
    objective: "Exercitar o treino de questões.",
    estimatedMinutes: 30,
    completionCriteria: "Treino marcado como concluído.",
    explanation: "Demonstração técnica baseada somente na disponibilidade configurada.",
    completionMode: "manual",
    origin: "system",
    dismissible: 0,
  },
  {
    id: "test-sched-a4",
    type: "aula_video",
    title: "[PROVISÓRIO] Aula em vídeo de teste",
    objective: "Exercitar conclusão automática.",
    estimatedMinutes: 25,
    completionCriteria: "Vídeo assistido integralmente (evidência futura).",
    explanation: "Demonstração técnica baseada somente na disponibilidade configurada.",
    completionMode: "automatic",
    origin: "system",
    dismissible: 1,
  },
  {
    id: "test-sched-a5",
    type: "simulado",
    title: "[PROVISÓRIO] Simulado de teste",
    objective: "Exercitar conclusão por evidência externa.",
    estimatedMinutes: 90,
    completionCriteria: "Simulado corrigido (evidência futura).",
    explanation: "Demonstração técnica baseada somente na disponibilidade configurada.",
    completionMode: "external_evidence",
    origin: "system",
    dismissible: 1,
  },
] as const;

interface SqliteLike {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

export function seedScheduleActivities(sqlite: SqliteLike): void {
  for (const activity of TEST_ACTIVITIES) {
    sqlite
      .prepare(
        `INSERT INTO schedule_activities
           (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin, dismissible, is_local_fixture)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        activity.id,
        activity.type,
        activity.title,
        activity.objective,
        activity.estimatedMinutes,
        activity.completionCriteria,
        activity.explanation,
        activity.completionMode,
        activity.origin,
        activity.dismissible
      );
  }
}
