/* Cookie de sessão — HttpOnly, Secure por padrão (falha fechada — ver
   env.ts:shouldOmitSecureCookie), SameSite=Lax, sem dado pessoal. */

export const SESSION_COOKIE_NAME = "md_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 dias

/** @param omitSecure só deve ser true sob condição explicitamente local (ver
 *  env.ts:shouldOmitSecureCookie) — o padrão seguro é sempre incluir Secure. */
export function buildSessionCookie(token: string, omitSecure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (!omitSecure) parts.push("Secure");
  return parts.join("; ");
}

export function buildExpiredSessionCookie(omitSecure: boolean): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (!omitSecure) parts.push("Secure");
  return parts.join("; ");
}

export function readSessionToken(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return rest.join("=");
  }
  return null;
}
