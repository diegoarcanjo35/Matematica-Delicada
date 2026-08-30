/* Cliente da API editorial do Banco de Questões — Sprint 7 v1.0. Mesmo
   padrão de src/api/patternsClient.ts/scheduleClient.ts (fetch tipado,
   credentials incluídas, erro traduzido para uma classe com code/status/
   fields). */

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class EditorialApiError extends Error {
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new EditorialApiError(apiError, response.status);
  }
  return data as T;
}

export type EditorialRole = "editor" | "admin" | null;

export function fetchEditorialRole(): Promise<{ ok: true; role: EditorialRole }> {
  return request("/api/editorial/me");
}

export interface AlternativeDto {
  letter: string;
  text: string;
  isCorrect: boolean;
  distractorExplanation: string | null;
}

export interface QuestionDnaDto {
  pista: string;
  estrategia: string;
  pegadinha: string;
  conteudoApoio: string;
  resolucao: string;
  atalho: string | null;
  aprendizadoErro: string;
}

export interface QuestionSummary {
  id: string;
  code: string;
  enunciado: string;
  dificuldade: string;
  origem: string;
  editorialStatus: string;
  autorId: string | null;
  revisorId: string | null;
  ano: number | null;
  hasImage: boolean;
  version: number;
  isLocalFixture: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionDetail extends QuestionSummary {
  resolucaoComentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  prova: string | null;
  tempoEstimadoSegundos: number | null;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  titularDireitos: string | null;
  baseLicenca: string | null;
  textoAtribuicao: string | null;
  fingerprint: string;
  alternativas: AlternativeDto[];
  imagens: Array<{ id: string; assetRef: string; altText: string; caption: string | null; position: number }>;
  padroes: Array<{ patternId: string; role: string }>;
  tags: string[];
  dna: QuestionDnaDto | null;
}

export interface QuestionListParams {
  busca?: string | null;
  status?: string | null;
  origem?: string | null;
  dificuldade?: string | null;
  pagina?: number;
  limite?: number;
}

export interface QuestionListResponse {
  ok: true;
  questions: QuestionSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function toQuery(params: QuestionListParams): string {
  const search = new URLSearchParams();
  if (params.busca) search.set("busca", params.busca);
  if (params.status) search.set("status", params.status);
  if (params.origem) search.set("origem", params.origem);
  if (params.dificuldade) search.set("dificuldade", params.dificuldade);
  if (params.pagina && params.pagina > 1) search.set("pagina", String(params.pagina));
  if (params.limite) search.set("limite", String(params.limite));
  return search.toString();
}

export function fetchQuestions(params: QuestionListParams = {}): Promise<QuestionListResponse> {
  const query = toQuery(params);
  return request(query ? `/api/editorial/questions?${query}` : "/api/editorial/questions");
}

export function fetchQuestionDetail(id: string): Promise<{ ok: true; question: QuestionDetail }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}`);
}

export interface QuestionFormInput {
  code: string;
  enunciado: string;
  resolucaoComentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  dificuldade: string;
  origem: string;
  prova: string | null;
  ano: number | null;
  tempoEstimadoSegundos: number | null;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  titularDireitos: string | null;
  baseLicenca: string | null;
  textoAtribuicao: string | null;
  alternativas: AlternativeDto[];
  dna: QuestionDnaDto;
  padroes: Array<{ patternId: string; role: string }>;
  tags: string[];
  imagens: Array<{ assetRef: string; altText: string; caption: string | null; position: number }>;
}

export function createQuestion(input: QuestionFormInput): Promise<{ ok: true; id: string }> {
  return request("/api/editorial/questions", { method: "POST", body: JSON.stringify(input) });
}

export function updateQuestion(id: string, expectedVersion: number, input: Partial<QuestionFormInput>): Promise<{ ok: true; id: string }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input, expectedVersion }),
  });
}

export type WorkflowAction = "submit-review" | "request-changes" | "approve" | "publish" | "archive";

export function runWorkflowAction(
  id: string,
  action: WorkflowAction,
  expectedVersion: number,
  reason?: string
): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion, ...(reason ? { reason } : {}) }),
  });
}

/* --------------------------------- Importação -------------------------------- */

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
  value?: string;
}

export interface PreviewImportResponse {
  ok: true;
  batchId: string;
  rowCount: number;
  validRowCount: number;
  errorCount: number;
  errors: ImportRowError[];
  /** CSV do relatório de erros, já com neutralização de fórmula aplicada
   *  (Correção B) — `null` quando não há erro. Mostrado só como DADO
   *  (texto puro) na UI; nunca inserido como HTML. */
  errorsReportCsv: string | null;
  expiresAt: string;
  canApply: boolean;
}

export async function previewImportFile(file: File): Promise<PreviewImportResponse> {
  const buffer = await file.arrayBuffer();
  return request("/api/editorial/question-imports/preview", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: buffer,
  });
}

export function applyImportBatch(batchId: string): Promise<{ ok: true; appliedCount: number; alreadyApplied: boolean; questionIds: string[] }> {
  return request("/api/editorial/question-imports/apply", { method: "POST", body: JSON.stringify({ batchId }) });
}

export function undoImportBatch(batchId: string): Promise<{ ok: true; undoneCount: number; alreadyUndone: boolean }> {
  return request(`/api/editorial/question-imports/${encodeURIComponent(batchId)}/undo`, { method: "POST" });
}

export function fetchImportBatch(batchId: string): Promise<{ ok: true; batch: Record<string, unknown> }> {
  return request(`/api/editorial/question-imports/${encodeURIComponent(batchId)}`);
}

export function templateDownloadUrl(): string {
  return "/api/editorial/question-imports/template";
}
