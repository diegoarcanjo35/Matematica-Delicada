import { describe, expect, it } from "vitest";
import { addMonths, buildMonthGrid } from "./monthCalendar";

describe("cronograma — grade de calendário mensal (correção v1.1)", () => {
  it("fevereiro comum (2026, 28 dias) — grade múltipla de 7, todos os dias presentes", () => {
    const grid = buildMonthGrid(2026, 2);
    expect(grid.length % 7).toBe(0);
    const currentMonthDates = grid.filter((cell) => cell.isCurrentMonth).map((cell) => cell.date);
    expect(currentMonthDates).toHaveLength(28);
    expect(currentMonthDates[0]).toBe("2026-02-01");
    expect(currentMonthDates[27]).toBe("2026-02-28");
  });

  it("fevereiro bissexto (2028, 29 dias)", () => {
    const grid = buildMonthGrid(2028, 2);
    const currentMonthDates = grid.filter((cell) => cell.isCurrentMonth).map((cell) => cell.date);
    expect(currentMonthDates).toHaveLength(29);
    expect(currentMonthDates[28]).toBe("2028-02-29");
  });

  it("mês começando numa segunda-feira não precisa de preenchimento à esquerda", () => {
    // 2026-06-01 é uma segunda-feira.
    const grid = buildMonthGrid(2026, 6);
    expect(grid[0]).toEqual({ date: "2026-06-01", day: 1, isCurrentMonth: true });
  });

  it("mês começando num domingo tem 6 células de preenchimento à esquerda (semana começa na segunda)", () => {
    // 2026-11-01 é um domingo.
    const grid = buildMonthGrid(2026, 11);
    const leading = grid.filter((cell) => !cell.isCurrentMonth && cell.date < "2026-11-01");
    expect(leading).toHaveLength(6);
    expect(grid[6]).toEqual({ date: "2026-11-01", day: 1, isCurrentMonth: true });
  });

  it("preenchimento à esquerda/direita usa dias reais do mês anterior/seguinte, nunca células vazias", () => {
    const grid = buildMonthGrid(2026, 11); // novembro/2026 começa num domingo
    const leading = grid.filter((cell) => !cell.isCurrentMonth && cell.date < "2026-11-01");
    expect(leading.every((cell) => cell.date.startsWith("2026-10"))).toBe(true);
    expect(leading.every((cell) => cell.day > 0)).toBe(true);
  });

  it("navegação dezembro → janeiro avança o ano corretamente", () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("navegação janeiro → dezembro (mês anterior) retrocede o ano corretamente", () => {
    expect(addMonths(2027, 1, -1)).toEqual({ year: 2026, month: 12 });
  });

  it("grade da virada dezembro/janeiro contém dias reais de ambos os meses no preenchimento", () => {
    const decemberGrid = buildMonthGrid(2026, 12);
    const trailing = decemberGrid.filter((cell) => !cell.isCurrentMonth && cell.date > "2026-12-31");
    if (trailing.length > 0) {
      expect(trailing.every((cell) => cell.date.startsWith("2027-01"))).toBe(true);
    }
  });

  it("datas da grade nunca são recalculadas a partir de fuso — comparação sempre por string YYYY-MM-DD", () => {
    const grid = buildMonthGrid(2026, 3);
    for (const cell of grid) {
      expect(cell.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
