/* Validação, constantes técnicas e utilitários de data/fuso do cronograma
   adaptativo — Sprint 5 v1.0. Regras de faixa técnica (nunca pedagógicas)
   vivem só aqui; rotas/serviço só chamam isto. */

export const ACTIVITY_TYPES = [
  "diagnostico",
  "reconhecimento",
  "estudo_de_padrao",
  "conteudo_de_base",
  "aula_video",
  "treino_de_questoes",
  "correcao_de_erro",
  "revisao_espacada",
  "lista_do_professor",
  "simulado",
  "live",
  "leitura_de_resumo",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const COMPLETION_MODES = ["manual", "automatic", "external_evidence"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];

export const ACTIVITY_ORIGINS = ["system", "teacher", "diagnostic", "review"] as const;
export type ActivityOrigin = (typeof ACTIVITY_ORIGINS)[number];

// Estados do Documento Mestre, seção 11.3. 'overdue' é um valor legal no
// schema (CHECK) mas nunca é escrito por nenhum caminho de código desta
// sprint — é sempre calculado na leitura (ver scheduleService.ts e
// docs/CRONOGRAMA.md, seção "Estado persistido × estado efetivo").
export const ASSIGNMENT_STATUSES = [
  "not_started",
  "in_progress",
  "completed",
  "overdue",
  "rescheduled",
  "dismissed",
  "blocked",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

// Correção v1.1, seção 3 — motivos técnicos fechados para bloqueio; nunca
// texto livre, nunca uma razão pedagógica (não há perfil de professor/admin
// nesta sprint).
export const BLOCK_REASONS = ["dependency_unavailable", "content_unavailable", "technical_unavailable"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const FINAL_STATUSES: ReadonlySet<AssignmentStatus> = new Set([
  "completed",
  "rescheduled",
  "dismissed",
  "blocked",
]);

// Horizonte técnico do planejador/reagendamento — constante técnica
// centralizada (seção 8 da ordem: "não uma regra pedagógica"). Além deste
// número de dias a partir de hoje, o planejador desiste e retorna
// no_capacity/deixa a atividade pendente, em vez de tentar indefinidamente.
export const SCHEDULE_HORIZON_DAYS = 60;

// Prazo de validade de uma prévia de plano (POST /plan/preview) — depois
// disso, /plan/apply rejeita como expirada e exige gerar uma nova prévia.
export const PLAN_PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 minutos

export const WEEKDAY_CODES = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCivilDate(value: string): boolean {
  if (!CIVIL_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Testa se `timezone` é um IANA timezone reconhecido pelo runtime — nunca
 *  aceita um valor arbitrário informado pelo navegador sem validação
 *  (seção 9 da ordem). */
export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Data civil (YYYY-MM-DD) de um instante, no fuso informado — nunca depende
 *  implicitamente do relógio/fuso da máquina do servidor (seção 9 da
 *  ordem). O locale "en-CA" formata nativamente como YYYY-MM-DD. */
export function civilDateInTimezone(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Código do dia da semana (seg..dom, mesmo vocabulário do onboarding) de
 *  uma data civil já resolvida no fuso do aluno — construída ao meio-dia UTC
 *  para nunca cruzar de dia por causa de horário de verão/deslocamento de
 *  fuso na própria conversão. */
export function weekdayCodeForCivilDate(civilDate: string): WeekdayCode {
  const [year, month, day] = civilDate.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return WEEKDAY_CODES[noonUtc.getUTCDay()];
}

/** Soma (ou subtrai) dias civis a uma data YYYY-MM-DD — aritmética de
 *  calendário pura (sem fuso), correta em virada de mês e ano bissexto. */
export function addCivilDays(civilDate: string, days: number): string {
  const [year, month, day] = civilDate.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear()}`.padStart(4, "0") +
    "-" +
    `${result.getUTCMonth() + 1}`.padStart(2, "0") +
    "-" +
    `${result.getUTCDate()}`.padStart(2, "0");
}

export function compareCivilDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Segunda-feira (semana civil, seção 5 da ordem da Sprint 13) da semana que
 *  contém `civilDate` — nunca depende de relógio real, é aritmética pura
 *  sobre uma data civil já resolvida. `WEEKDAY_CODES` é [dom, seg, ter, qua,
 *  qui, sex, sab] (índice 0..6, mesmo `getUTCDay()`); a segunda-feira é o
 *  índice 1, então `(index + 6) % 7` é sempre "quantos dias atrás foi a
 *  última segunda-feira" (domingo, índice 0, fica a 6 dias — é o ÚLTIMO dia
 *  da semana civil que começou na segunda anterior). */
export function mondayOfCivilWeek(civilDate: string): string {
  const index = WEEKDAY_CODES.indexOf(weekdayCodeForCivilDate(civilDate));
  const daysSinceMonday = (index + 6) % 7;
  return addCivilDays(civilDate, -daysSinceMonday);
}

/** Offset (em minutos) tal que `local = utc + offset` — usado só como passo
 *  intermediário de `civilMidnightInstant` abaixo. Nunca exposto como uma
 *  regra de negócio própria. */
function offsetMinutesAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(instant)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {} as Record<string, string>);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - instant.getTime()) / 60000;
}

/** Instante UTC real correspondente à MEIA-NOITE local de `civilDate` no
 *  fuso `timezone` (seção 5 da ordem: "tratar mudanças de fuso e horário de
 *  verão de forma determinística"). Duas passadas (mesma técnica padrão de
 *  bibliotecas como date-fns-tz): a primeira estima o offset tratando a data
 *  civil como se already fosse UTC; a segunda recalcula o offset NO instante
 *  já corrigido, para o caso raro de a meia-noite local cair exatamente
 *  numa transição de horário de verão. Nunca lança para datas/fusos
 *  inválidos previamente validados por `isValidCivilDate`/`isValidTimezone`
 *  — chamado só depois dessa validação, em todo o código de produção. */
export function civilMidnightInstant(civilDate: string, timezone: string): Date {
  const [year, month, day] = civilDate.split("-").map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset1 = offsetMinutesAt(new Date(naiveUtc), timezone);
  const corrected1 = naiveUtc - offset1 * 60000;
  const offset2 = offsetMinutesAt(new Date(corrected1), timezone);
  const corrected2 = offset2 === offset1 ? corrected1 : naiveUtc - offset2 * 60000;
  return new Date(corrected2);
}

/** Formata um instante no MESMO formato textual usado por
 *  `datetime('now')` do SQLite/D1 (`YYYY-MM-DD HH:MM:SS`, sem `T`, sem `Z`,
 *  sem milissegundos) — nunca `toISOString()` puro, cujo separador `T`
 *  compara lexicograficamente DEPOIS do espaço usado pelas colunas
 *  `TEXT`/`datetime('now')` do banco (`'T' > ' '` em ASCII), o que quebraria
 *  comparações `>=`/`<` de fronteira exata entre os dois formatos. */
export function toSqliteInstant(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace("T", " ");
}

/** Inverso de `toSqliteInstant` — interpreta um valor já gravado no banco
 *  (`YYYY-MM-DD HH:MM:SS`, sempre UTC por convenção de `datetime('now')`)
 *  como um instante real. Nunca `new Date(value)` direto: o formato sem `T`/
 *  `Z` é ambíguo entre motores JS (alguns tratam como hora LOCAL da
 *  máquina) — anexar `Z` explicitamente após trocar o separador remove essa
 *  ambiguidade. */
export function parseSqliteInstant(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

export interface FieldValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): FieldValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(error: string): FieldValidationResult<T> {
  return { ok: false, error };
}

export function validateVersion(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fail("Versão inválida.");
  }
  return ok(value);
}

export function validateView(value: unknown): FieldValidationResult<string> {
  const allowed = ["today", "week", "month", "pending", "reviews", "assigned", "history"];
  if (typeof value !== "string" || !allowed.includes(value)) {
    return fail("Visão inválida.");
  }
  return ok(value);
}

export function validateBlockReason(value: unknown): FieldValidationResult<BlockReason> {
  if (typeof value !== "string" || !(BLOCK_REASONS as readonly string[]).includes(value)) {
    return fail("Motivo de bloqueio inválido.");
  }
  return ok(value as BlockReason);
}

export function validateTimezoneInput(value: unknown): FieldValidationResult<string> {
  if (typeof value !== "string" || !isValidTimezone(value)) {
    return fail("Fuso horário inválido ou não suportado.");
  }
  return ok(value);
}
