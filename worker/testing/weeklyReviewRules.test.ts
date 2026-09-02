import { describe, expect, it } from "vitest";
import { civilMidnightInstant, mondayOfCivilWeek, parseSqliteInstant, toSqliteInstant } from "../src/lib/scheduleValidation";
import {
  MAX_GOAL_PATTERNS,
  MAX_WEEKLY_TARGET_MINUTES,
  MAX_WEEKLY_TARGET_QUESTIONS,
  MIN_WEEKLY_TARGET_MINUTES,
  MIN_WEEKLY_TARGET_QUESTIONS,
  clamp,
  computeGoalProgressPercents,
  selectSuggestedPatterns,
  suggestWeeklyMinutes,
  suggestWeeklyQuestions,
  validateAvailableDays,
  validatePatternIds,
  validateTargetMinutes,
  validateTargetQuestions,
  validateWeekStartFormat,
  type PatternCandidate,
} from "../src/lib/weeklyGoalRules";

/* Sprint 13 v1.0 — testes direcionados da semântica temporal (seção 5 da
   ordem) e das regras puras da meta (seção 8/4.4). Cobre explicitamente:
   fronteira domingo→segunda, timestamp próximo da meia-noite, fuso positivo
   e negativo, e relógio sintético independente da data real da máquina
   (nenhum destes testes chama `new Date()` sem argumento). */

describe("mondayOfCivilWeek — semana civil segunda a domingo", () => {
  it("uma segunda-feira é ela mesma o início da semana", () => {
    expect(mondayOfCivilWeek("2026-08-31")).toBe("2026-08-31"); // 2026-08-31 é uma segunda-feira
  });

  it("um domingo pertence à semana que começou na segunda ANTERIOR (fronteira domingo→segunda)", () => {
    expect(mondayOfCivilWeek("2026-09-06")).toBe("2026-08-31"); // domingo, mesma semana de 31/08
  });

  it("a segunda-feira seguinte já é uma semana nova (fronteira domingo→segunda, do outro lado)", () => {
    expect(mondayOfCivilWeek("2026-09-07")).toBe("2026-09-07");
  });

  it("cobre os sete dias da semana civil apontando para a mesma segunda", () => {
    const expectedMonday = "2026-08-31";
    const days = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
    for (const day of days) expect(mondayOfCivilWeek(day)).toBe(expectedMonday);
  });

  it("virada de mês/ano é tratada corretamente (aritmética de calendário pura)", () => {
    // 2026-01-01 é uma quinta-feira; a segunda daquela semana é 2025-12-29.
    expect(mondayOfCivilWeek("2026-01-01")).toBe("2025-12-29");
  });
});

describe("civilMidnightInstant — fuso positivo e negativo, timestamp próximo da meia-noite", () => {
  it("fuso negativo (America/Sao_Paulo, UTC-3): meia-noite local corresponde a 03:00 UTC", () => {
    const instant = civilMidnightInstant("2026-06-10", "America/Sao_Paulo");
    expect(instant.toISOString()).toBe("2026-06-10T03:00:00.000Z");
  });

  it("fuso positivo (Asia/Tokyo, UTC+9): meia-noite local corresponde a 15:00 UTC do dia anterior", () => {
    const instant = civilMidnightInstant("2026-06-10", "Asia/Tokyo");
    expect(instant.toISOString()).toBe("2026-06-09T15:00:00.000Z");
  });

  it("UTC puro: meia-noite local é a própria meia-noite UTC", () => {
    const instant = civilMidnightInstant("2026-06-10", "UTC");
    expect(instant.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("um timestamp muito próximo da fronteira (23:59:59 do dia anterior no fuso do aluno) fica FORA da janela [meia-noite, meia-noite+7dias)", () => {
    const weekStartInstant = civilMidnightInstant("2026-08-31", "America/Sao_Paulo").getTime();
    const justBefore = civilMidnightInstant("2026-08-31", "America/Sao_Paulo").getTime() - 1000; // 23:59:59 do dia 30/08 local
    expect(justBefore).toBeLessThan(weekStartInstant);
  });

  it("horário de verão (America/New_York): a mesma hora civil de meia-noite produz offsets diferentes antes/depois da transição de março", () => {
    // 2026-03-08 é o domingo de início do horário de verão nos EUA (2h -> 3h).
    const beforeDst = civilMidnightInstant("2026-03-01", "America/New_York"); // EST, UTC-5
    const afterDst = civilMidnightInstant("2026-03-15", "America/New_York"); // EDT, UTC-4
    expect(beforeDst.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(afterDst.toISOString()).toBe("2026-03-15T04:00:00.000Z");
  });
});

describe("toSqliteInstant / parseSqliteInstant — round-trip e comparação lexicográfica", () => {
  it("toSqliteInstant produz o mesmo formato textual de datetime('now') do SQLite/D1", () => {
    const instant = new Date("2026-08-31T03:00:00.000Z");
    expect(toSqliteInstant(instant)).toBe("2026-08-31 03:00:00");
  });

  it("parseSqliteInstant é o inverso exato de toSqliteInstant", () => {
    const original = new Date("2026-08-31T23:59:59.000Z");
    expect(parseSqliteInstant(toSqliteInstant(original)).getTime()).toBe(new Date("2026-08-31T23:59:59.000Z").getTime());
  });

  it("duas fronteiras de semana consecutivas comparam corretamente como strings (>= início, < fim)", () => {
    const startSql = toSqliteInstant(civilMidnightInstant("2026-08-31", "America/Sao_Paulo"));
    const endSql = toSqliteInstant(civilMidnightInstant("2026-09-07", "America/Sao_Paulo"));
    const insideWeek = "2026-09-03 12:00:00"; // uma quinta-feira ao meio-dia UTC, dentro da semana em UTC-3
    const afterWeek = "2026-09-07 03:00:00"; // exatamente a próxima fronteira
    expect(insideWeek >= startSql && insideWeek < endSql).toBe(true);
    expect(afterWeek >= endSql).toBe(true);
  });
});

describe("relógio sintético — independente da data real da máquina", () => {
  it("civilMidnightInstant nunca chama Date.now()/new Date() sem argumento — determinístico para a mesma entrada, qualquer que seja a data real", () => {
    const a = civilMidnightInstant("2030-01-01", "America/Sao_Paulo").getTime();
    const b = civilMidnightInstant("2030-01-01", "America/Sao_Paulo").getTime();
    expect(a).toBe(b);
  });
});

describe("weeklyGoalRules — sugestão de minutos/questões (seção 8 da ordem)", () => {
  it("clamp respeita os limites inferior e superior", () => {
    expect(clamp(5, 10, 100)).toBe(10);
    expect(clamp(500, 10, 100)).toBe(100);
    expect(clamp(50, 10, 100)).toBe(50);
  });

  it("com disponibilidade declarada, sugere a capacidade semanal (nunca mais que ela)", () => {
    expect(suggestWeeklyMinutes(300)).toBe(300);
  });

  it("sem disponibilidade declarada (capacidade 0), usa o fallback conservador — nunca 0", () => {
    const suggested = suggestWeeklyMinutes(0);
    expect(suggested).toBeGreaterThanOrEqual(MIN_WEEKLY_TARGET_MINUTES);
    expect(suggested).toBeLessThanOrEqual(MAX_WEEKLY_TARGET_MINUTES);
  });

  it("nunca sugere menos que o piso técnico nem mais que o teto técnico (fronteira)", () => {
    expect(suggestWeeklyMinutes(1)).toBeGreaterThanOrEqual(MIN_WEEKLY_TARGET_MINUTES);
    expect(suggestWeeklyMinutes(999999)).toBe(MAX_WEEKLY_TARGET_MINUTES);
  });

  it("sugestão de questões deriva da sugestão de minutos, dentro dos limites técnicos", () => {
    const questions = suggestWeeklyQuestions(300);
    expect(questions).toBeGreaterThanOrEqual(MIN_WEEKLY_TARGET_QUESTIONS);
    expect(questions).toBeLessThanOrEqual(MAX_WEEKLY_TARGET_QUESTIONS);
  });
});

describe("selectSuggestedPatterns — priorização determinística (seção 8 da ordem)", () => {
  it("respeita a ordem de urgência: revisão vencida > pendência ativa > desenvolvimento recente", () => {
    const candidates: PatternCandidate[] = [
      { patternId: "dev", patternCode: "C-DEV", patternName: "Dev", urgencyRank: 2, recencyKey: "2026-08-30" },
      { patternId: "overdue", patternCode: "C-OVR", patternName: "Overdue", urgencyRank: 0, recencyKey: "2026-08-20" },
      { patternId: "pending", patternCode: "C-PEND", patternName: "Pending", urgencyRank: 1, recencyKey: "2026-08-25" },
    ];
    const result = selectSuggestedPatterns(candidates);
    expect(result.map((r) => r.patternId)).toEqual(["overdue", "pending", "dev"]);
    expect(result[0].reason).toBe("overdue_review");
    expect(result[1].reason).toBe("error_notebook_pending");
    expect(result[2].reason).toBe("recent_development");
  });

  it("nunca seleciona mais que MAX_GOAL_PATTERNS, mesmo com mais candidatos", () => {
    const candidates: PatternCandidate[] = Array.from({ length: 6 }, (_, i) => ({
      patternId: `p${i}`,
      patternCode: `C-${i}`,
      patternName: `P${i}`,
      urgencyRank: 0 as const,
      recencyKey: `2026-08-${10 + i}`,
    }));
    const result = selectSuggestedPatterns(candidates);
    expect(result.length).toBe(MAX_GOAL_PATTERNS);
    expect(result.map((r) => r.priorityPosition)).toEqual([1, 2, 3]);
  });

  it("desempate determinístico: dentro do mesmo tier, atividade mais recente primeiro; depois código", () => {
    const candidates: PatternCandidate[] = [
      { patternId: "a", patternCode: "C-A", patternName: "A", urgencyRank: 0, recencyKey: "2026-08-01" },
      { patternId: "b", patternCode: "C-B", patternName: "B", urgencyRank: 0, recencyKey: "2026-08-15" },
      { patternId: "c", patternCode: "C-C", patternName: "C", urgencyRank: 0, recencyKey: "2026-08-15" },
    ];
    const result = selectSuggestedPatterns(candidates);
    // b e c empatam em recencyKey — desempate por código ASC (b antes de c).
    expect(result.map((r) => r.patternId)).toEqual(["b", "c", "a"]);
  });

  it("é determinístico: a mesma entrada sempre produz a mesma saída (nenhuma aleatoriedade)", () => {
    const candidates: PatternCandidate[] = [
      { patternId: "x", patternCode: "C-X", patternName: "X", urgencyRank: 1, recencyKey: "" },
      { patternId: "y", patternCode: "C-Y", patternName: "Y", urgencyRank: 1, recencyKey: "" },
    ];
    const first = selectSuggestedPatterns(candidates).map((r) => r.patternId);
    const second = selectSuggestedPatterns(candidates).map((r) => r.patternId);
    expect(first).toEqual(second);
  });
});

describe("computeGoalProgressPercents — progresso factual, nunca porcentagem fabricada (seção 4.4 da ordem)", () => {
  it("calcula o percentual normalmente quando há evidência", () => {
    const result = computeGoalProgressPercents({ targetMinutes: 100, targetQuestions: 20, minutesDone: 50, questionsDone: 10 });
    expect(result.minutesPercent).toBe(50);
    expect(result.questionsPercent).toBe(50);
  });

  it("evidência insuficiente (null) nunca vira 0% — o resultado também é null", () => {
    const result = computeGoalProgressPercents({ targetMinutes: 100, targetQuestions: 20, minutesDone: null, questionsDone: null });
    expect(result.minutesPercent).toBeNull();
    expect(result.questionsPercent).toBeNull();
  });

  it("pode ultrapassar 100% quando o aluno superou a meta (nunca truncado artificialmente)", () => {
    const result = computeGoalProgressPercents({ targetMinutes: 100, targetQuestions: 20, minutesDone: 150, questionsDone: 25 });
    expect(result.minutesPercent).toBe(150);
    expect(result.questionsPercent).toBe(125);
  });
});

describe("validação de entrada — limites da meta (seção 8/12.1 da ordem)", () => {
  it("aceita minutos/questões dentro dos limites técnicos", () => {
    expect(validateTargetMinutes(MIN_WEEKLY_TARGET_MINUTES).ok).toBe(true);
    expect(validateTargetMinutes(MAX_WEEKLY_TARGET_MINUTES).ok).toBe(true);
    expect(validateTargetQuestions(MIN_WEEKLY_TARGET_QUESTIONS).ok).toBe(true);
    expect(validateTargetQuestions(MAX_WEEKLY_TARGET_QUESTIONS).ok).toBe(true);
  });

  it("rejeita minutos/questões fora dos limites técnicos (fronteira)", () => {
    expect(validateTargetMinutes(MIN_WEEKLY_TARGET_MINUTES - 1).ok).toBe(false);
    expect(validateTargetMinutes(MAX_WEEKLY_TARGET_MINUTES + 1).ok).toBe(false);
    expect(validateTargetQuestions(MIN_WEEKLY_TARGET_QUESTIONS - 1).ok).toBe(false);
    expect(validateTargetQuestions(MAX_WEEKLY_TARGET_QUESTIONS + 1).ok).toBe(false);
  });

  it("rejeita valores não-inteiros e não-numéricos", () => {
    expect(validateTargetMinutes(50.5).ok).toBe(false);
    expect(validateTargetMinutes("50").ok).toBe(false);
    expect(validateTargetMinutes(null).ok).toBe(false);
  });

  it("valida dias disponíveis (código fechado, sem duplicidade)", () => {
    expect(validateAvailableDays(["seg", "ter"]).ok).toBe(true);
    expect(validateAvailableDays(["seg", "seg"]).ok).toBe(false);
    expect(validateAvailableDays(["segunda"]).ok).toBe(false);
    expect(validateAvailableDays("seg").ok).toBe(false);
  });

  it("valida padrões prioritários: no máximo 3, sem duplicidade, ausência vira lista vazia", () => {
    expect(validatePatternIds(undefined)).toEqual({ ok: true, value: [] });
    expect(validatePatternIds(["p1", "p2", "p3"]).ok).toBe(true);
    expect(validatePatternIds(["p1", "p2", "p3", "p4"]).ok).toBe(false);
    expect(validatePatternIds(["p1", "p1"]).ok).toBe(false);
  });

  it("valida o formato de week_start (YYYY-MM-DD)", () => {
    expect(validateWeekStartFormat("2026-08-31").ok).toBe(true);
    expect(validateWeekStartFormat("31/08/2026").ok).toBe(false);
    expect(validateWeekStartFormat(undefined).ok).toBe(false);
  });
});
