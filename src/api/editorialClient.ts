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
  // Sprint 18 — upload de imagem manda FormData (multipart/form-data); o
  // navegador PRECISA definir o Content-Type sozinho (inclui o boundary
  // real) — forçar "application/json" aqui quebraria o parse no servidor.
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "include",
    headers: isFormData ? init.headers : { "Content-Type": "application/json", ...(init.headers ?? {}) },
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

/* Sprint 17, seção B da ordem — leitura mínima de padrões para montar os
   chips do Banco de Questões por padrão principal. Endpoint próprio
   (/api/editorial/patterns), acessível a editor/admin — nunca depende de
   /api/admin/patterns. Catálogo dinâmico: nenhum nome de padrão é
   hardcoded aqui nem no componente que consome isto. */
export interface EditorialPatternSummary {
  id: string;
  name: string;
  editorialStatus: string;
}

export function fetchEditorialPatterns(): Promise<{ ok: true; patterns: EditorialPatternSummary[] }> {
  return request("/api/editorial/patterns");
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

/* Sprint 18, seção 8 da ordem — imagem do enunciado ou de uma alternativa
   específica (A-E). `assetRef` é só um identificador técnico interno —
   nunca digitado/editado pela Andreia; a UI usa `id` (para excluir) e monta
   a URL de exibição a partir dele (/api/question-media/:id), nunca de
   `assetRef` diretamente. */
export interface QuestionImageDto {
  id: string;
  assetRef: string;
  altText: string;
  caption: string | null;
  position: number;
  placement: "enunciado" | "alternativa";
  alternativeLetter: string | null;
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
  imagens: QuestionImageDto[];
  padroes: Array<{ patternId: string; role: string }>;
  tags: string[];
  dna: QuestionDnaDto | null;
}

export interface QuestionListParams {
  busca?: string | null;
  status?: string | null;
  origem?: string | null;
  dificuldade?: string | null;
  /** Sprint 17, seção C/D da ordem — filtro por padrão principal; ausente/null = "Todas". */
  padraoPrincipalId?: string | null;
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
  if (params.padraoPrincipalId) search.set("padraoPrincipalId", params.padraoPrincipalId);
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

/* Sprint 18, seção 3/16 da ordem — `code` deixou de ser obrigatório no
 *  cliente (o servidor gera um técnico quando ausente); os demais campos
 *  legados não expostos na UI simplificada (subconteudo/habilidade/
 *  competencia/tempoEstimadoSegundos/tipoCalculo/necessitaCalculadora/
 *  textoAtribuicao/tags/imagens) também podem ser omitidos — o servidor já
 *  aplica defaults sãos para uma questão nova (nunca inventa conteúdo
 *  pedagógico). `Partial<...>` reflete isso no tipo. */
export function createQuestion(input: Partial<QuestionFormInput>): Promise<{ ok: true; id: string }> {
  return request("/api/editorial/questions", { method: "POST", body: JSON.stringify(input) });
}

/** Sprint 7 v1.2, Correção A — `mutationId` é obrigatório: o servidor usa
 *  esse UUID (gerado pelo cliente) como única prova de retry idempotente.
 *  Nunca inferido por conteúdo — quem chama decide se reaproveita o mesmo
 *  ID (retry da mesma requisição) ou gera um novo (edição nova). */
export function updateQuestion(
  id: string,
  expectedVersion: number,
  mutationId: string,
  input: Partial<QuestionFormInput>
): Promise<{ ok: true; id: string; changed: boolean }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input, expectedVersion, mutationId }),
  });
}

/* --------------------------------- Imagens ---------------------------------
   Sprint 18, seções 11/12/14 da ordem — endpoints dedicados, FORA do PATCH
   geral da questão (nunca mais parte do payload de `updateQuestion`). A
   Andreia nunca digita asset_ref/URL/object key — só escolhe/solta/cola um
   arquivo; o servidor decide tudo o mais. */

export interface UploadQuestionImageParams {
  file: File;
  mutationId: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter?: string | null;
  altText: string;
  caption?: string | null;
}

export function uploadQuestionImage(questionId: string, params: UploadQuestionImageParams): Promise<{ ok: true; changed: boolean; image: QuestionImageDto }> {
  const form = new FormData();
  form.set("arquivo", params.file);
  form.set("mutationId", params.mutationId);
  form.set("placement", params.placement);
  if (params.alternativeLetter) form.set("alternativeLetter", params.alternativeLetter);
  form.set("altText", params.altText);
  if (params.caption) form.set("caption", params.caption);
  return request(`/api/editorial/questions/${encodeURIComponent(questionId)}/images`, { method: "POST", body: form });
}

export function deleteQuestionImage(questionId: string, imageId: string): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/editorial/questions/${encodeURIComponent(questionId)}/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
}

/** URL da mídia para <img src>, sempre pelo ID técnico (nunca pela chave de
 *  storage) — worker/src/routes/questionMedia.ts aplica a autorização
 *  correta ao servir. */
export function questionMediaUrl(imageId: string): string {
  return `/api/question-media/${encodeURIComponent(imageId)}`;
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
