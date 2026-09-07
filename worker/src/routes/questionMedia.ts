import type { Env } from "../env";
import { isLocalEditorialFixturesAllowed } from "../env";
import { Errors } from "../lib/response";
import { readSessionToken } from "../lib/cookies";
import { checkSession } from "../services/authService";
import { resolveEditorialRole } from "../lib/rbac";
import { isValidQuestionId } from "../lib/questionsValidation";
import { findImageForDelivery } from "../services/questionMediaService";

/* Rota de leitura de mídia do Banco de Questões — Sprint 18, seção 13 da
   ordem. R2 permanece PRIVADO (bucket nunca público); toda entrega passa
   por aqui, nunca por uma URL R2 direta. A rota NUNCA aceita nem constrói a
   object key a partir de entrada do usuário — só o ID técnico da imagem
   (`imageId`), que o serviço resolve internamente para a chave real
   (findImageForDelivery -> question_images.asset_ref).

   Autorização (seção 13 da ordem; gate de fixture endurecido na Sprint 18.1,
   seção D da correção):
     - questão de FIXTURE TÉCNICA LOCAL: só servida dentro de dev local com
       ENABLE_LOCAL_EDITORIAL_FIXTURES explicitamente habilitado (mesmo gate
       fail-closed de isLocalEditorialFixturesAllowed, já usado pelo
       player/diagnóstico/cronograma) — em qualquer outro ambiente,
       inclusive produção/remoto, 404 SEMPRE, mesmo que a fixture esteja por
       erro marcada `published`. Este gate é checado ANTES do status de
       publicação abaixo.
     - questão NÃO publicada (real ou fixture já liberada pelo gate acima):
       só editor/admin (mesma checagem de resolveEditorialRole do resto do
       Banco de Questões);
     - questão publicada (real ou fixture já liberada pelo gate acima):
       qualquer aluno com sessão válida (mesmo padrão já usado por
       /api/patterns e pelo player — nenhuma checagem adicional de "este
       aluno específico pode ver esta questão específica", que não existe em
       nenhum outro endpoint de conteúdo publicado desta plataforma).
     - imagens `storage_kind = 'local'` (legadas, servidas como asset
       estático da própria SPA) NUNCA passam por aqui — 404, mesmo padrão de
       "nunca aceitar object key arbitrária": esta rota só sabe servir R2. */

const IMAGE_RE = /^\/api\/question-media\/([^/]+)$/;

export async function handleQuestionMediaRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  const match = url.pathname.match(IMAGE_RE);
  if (!match) return null;
  if (request.method !== "GET") return Errors.methodNotAllowed();

  const imageId = decodeURIComponent(match[1]);
  if (!isValidQuestionId(imageId)) return Errors.notFound(); // mesmo formato de id (UUID/mutationId) do resto do domínio.

  const token = readSessionToken(request);
  if (!token) return Errors.unauthorized();
  const session = await checkSession(env.DB, token);
  if (!session.ok || !session.user) return Errors.unauthorized();

  const info = await findImageForDelivery(env.DB, imageId);
  if (!info) return Errors.notFound();
  if (info.image.storage_kind !== "r2") return Errors.notFound();

  // Sprint 18.1, seção D da correção — MESMO princípio fail-closed do
  // conteúdo do aluno (ver worker/src/env.ts:isLocalEditorialFixturesAllowed,
  // já usado por player/dailyTraining/simulations/errorNotebook): uma
  // questão de FIXTURE TÉCNICA LOCAL só é servida quando o ambiente
  // realmente permite fixture editorial local (dev + flag exclusiva de
  // wrangler.local.jsonc + hostname local reconhecido). Fora dessas três
  // condições simultâneas — inclusive produção/remoto, mesmo que a fixture
  // esteja, por erro, marcada como `published` — a resposta é sempre 404,
  // ANTES até de olhar o status de publicação. Dentro delas, a fixture
  // segue exatamente a mesma autorização de uma questão real logo abaixo
  // (o gate de fixture nunca AFROUXA a autorização, só a FECHA fora do dev
  // local).
  if (info.isLocalFixture && !isLocalEditorialFixturesAllowed(env, url)) {
    return Errors.notFound();
  }

  if (info.questionEditorialStatus !== "published") {
    const role = await resolveEditorialRole(env.DB, session.user.id);
    if (role === null) return Errors.forbidden("Sem permissão editorial.");
  }
  // Publicada: qualquer sessão válida já verificada acima basta.

  if (!env.QUESTION_MEDIA) return Errors.internal("Armazenamento de mídia não configurado neste ambiente.");
  const object = await env.QUESTION_MEDIA.get(info.image.asset_ref);
  if (!object) return Errors.notFound(); // objeto órfão (seção 12 da ordem) — nunca vaza detalhe interno, só 404 limpo.

  const headers = new Headers();
  headers.set("Content-Type", info.image.mime_type ?? object.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Cache-Control", info.questionEditorialStatus === "published" ? "private, max-age=3600" : "private, no-store");
  return new Response(object.body, { status: 200, headers });
}
