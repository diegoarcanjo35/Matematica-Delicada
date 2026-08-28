import { sha256Hex } from "./crypto";

/* Rate limit local, por janela fixa de 60 segundos, persistido no D1.
   Sprint 2 v1.1, correção E — reescrito para:
   1) ser atômico (uma única instrução INSERT ... ON CONFLICT ... RETURNING,
      sem check-then-act — a corrida do desenho anterior, SELECT COUNT seguido
      de INSERT separado, permitia que duas requisições concorrentes lessem a
      mesma contagem antes de qualquer uma gravar, ultrapassando o limite);
   2) nunca persistir o identificador em texto puro — só o hash SHA-256;
   3) permitir chavear por rota/ação (`scope`) E por identificador diferente
      (IP do cliente OU e-mail normalizado do alvo), para que um ataque contra
      UMA conta específica vindo de VÁRIOS IPs também seja limitado (ver
      checkEmailRateLimit, usado em conjunto com checkRateLimit nas rotas que
      recebem um e-mail).

   LIMITAÇÃO CONHECIDA E DOCUMENTADA (docs/AUTENTICACAO.md): em ambiente local
   (wrangler dev), a Cloudflare não injeta cf-connecting-ip, então todo tráfego
   local compartilha um identificador de IP fixo. O limite por e-mail (novo
   nesta versão) não sofre dessa limitação, pois o e-mail vem do próprio
   payload da requisição. Ainda assim, este limitador local D1 é uma camada de
   defesa em profundidade — a defesa primária de produção deve ser o Rate
   Limiting nativo da Cloudflare, na borda, por IP real. Não apresentamos este
   mecanismo local como proteção de produção concluída. */

const CLEANUP_RETENTION_MINUTES = 10;

function fixedWindowStart(): string {
  const now = new Date();
  now.setUTCSeconds(0, 0); // trunca ao minuto — janela fixa, não deslizante (documentado acima)
  return now.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

async function incrementAndCheck(
  db: D1Database,
  scope: string,
  identifierHash: string,
  limit: number
): Promise<boolean> {
  const windowStart = fixedWindowStart();

  // Atômico: SQLite/D1 processa esta instrução como uma única operação —
  // não há janela entre "ler a contagem" e "gravar o incremento".
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (scope, identifier_hash, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (scope, identifier_hash, window_start)
       DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(scope, identifierHash, windowStart)
    .first<{ count: number }>();

  const count = row?.count ?? 1;

  // Limpeza oportunista de janelas antigas — evita crescimento indefinido da
  // tabela em ambiente local. Não bloqueia a resposta (fire-and-forget lógico,
  // mas aguardado aqui por simplicidade; custo desprezível com o índice).
  const cutoff = new Date(Date.now() - CLEANUP_RETENTION_MINUTES * 60_000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  await db.prepare("DELETE FROM rate_limit_counters WHERE window_start < ?").bind(cutoff).run();

  return count <= limit;
}

/** Limite por (rota/ação, identificador de rede — IP hasheado). */
export async function checkRateLimit(
  db: D1Database,
  scope: string,
  identifier: string,
  limit: number
): Promise<boolean> {
  const identifierHash = await sha256Hex(identifier);
  return incrementAndCheck(db, scope, identifierHash, limit);
}

/** Limite por (rota/ação, conta-alvo — e-mail normalizado e hasheado).
 *  Protege uma conta específica contra ataques distribuídos por vários IPs. */
export async function checkEmailRateLimit(
  db: D1Database,
  scope: string,
  normalizedEmail: string,
  limit: number
): Promise<boolean> {
  const identifierHash = await sha256Hex(normalizedEmail);
  return incrementAndCheck(db, `${scope}:email`, identifierHash, limit);
}

export function clientIdentifier(request: Request): string {
  // cf-connecting-ip é o cabeçalho real da Cloudflare; em wrangler dev local, cai no fallback.
  return request.headers.get("cf-connecting-ip") ?? "local-dev";
}
