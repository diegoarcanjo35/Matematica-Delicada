/* Serviço do Painel do Professor — Sprint 14 v1.0.

   Arquitetura de consulta (ordem seção 15): rota → autorização → SERVIÇOS DE
   LEITURA JÁ EXISTENTES → projeção sanitizada para professor. Nenhuma
   fórmula pedagógica nova é calculada aqui — cada função abaixo reaproveita
   diretamente um serviço do próprio aluno já entregue nas Sprints 10-13
   (`getReportForWeek`, `listPatternMetrics`, `getCurrent`), todos já
   parametrizados por `userId` (nunca amarrados à sessão de quem chama), e
   monta uma projeção whitelisted — nunca retorna um objeto interno completo
   "escondendo" campo no frontend (ordem seção 15/18).

   Autorização (ordem seção 6) SEMPRE nesta ordem, em toda função que recebe
   um `studentId`: 1) papel `teacher` da sessão; 2) vínculo ATIVO
   teacher_student_access para exatamente este par — nunca confia em
   `teacherId`/`studentId` vindos do cliente além do necessário para
   localizar o vínculo. As rotas (worker/src/routes/teacher.ts) traduzem
   `notFound` em 404 sempre, nunca revelando se o problema foi "não é
   professor", "vínculo não existe" ou "vínculo inativo" (seção 6/17). */

import { resolveTeacherRole } from "../lib/rbac";
import {
  countActiveBondsForTeacher,
  countStudentsForTeacher,
  findActiveBond,
  listAllActiveStudentsForTeacher,
  listStudentsForTeacher,
  type ListStudentsParams,
  type TeacherStudentListRow,
} from "../repositories/teacherRepository";
import { countByErrorType, summaryForUser as errorNotebookSummaryForUser } from "../repositories/errorNotebookRepository";
import { findProfile } from "../repositories/onboardingRepository";
import { findUserById } from "../repositories/userRepository";
import { getReportForWeek, type WeeklyReportDto } from "./weeklyReviewService";
import { listPatternMetrics, type PatternMetricSummaryDTO } from "./studentMetricsService";
import { getCurrent as getCurrentTrainingList, type TrainingListDto } from "./dailyTrainingService";
import { getTimezone, systemClock, type Clock } from "./scheduleService";
import { toSqliteInstant } from "../lib/scheduleValidation";
import {
  ATTENTION_REASON_LABELS,
  deriveAttentionReasons,
  isStudentListFilter,
  isStudentListSort,
  RECENT_ACTIVITY_WINDOW_DAYS,
  type AttentionReasonCode,
  DEFAULT_STUDENT_LIST_SORT,
  STUDENT_LIST_PAGE_SIZE_DEFAULT,
} from "../lib/teacherRules";

// Teto técnico defensivo (ordem seção 16: "impedir arquitetura obviamente
// não escalável") para a consulta interna do dashboard, que não pagina —
// nenhuma carteira real de um único professor nesta sprint (uso didático)
// deveria chegar perto disto; existe só como salvaguarda, nunca como um
// limite pedagógico.
const DASHBOARD_STUDENTS_CAP = 300;

function recentCutoffIso(clock: Clock): string {
  const cutoff = new Date(clock.now().getTime() - RECENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return toSqliteInstant(cutoff);
}

/* ------------------------------------------------------------------------ */
/* Autorização                                                               */
/* ------------------------------------------------------------------------ */

export interface AuthorizationResult {
  ok: boolean;
  role: "teacher" | null;
}

/** Checagem 1 de 2 (ordem seção 6): sessão já validada pela rota + papel
 *  `teacher`. Usada pelos dois endpoints "de área" (dashboard/students), que
 *  não têm um recurso de aluno específico para 404. */
export async function requireTeacherRole(db: D1Database, userId: string): Promise<boolean> {
  const role = await resolveTeacherRole(db, userId);
  return role === "teacher";
}

/* ------------------------------------------------------------------------ */
/* Dashboard (ordem seção 11)                                                */
/* ------------------------------------------------------------------------ */

export interface AttentionItemDto {
  studentId: string;
  studentName: string;
  reasons: AttentionReasonCode[];
  reasonLabels: string[];
}

export interface TeacherDashboardDto {
  recentActivityWindowDays: number;
  linkedStudents: {
    activeCount: number;
    withRecentEvidenceCount: number;
    withoutRecentEvidenceCount: number;
  };
  attention: AttentionItemDto[];
}

export type DashboardResult = { ok: true; dashboard: TeacherDashboardDto } | { ok: false; forbidden: true };

export async function getDashboard(db: D1Database, teacherId: string, clock: Clock = systemClock): Promise<DashboardResult> {
  const isTeacher = await requireTeacherRole(db, teacherId);
  if (!isTeacher) return { ok: false, forbidden: true };

  const nowIso = toSqliteInstant(clock.now());
  const cutoffIso = recentCutoffIso(clock);

  const [totalActive, rows] = await Promise.all([
    countActiveBondsForTeacher(db, teacherId),
    listAllActiveStudentsForTeacher(db, { teacherId, recentCutoffIso: cutoffIso, nowIso, cap: DASHBOARD_STUDENTS_CAP }),
  ]);

  const withRecentEvidenceCount = rows.filter((r) => r.hasRecentActivity).length;
  const withoutRecentEvidenceCount = totalActive - withRecentEvidenceCount;

  const attention: AttentionItemDto[] = [];
  for (const row of rows) {
    const reasons = deriveAttentionReasons({
      hasRecentActivity: row.hasRecentActivity,
      overdueReviewsCount: row.overdueReviewsCount,
      hasActiveWeeklyGoal: row.hasActiveWeeklyGoal,
      errorNotebookPendingCount: row.errorNotebookPendingCount,
    });
    if (reasons.length > 0) {
      attention.push({
        studentId: row.studentId,
        studentName: row.studentName,
        reasons,
        reasonLabels: reasons.map((r) => ATTENTION_REASON_LABELS[r]),
      });
    }
  }

  return {
    ok: true,
    dashboard: {
      recentActivityWindowDays: RECENT_ACTIVITY_WINDOW_DAYS,
      linkedStudents: {
        activeCount: totalActive,
        withRecentEvidenceCount,
        withoutRecentEvidenceCount: Math.max(0, withoutRecentEvidenceCount),
      },
      attention,
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Lista de alunos (ordem seção 12)                                          */
/* ------------------------------------------------------------------------ */

export interface StudentListItemDto {
  studentId: string;
  studentName: string;
  currentGrade: string | null;
  lastActivityAt: string | null;
  hasRecentActivity: boolean;
  confirmedQuestionsRecent: number;
  daysWithActivityRecent: number;
  overdueReviewsCount: number;
  hasActiveWeeklyGoal: boolean;
}

export interface StudentListInput {
  search?: string | null;
  filter?: string | null;
  sort?: string | null;
  page?: number | null;
  pageSize?: number | null;
}

export type StudentListResult =
  | { ok: true; students: StudentListItemDto[]; total: number; page: number; pageSize: number; recentActivityWindowDays: number }
  | { ok: false; forbidden: true };

function toStudentListItemDto(row: TeacherStudentListRow): StudentListItemDto {
  return {
    studentId: row.studentId,
    studentName: row.studentName,
    currentGrade: row.currentGrade,
    lastActivityAt: row.lastActivityAt,
    hasRecentActivity: row.hasRecentActivity,
    confirmedQuestionsRecent: row.confirmedQuestionsRecent,
    daysWithActivityRecent: row.daysWithActivityRecent,
    overdueReviewsCount: row.overdueReviewsCount,
    hasActiveWeeklyGoal: row.hasActiveWeeklyGoal,
  };
}

export async function listStudents(db: D1Database, teacherId: string, input: StudentListInput, clock: Clock = systemClock): Promise<StudentListResult> {
  const isTeacher = await requireTeacherRole(db, teacherId);
  if (!isTeacher) return { ok: false, forbidden: true };

  const nowIso = toSqliteInstant(clock.now());
  const cutoffIso = recentCutoffIso(clock);

  const sort = input.sort && isStudentListSort(input.sort) ? input.sort : DEFAULT_STUDENT_LIST_SORT;
  const filter = input.filter && isStudentListFilter(input.filter) ? input.filter : null;
  const search = input.search && input.search.trim().length > 0 ? input.search.trim().slice(0, 200) : null;
  const pageSizeRaw = input.pageSize ?? STUDENT_LIST_PAGE_SIZE_DEFAULT;
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 50) : STUDENT_LIST_PAGE_SIZE_DEFAULT;
  const pageRaw = input.page ?? 1;
  // Teto defensivo (ordem seção 17: "paginação abusiva") — uma página
  // absurdamente alta vira OFFSET grande mas nunca ilimitado nem capaz de
  // estourar o tipo numérico; a consulta só retorna uma página vazia.
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 100_000) : 1;

  const params: ListStudentsParams = {
    teacherId,
    recentCutoffIso: cutoffIso,
    nowIso,
    search,
    filter,
    sort,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };

  const [rows, total] = await Promise.all([listStudentsForTeacher(db, params), countStudentsForTeacher(db, params)]);

  return {
    ok: true,
    students: rows.map(toStudentListItemDto),
    total,
    page,
    pageSize,
    recentActivityWindowDays: RECENT_ACTIVITY_WINDOW_DAYS,
  };
}

/* ------------------------------------------------------------------------ */
/* Acompanhamento individual (ordem seção 13)                                */
/* ------------------------------------------------------------------------ */

export interface StudentSummaryDto {
  studentId: string;
  studentName: string;
  currentGrade: string | null;
}

export interface ErrorNotebookMetadataDto {
  activeCount: number;
  overdueCount: number;
  correctedCount: number;
  totalCount: number;
  countsByErrorType: Record<string, number>;
}

export interface TeacherTrainingTodayDto {
  status: string;
  itemCount: number;
  completedCount: number;
  date: string;
}

export interface StudentDetailDto {
  student: StudentSummaryDto;
  weeklyReview: WeeklyReportDto;
  patterns: PatternMetricSummaryDTO[];
  errorNotebook: ErrorNotebookMetadataDto;
  trainingToday: TeacherTrainingTodayDto | null;
}

export type StudentDetailResult = { ok: true; detail: StudentDetailDto } | { ok: false; notFound: true };

/** Nenhum campo aqui pode vir de um "spread" de objeto interno — cada campo
 *  é escrito explicitamente (ordem seção 15/18: minimização acontece no
 *  Worker). Nunca inclui: e-mail, hash de senha, token, sessão, resposta
 *  livre de onboarding, anotação livre do Caderno de Erros (`student_note`),
 *  denúncia, ID interno desnecessário. Documentado por campo em
 *  docs/PAINEL_PROFESSOR.md. */
export async function getStudentDetail(db: D1Database, teacherId: string, studentId: string, clock: Clock = systemClock): Promise<StudentDetailResult> {
  const isTeacher = await requireTeacherRole(db, teacherId);
  if (!isTeacher) return { ok: false, notFound: true };

  const bond = await findActiveBond(db, teacherId, studentId);
  if (!bond) return { ok: false, notFound: true };

  const studentUser = await findUserById(db, studentId);
  if (!studentUser) return { ok: false, notFound: true };

  const nowIso = toSqliteInstant(clock.now());
  const timezone = await getTimezone(db, studentId);
  const [profile, weeklyReportResult, patterns, errorSummary, errorByType, trainingList] = await Promise.all([
    findProfile(db, studentId),
    getReportForWeek(db, studentId, undefined, clock),
    listPatternMetrics(db, studentId, clock),
    errorNotebookSummaryForUser(db, studentId, nowIso),
    countByErrorType(db, studentId),
    getCurrentTrainingList(db, studentId, clock),
  ]);

  // getReportForWeek só falha com weekStart explicitamente inválido — aqui
  // sempre chamamos com `undefined` (semana atual), então este ramo nunca é
  // alcançado na prática; existe só para nunca deixar o tipo de retorno sem
  // tratamento caso o contrato do serviço mude no futuro.
  if (!weeklyReportResult.ok) return { ok: false, notFound: true };

  void timezone; // usado só para documentar a fonte de fuso já resolvida pelo próprio relatório

  const trainingToday: TeacherTrainingTodayDto | null = toTrainingTodayDto(trainingList);

  return {
    ok: true,
    detail: {
      student: {
        studentId: studentUser.id,
        studentName: studentUser.name,
        currentGrade: profile?.current_grade ?? null,
      },
      weeklyReview: weeklyReportResult.report,
      patterns,
      errorNotebook: {
        activeCount: errorSummary.active,
        overdueCount: errorSummary.overdue,
        correctedCount: errorSummary.corrected,
        totalCount: errorSummary.total,
        countsByErrorType: errorByType,
      },
      trainingToday,
    },
  };
}

function toTrainingTodayDto(list: TrainingListDto | null): TeacherTrainingTodayDto | null {
  if (!list) return null;
  const completedCount = list.items.filter((item) => item.status === "completed").length;
  return {
    status: list.status,
    itemCount: list.itemCount,
    completedCount,
    date: list.date,
  };
}
