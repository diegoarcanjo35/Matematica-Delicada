/* Cliente da API de autenticação. Nunca lê nem escreve token de sessão — o cookie
   HttpOnly é gerenciado inteiramente pelo navegador (credentials: "include"). */

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  emailConfirmed: boolean;
}

export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly apiError: ApiError;
  readonly status: number;

  constructor(apiError: ApiError, status: number) {
    super(apiError.message);
    this.apiError = apiError;
    this.status = status;
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
    const apiError: ApiError = data?.error ?? { code: "unknown", message: "Erro inesperado." };
    throw new ApiRequestError(apiError, response.status);
  }

  return data as T;
}

export function fetchSession(): Promise<{ ok: true; user: PublicUser }> {
  return request("/api/auth/session");
}

export function signup(params: {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptTerms: boolean;
}): Promise<{ ok: true }> {
  return request("/api/auth/signup", { method: "POST", body: JSON.stringify(params) });
}

export function login(params: { email: string; password: string }): Promise<{ ok: true; user: PublicUser }> {
  return request("/api/auth/login", { method: "POST", body: JSON.stringify(params) });
}

export function logout(): Promise<{ ok: true }> {
  return request("/api/auth/logout", { method: "POST" });
}

export function requestEmailConfirmation(email: string): Promise<{ ok: true }> {
  return request("/api/auth/email/request-confirmation", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function confirmEmail(token: string): Promise<{ ok: true }> {
  return request("/api/auth/email/confirm", { method: "POST", body: JSON.stringify({ token }) });
}

export function requestPasswordReset(email: string): Promise<{ ok: true }> {
  return request("/api/auth/password/request-reset", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(params: {
  token: string;
  password: string;
  confirmPassword: string;
}): Promise<{ ok: true }> {
  return request("/api/auth/password/reset", { method: "POST", body: JSON.stringify(params) });
}
