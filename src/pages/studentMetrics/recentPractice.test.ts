import { describe, expect, it } from "vitest";
import { isRecentPractice, RECENT_PRACTICE_WINDOW_DAYS } from "./recentPractice";

/* Sprint 10 v1.1 (correção PO, seção 3 da ordem) — testes de fronteira do
   recorte de "prática recente", sempre com relógio INJETADO via o segundo
   parâmetro `now` de `isRecentPractice`, nunca dependendo de `Date.now()`
   real nem do fuso horário da máquina que roda este teste. */

const DAY_MS = 24 * 60 * 60 * 1000;

describe("isRecentPractice — recorte de prática recente (14 dias, relógio injetável)", () => {
  it("RECENT_PRACTICE_WINDOW_DAYS é 14 (constante centralizada única)", () => {
    expect(RECENT_PRACTICE_WINDOW_DAYS).toBe(14);
  });

  it("exatamente dentro da janela (13 dias atrás) é recente", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const lastPracticeAt = new Date(now.getTime() - 13 * DAY_MS).toISOString();
    expect(isRecentPractice(lastPracticeAt, now)).toBe(true);
  });

  it("exatamente na fronteira (14 dias atrás, ao segundo) ainda é recente — fronteira inclusiva", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const lastPracticeAt = new Date(now.getTime() - RECENT_PRACTICE_WINDOW_DAYS * DAY_MS).toISOString();
    expect(isRecentPractice(lastPracticeAt, now)).toBe(true);
  });

  it("imediatamente fora da janela (14 dias e 1 segundo atrás) não é recente", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const lastPracticeAt = new Date(now.getTime() - (RECENT_PRACTICE_WINDOW_DAYS * DAY_MS + 1000)).toISOString();
    expect(isRecentPractice(lastPracticeAt, now)).toBe(false);
  });

  it("resultado independe do relógio real/fuso da máquina — mesma aritmética com um 'now' arbitrário distante", () => {
    // Ano e fuso completamente fora do normal de execução do teste (2030,
    // meados de dezembro): a função só faz aritmética de milissegundos
    // entre duas instâncias de Date, nunca lê Date.now()/Intl diretamente,
    // então o resultado tem que ser idêntico ao caso "dentro da janela"
    // acima, independente de quando/onde o teste realmente roda.
    const now = new Date("2030-12-20T03:00:00.000Z");
    const withinWindow = new Date(now.getTime() - 5 * DAY_MS).toISOString();
    const outsideWindow = new Date(now.getTime() - 20 * DAY_MS).toISOString();
    expect(isRecentPractice(withinWindow, now)).toBe(true);
    expect(isRecentPractice(outsideWindow, now)).toBe(false);
  });

  it("lastPracticeAt nulo nunca é recente (nunca lança, nunca vira uma data fabricada)", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(isRecentPractice(null, now)).toBe(false);
  });

  it("data inválida nunca é recente (nunca lança)", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(isRecentPractice("data-invalida", now)).toBe(false);
  });
});
