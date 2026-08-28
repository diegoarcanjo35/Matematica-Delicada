/* Proteção CSRF por validação de Origin em requisições de mutação autenticadas.
   Como frontend e API são same-origin (mesmo Worker serve ambos), isso é a defesa
   principal — não dependemos de token CSRF separado nesta sprint. */

export function isMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function isOriginAllowed(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  // Sem header Origin (ex.: chamada same-origin sem CORS, alguns clientes) — aceito,
  // pois navegadores sempre enviam Origin em requisições de mutação cross-site.
  if (!origin) return true;
  return origin === url.origin;
}
