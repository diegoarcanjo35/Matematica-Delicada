/* Cliente da API do Player de Questão — mesmo padrão de
   src/api/scheduleClient.ts (fetch tipado, credentials incluídas, erro
   traduzido para uma classe com code/status/fields). */

export type AttemptMode = "learning" | "practice" | "recognition";

export interface AttemptQuestion {
  id: string;
  code: string;
  enunciado: string;
  dificuldade: string;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  alternativas: Array<{ letter: string; text: string }>;
  imagens: Array<{ id: string; assetRef: string; altText: string; caption: string | null; position: number }>;
  principalPatternId: string | null;
}

export interface AttemptFeedback {
  selectedAlternative: string;
  correctAlternative: string;
  isCorrect: boolean;
  correctExplanation: string | null;
  distractorExplanations: Array<{ letter: string; explanation: string }>;
  principalPattern: { id: string; name: string; slug: string } | null;
  dna: {
    pista: string;
    estrategia: string;
    pegadinha: string;
    conteudoApoio: string;
    resolucao: string;
    atalho: string | null;
    aprendizadoErro: string;
  } | null;
}

export interface AttemptState {
  id: string;
  questionId: string;
  mode: AttemptMode;
  status: "in_progress" | "completed" | "abandoned";
  selectedAlternative: string | null;
  recognitionSaved: boolean;
  recognitionPatternId: string | null;
  recognitionClue: string | null;
  recognitionStrategy: string | null;
  highestHelpLayer: number;
  openedLayers: number[];
  startedAt: string;
  answeredAt: string | null;
  completedAt: string | null;
  lastActivityAt: string;
  version: number;
  question: AttemptQuestion;
  /** Chaves numéricas viram string na serialização JSON — sempre acesse por
   *  `helpContent["1"]`/`helpContent[String(layer)]`, nunca por número
   *  literal como chave de objeto. */
  helpContent: Record<string, string>;
  feedback: AttemptFeedback | null;
  /** Sprint 8 v1.2 — correção B: recuperado do servidor a cada carregamento
   *  (refresh/remontagem), nunca mais um estado só local que zera ao
   *  recarregar a página. */
  isBookmarked: boolean;
  /** Sprint 9 v1.0 — não-nulo só em tentativas iniciadas pelo Caderno de
   *  Erros ("Corrigir meu erro"). `mode` continua `practice` tecnicamente. */
  errorEntryId: string | null;
}

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
}

export class PlayerApiError extends Error {
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
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new PlayerApiError(apiError, response.status);
  }

  return data as T;
}

export interface StartAttemptResponse {
  ok: true;
  available?: boolean;
  message?: string;
  attemptId?: string;
}

export function startAttempt(questionId: string, mode: AttemptMode): Promise<StartAttemptResponse> {
  return request("/api/player/attempts", { method: "POST", body: JSON.stringify({ questionId, mode }) });
}

export interface AttemptResponse {
  ok: true;
  available?: boolean;
  message?: string;
  attempt?: AttemptState;
}

export function fetchAttempt(attemptId: string): Promise<AttemptResponse> {
  return request(`/api/player/attempts/${encodeURIComponent(attemptId)}`);
}

export function saveRecognition(
  attemptId: string,
  version: number,
  input: { patternSlug: string; clue: string; strategy: string }
): Promise<{ ok: true }> {
  return request(`/api/player/attempts/${encodeURIComponent(attemptId)}/recognition`, {
    method: "PATCH",
    body: JSON.stringify({ version, ...input }),
  });
}

export function saveAnswer(attemptId: string, version: number, alternative: string): Promise<{ ok: true }> {
  return request(`/api/player/attempts/${encodeURIComponent(attemptId)}/answer`, {
    method: "PATCH",
    body: JSON.stringify({ version, alternative }),
  });
}

export function confirmAnswer(attemptId: string, version: number): Promise<AttemptResponse> {
  return request(`/api/player/attempts/${encodeURIComponent(attemptId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export function openHelpLayer(
  attemptId: string,
  version: number,
  layer: number,
  confirmViewResolution = false
): Promise<AttemptResponse> {
  return request(`/api/player/attempts/${encodeURIComponent(attemptId)}/help/${layer}`, {
    method: "POST",
    body: JSON.stringify({ version, confirmViewResolution }),
  });
}

export function saveBookmark(questionId: string): Promise<{ ok: true; saved: boolean }> {
  return request(`/api/player/questions/${encodeURIComponent(questionId)}/review-bookmark`, { method: "PUT" });
}

export function removeBookmark(questionId: string): Promise<{ ok: true; saved: boolean }> {
  return request(`/api/player/questions/${encodeURIComponent(questionId)}/review-bookmark`, { method: "DELETE" });
}

export type ProblemReportCategory =
  | "statement_problem"
  | "alternative_problem"
  | "answer_key_problem"
  | "image_problem"
  | "accessibility_problem"
  | "other";

export function reportProblem(
  questionId: string,
  category: ProblemReportCategory,
  comment: string | null,
  attemptId: string | null
): Promise<{ ok: true; reportId: string }> {
  return request(`/api/player/questions/${encodeURIComponent(questionId)}/problem-reports`, {
    method: "POST",
    body: JSON.stringify({ category, comment, attemptId }),
  });
}
