/* Helpers de resposta HTTP — contrato JSON consistente, erros sem stack trace. */

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

export const Errors = {
  badRequest: (message = "Requisição inválida.") => errorResponse(400, "bad_request", message),
  unauthorized: (message = "Sessão inválida ou expirada.") =>
    errorResponse(401, "unauthorized", message),
  forbidden: (message = "Origem não permitida.") => errorResponse(403, "forbidden", message),
  notFound: (message = "Recurso não encontrado.") => errorResponse(404, "not_found", message),
  methodNotAllowed: (message = "Método não permitido.") =>
    errorResponse(405, "method_not_allowed", message),
  conflict: (message = "Conflito de versão. Recarregue e tente novamente.") =>
    errorResponse(409, "conflict", message),
  payloadTooLarge: (message = "Corpo da requisição excede o limite permitido.") =>
    errorResponse(413, "payload_too_large", message),
  tooManyRequests: (message = "Muitas tentativas. Tente novamente em alguns minutos.") =>
    errorResponse(429, "too_many_requests", message),
  internal: (message = "Erro interno. Tente novamente.") =>
    errorResponse(500, "internal_error", message),
};

const MAX_BODY_BYTES = 16 * 1024;

/** Lê e valida JSON do corpo, com limite de tamanho. Nunca lança — retorna null em erro. */
export async function readJsonBody<T>(request: Request): Promise<T | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) return null;

  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    if (text.length === 0) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
