/* Cliente da API do catálogo de padrões ENEM — mesmo padrão de
   src/api/scheduleClient.ts (fetch tipado, credentials incluídas, erro
   traduzido para uma classe com code/status/fields).

   Os três endpoints são GET e somente leitura — este cliente não expõe
   nenhuma função de escrita, porque não existe nenhuma nesta sprint. */

export interface PatternIndexValue {
  available: boolean;
  value: number | null;
}

export interface PatternProgress {
  hasProgress: boolean;
  lastPracticedAt: string | null;
  nextReviewAt: string | null;
  indices: {
    recognition: PatternIndexValue;
    resolution: PatternIndexValue;
    mastery: PatternIndexValue;
  };
}

export interface PatternSummary {
  code: string;
  slug: string;
  name: string;
  recognitionPhrase: string;
  requiredContents: string[];
  tags: string[];
  isLocalFixture: boolean;
  progress: PatternProgress;
}

export interface PatternRelation {
  relationType: "related" | "prerequisite" | "often_confused_with";
  code: string;
  slug: string;
  name: string;
}

export interface PatternDetail extends PatternSummary {
  description: string;
  mainStrategy: string;
  introductoryExample: string;
  strategicSummary: string;
  frequentClues: string[];
  recurringPhrases: string[];
  recurringVisualElements: string[];
  alternativeStrategies: string[];
  prerequisiteContents: string[];
  commonMistakes: string[];
  relations: PatternRelation[];
  availableQuestionCount: number;
  /** Sprint 8 v1.1 — id da questão publicada escolhida de forma
   *  DETERMINÍSTICA (nunca um algoritmo pedagógico) para "Treinar este
   *  padrão". `null` quando nenhuma questão publicada está disponível. */
  trainableQuestionId: string | null;
}

export interface PatternListResponse {
  ok: true;
  available: boolean;
  message?: string;
  patterns?: PatternSummary[];
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  /** Sprint 8 v1.1 — existe pelo menos uma questão publicada (fixture
   *  local) para o CTA "Resolver uma questão" do dashboard. */
  hasAnyTrainableQuestion?: boolean;
}

export interface PatternDetailResponse {
  ok: true;
  available: boolean;
  message?: string;
  pattern?: PatternDetail;
}

export interface PatternProgressResponse {
  ok: true;
  available: boolean;
  message?: string;
  slug?: string;
  code?: string;
  progress?: PatternProgress;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class PatternsApiError extends Error {
  readonly fields: Record<string, string>;
  readonly status: number;
  readonly code: string;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
    this.fields = apiError.fields ?? {};
    this.status = status;
    this.code = apiError.code;
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new PatternsApiError(apiError, response.status);
  }

  return data as T;
}

export interface PatternListParams {
  busca?: string | null;
  conteudo?: string | null;
  tag?: string | null;
  evidencia?: string | null;
  ordenar?: string | null;
  pagina?: number;
  limite?: number;
}

/** Monta a query string só com os parâmetros efetivamente presentes — nunca
 *  envia chaves vazias e NUNCA envia dado pessoal do aluno. */
export function patternListQuery(params: PatternListParams): string {
  const search = new URLSearchParams();
  if (params.busca) search.set("busca", params.busca);
  if (params.conteudo) search.set("conteudo", params.conteudo);
  if (params.tag) search.set("tag", params.tag);
  if (params.evidencia && params.evidencia !== "todos") search.set("evidencia", params.evidencia);
  if (params.ordenar && params.ordenar !== "codigo") search.set("ordenar", params.ordenar);
  if (params.pagina && params.pagina > 1) search.set("pagina", String(params.pagina));
  if (params.limite) search.set("limite", String(params.limite));
  return search.toString();
}

export function fetchPatterns(params: PatternListParams = {}): Promise<PatternListResponse> {
  const query = patternListQuery(params);
  return request(query ? `/api/patterns?${query}` : "/api/patterns");
}

export function fetchPatternDetail(slug: string): Promise<PatternDetailResponse> {
  return request(`/api/patterns/${encodeURIComponent(slug)}`);
}

export function fetchPatternProgress(slug: string): Promise<PatternProgressResponse> {
  return request(`/api/patterns/${encodeURIComponent(slug)}/progress`);
}
