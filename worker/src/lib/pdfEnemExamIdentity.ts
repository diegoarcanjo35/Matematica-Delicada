/* Identidade do exame — Sprint 22, seção 6 da ordem.

   Modelado em memória, nunca persistido como tabela nova (seção 43:
   "nenhuma migration") — vive dentro do payload JSON do lote
   (question_import_batches.payload), e é gravado nas questões aplicadas
   através dos campos JÁ EXISTENTES `questions.prova`/`questions.ano`
   (migration 0008 — nenhuma coluna nova precisou existir).

   A identidade é sempre CONFIRMADA/CORRIGIDA pelo editor no Passo 2 da UI
   (seção 29) — nunca só extraída silenciosamente do cabeçalho do PDF e
   aceita sem revisão. `examIdentitiesCompatible` é fail-closed: qualquer
   divergência de ano/aplicação/caderno bloqueia o apply (seção 6/12: "não
   confiar em numeração visual isolada" — a questão 136 do Caderno Azul
   NUNCA é a mesma questão/gabarito do Caderno Amarelo). */

export interface ExamIdentity {
  exam: "ENEM";
  year: number;
  application: string;
  booklet: string;
  languageVariant: string | null;
  sourceLabel: string | null;
}

export interface ExamIdentityInput {
  year: unknown;
  application: unknown;
  booklet: unknown;
  languageVariant?: unknown;
  sourceUrl?: unknown;
}

export interface ExamIdentityValidationResult {
  ok: boolean;
  identity?: ExamIdentity;
  errors?: string[];
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validação server-side dos campos que o editor confirmou no Passo 2 da
 *  UI (seção 29) — a mesma disciplina de "nunca confiar no cliente" do
 *  resto do projeto: mesmo que o frontend já valide, o backend valida de
 *  novo antes de gerar qualquer prévia. */
export function validateExamIdentityInput(input: ExamIdentityInput): ExamIdentityValidationResult {
  const errors: string[] = [];

  // Seção 43/6 da ordem — CALCULADO AQUI, dentro da função, NUNCA como
  // `const` de escopo de módulo: bug real encontrado nesta sprint durante o
  // smoke local — no runtime do Cloudflare Worker, código de escopo de
  // módulo roda uma única vez na inicialização "fria" do isolate, num
  // contexto em que o relógio de parede não é garantido (proteção contra
  // side-channel/Spectre) e `new Date()` pode devolver o epoch (1970).
  // Calculado por CHAMADA (dentro do handler de requisição), o relógio real
  // já está disponível normalmente.
  const currentYear = new Date().getUTCFullYear();
  const year = typeof input.year === "number" ? input.year : Number(input.year);
  if (!Number.isInteger(year) || year < 1998 || year > currentYear + 1) {
    errors.push("Ano do ENEM inválido.");
  }

  const application = normalizeLabel(input.application);
  if (!application) errors.push("Aplicação (ex.: \"Aplicação regular\", \"Reaplicação\", \"PPL\") é obrigatória.");

  const booklet = normalizeLabel(input.booklet);
  if (!booklet) errors.push("Caderno/cor é obrigatório.");

  const languageVariant = normalizeLabel(input.languageVariant);
  const sourceUrl = normalizeLabel(input.sourceUrl);
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) errors.push("Fonte/URL informada não é um link http(s) válido.");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    identity: {
      exam: "ENEM",
      year,
      application: application!,
      booklet: booklet!,
      languageVariant,
      sourceLabel: sourceUrl,
    },
  };
}

/** Fail-closed — qualquer divergência de ano/aplicação/caderno impede o
 *  apply (seção 6 e 12 da ordem). Comparação de texto é
 *  case-insensitive/trim (nunca sensível a "Azul" vs "azul "), mas NUNCA
 *  aproximada além disso — "Caderno Azul" e "Caderno Amarelo" nunca
 *  colidem, e um campo vazio nunca é tratado como coringa. */
export function examIdentitiesCompatible(a: ExamIdentity, b: ExamIdentity): boolean {
  const norm = (v: string) => v.trim().toLowerCase();
  return a.exam === b.exam && a.year === b.year && norm(a.application) === norm(b.application) && norm(a.booklet) === norm(b.booklet);
}

/** Descrição textual factual da identidade — usada em `questions.prova`
 *  (campo já existente, seção 16 da ordem: "origem/ano/aplicação/caderno
 *  quando confirmados"). Nunca inclui alegação de licença/autorização. */
export function describeExamIdentity(identity: ExamIdentity): string {
  const parts = [`ENEM ${identity.year}`, identity.application, identity.booklet];
  if (identity.languageVariant) parts.push(identity.languageVariant);
  return parts.filter(Boolean).join(" — ");
}
