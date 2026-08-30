import type { ScheduleActivity } from "../../api/scheduleClient";
import { addMonths, buildMonthGrid, MONTH_NAMES, WEEKDAY_HEADER_LABELS } from "./monthCalendar";

interface MonthCalendarGridProps {
  year: number;
  month: number;
  today: string;
  activitiesByDate: Map<string, ScheduleActivity[]>;
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  onNavigate: (year: number, month: number) => void;
}

/** Grade de calendário mensal real (correção v1.1, seção 4) — semana começa
 *  na segunda-feira (convenção de interface, documentada em
 *  docs/CRONOGRAMA.md e monthCalendar.ts). Compara datas sempre como string
 *  YYYY-MM-DD — nunca reconstrói `new Date(plannedDate)`, então o fuso do
 *  navegador nunca desloca a data civil planejada vinda do Worker. */
export function MonthCalendarGrid({
  year,
  month,
  today,
  activitiesByDate,
  selectedDate,
  onSelectDate,
  onNavigate,
}: MonthCalendarGridProps) {
  const cells = buildMonthGrid(year, month);

  function goToPreviousMonth() {
    const { year: prevYear, month: prevMonth } = addMonths(year, month, -1);
    onNavigate(prevYear, prevMonth);
  }
  function goToNextMonth() {
    const { year: nextYear, month: nextMonth } = addMonths(year, month, 1);
    onNavigate(nextYear, nextMonth);
  }

  return (
    <div className="schedule__calendar">
      <div className="schedule__calendar-header">
        <button type="button" className="schedule__calendar-nav" onClick={goToPreviousMonth} aria-label="Mês anterior">
          ◀ Anterior
        </button>
        <h2 className="schedule__calendar-title">
          {MONTH_NAMES[month - 1]} de {year}
        </h2>
        <button type="button" className="schedule__calendar-nav" onClick={goToNextMonth} aria-label="Mês seguinte">
          Seguinte ▶
        </button>
      </div>

      <div className="schedule__calendar-weekdays" role="row">
        {WEEKDAY_HEADER_LABELS.map((label) => (
          <span key={label} className="schedule__calendar-weekday" role="columnheader">
            {label}
          </span>
        ))}
      </div>

      <div className="schedule__calendar-grid" role="grid" aria-label={`Calendário de ${MONTH_NAMES[month - 1]} de ${year}`}>
        {cells.map((cell) => {
          const dayActivities = activitiesByDate.get(cell.date) ?? [];
          const isToday = cell.date === today;
          const isSelected = cell.date === selectedDate;
          const classes = [
            "schedule__calendar-cell",
            !cell.isCurrentMonth && "schedule__calendar-cell--outside",
            isToday && "schedule__calendar-cell--today",
            isSelected && "schedule__calendar-cell--selected",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              className={classes}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isSelected}
              onClick={() => onSelectDate(cell.date)}
            >
              <span className="schedule__calendar-day-number">{cell.day}</span>
              {!cell.isCurrentMonth && <span className="visually-hidden"> (fora do mês atual)</span>}
              {isToday && <span className="visually-hidden"> (hoje)</span>}
              {dayActivities.length > 0 && (
                <span className="schedule__calendar-day-count">
                  {dayActivities.length} {dayActivities.length === 1 ? "atividade" : "atividades"}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
