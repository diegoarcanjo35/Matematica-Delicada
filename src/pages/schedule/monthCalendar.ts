/* Grade de calendário mensal — Sprint 5 v1.1 (correção C). Função pura,
   sem acesso a relógio/fuso real: recebe ano/mês já resolvidos (a data
   civil "hoje" continua vindo do resumo do Worker, nunca calculada aqui) e
   nunca constrói `new Date(plannedDate)` a partir das strings YYYY-MM-DD
   retornadas pela API — comparação sempre por string, para nunca deslocar a
   data civil planejada por causa do fuso do navegador.

   Convenção de interface (não pedagógica): a semana começa na SEGUNDA-FEIRA,
   consistente com a ordem seg/ter/qua/qui/sex/sab/dom já usada no
   onboarding (src/pages/onboarding/onboardingOptions.ts). */

export const WEEK_START = "monday" as const;

export const WEEKDAY_HEADER_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

export interface CalendarCell {
  date: string; // YYYY-MM-DD
  day: number;
  isCurrentMonth: boolean;
}

function formatCivilDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  // Dia 0 do próximo mês = último dia deste mês (aritmética de calendário
  // pura em UTC, sem depender do fuso do navegador).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Grade completa do mês: dias do mês corrente + preenchimento de
 *  alinhamento com dias reais do mês anterior/seguinte (nunca células
 *  vazias sem data), sempre em múltiplos de 7 células. */
export function buildMonthGrid(year: number, month: number): CalendarCell[] {
  const firstWeekdayIso = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=dom..6=sáb
  const firstWeekdayMondayIndexed = (firstWeekdayIso + 6) % 7; // 0=seg..6=dom

  const currentMonthDays = daysInMonth(year, month);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonthDays = daysInMonth(prevYear, prevMonth);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  const cells: CalendarCell[] = [];

  for (let i = firstWeekdayMondayIndexed - 1; i >= 0; i--) {
    const day = prevMonthDays - i;
    cells.push({ date: formatCivilDate(prevYear, prevMonth, day), day, isCurrentMonth: false });
  }

  for (let day = 1; day <= currentMonthDays; day++) {
    cells.push({ date: formatCivilDate(year, month, day), day, isCurrentMonth: true });
  }

  let nextDay = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ date: formatCivilDate(nextYear, nextMonth, nextDay), day: nextDay, isCurrentMonth: false });
    nextDay++;
  }

  return cells;
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroIndexed = (year * 12 + (month - 1)) + delta;
  const newYear = Math.floor(zeroIndexed / 12);
  const newMonth = (zeroIndexed % 12) + 1;
  return { year: newYear, month: newMonth };
}

export const MONTH_NAMES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];
