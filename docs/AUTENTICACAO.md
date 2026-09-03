# Autenticação, Sessões e Segurança — Sprint 2 v1.4

Atualizado na v1.4 com um hotfix de restrição real de plataforma: o cadastro
em produção falhava sempre com "Erro interno" porque o runtime real do
Cloudflare Workers rejeita PBKDF2 acima de 100.000 iterações — a v1.1 havia
subido o fator para 600.000 seguindo a OWASP, mas isso nunca chegou a
funcionar em produção; só passava no ambiente local de teste anterior, que
não reproduzia esse teto do runtime real. `PBKDF2_ITERATIONS` voltou a
100.000, e `verifyPassword` agora rejeita de forma controlada (nunca lançando
exceção) qualquer hash com `iterations` inválido ou acima do limite suportado
pela plataforma. Ver seção "Segurança de senha" abaixo.

Atualizado na v1.1 com as seis correções da primeira auditoria: configuração D1
sem ID remoto falso, PBKDF2 a 600.000 iterações com upgrade automático,
ambiente/outbox com falha fechada, cookie Secure por padrão, rate limit
atômico e por conta, e a fronteira explícita entre proteção da SPA e proteção
real da API.

Atualizado na v1.2 com a correção cirúrgica: `ENVIRONMENT=development`/`test`
**sozinho não basta mais** para habilitar nada sensível. Outbox dev e cookie
sem `Secure` agora exigem, além do ambiente, uma **flag local explícita**
(exclusiva de `wrangler.local.jsonc`) **e** o **hostname da URL efetivamente
recebida** ser reconhecidamente local — nunca `X-Forwarded-Host`, nunca
`*.workers.dev`, nunca domínio customizado. Ver seção "Ambiente e cookie —
prova de execução local (v1.2)" abaixo.

Atualizado na v1.3 com a correção cirúrgica de atomicidade apontada pela
leitura direta do código publicado: emissão de token, confirmação de e-mail e
redefinição de senha agora são operações indivisíveis no D1 (`db.batch()`),
com consumo condicional do token (elimina a corrida entre "checar" e "marcar
usado") e validação real do resultado de cada mutação — nunca `{ ok: true }`
só porque nada lançou exceção. Ver seção "Atomicidade das operações de token
(v1.3)" abaixo.

## Arquitetura

```
Navegador (React)
   │  fetch, credentials: "include"
   ▼
Cloudflare Worker (worker/src/index.ts)
   ├── /api/*  → routes/auth.ts, routes/dev.ts
   │              │
   │              ├── services/authService.ts   (regras de negócio)
   │              ├── repositories/*.ts          (acesso a dados, só SQL parametrizado)
   │              ├── lib/crypto.ts              (hash de senha, tokens, SHA-256)
   │              ├── lib/cookies.ts             (cookie de sessão)
   │              ├── lib/rateLimit.ts           (limite local atômico por D1)
   │              ├── lib/origin.ts              (proteção CSRF por Origin)
   │              └── email/*.ts                 (adaptador de e-mail)
   │
   └── qualquer outra rota → env.ASSETS.fetch() (SPA estática, fallback de rota)
```

Componentes React **nunca** consultam o D1 diretamente — só o `authClient.ts`
(`src/api/authClient.ts`) fala com a API, sempre via `fetch` same-origin.

## Fronteira de proteção — SPA vs. API (correção F)

**Declaração precisa, para não repetir a imprecisão da v1.0:** a Sprint 2 v1.0
descreveu a proteção de rotas como algo que acontecia "no servidor" de forma
genérica. Isso é impreciso e foi corrigido aqui:

- `src/auth/ProtectedRoute.tsx` (React) **não é uma barreira de segurança**.
  Ele só decide o que renderizar e para onde navegar no navegador — é UX, não
  autorização. Qualquer pessoa pode desabilitar JavaScript, editar o bundle
  local ou chamar a API diretamente, ignorando completamente essa camada.
- A **única** barreira real é a validação de sessão dentro do Worker, em cada
  endpoint que serve dado privado: hoje, isso é `GET /api/auth/session`
  (`worker/src/routes/auth.ts` → `checkSession`), que responde `401` sem
  cookie, com cookie inválido, com sessão expirada ou revogada — e `200`
  apenas com sessão válida. Isso é comprovado por teste de integração que
  bate direto na API, sem passar por nenhuma tela React
  (`e2e/api-security.spec.ts`, describe "Proteção real da API privada").
- Hoje só existe essa uma rota privada de dados (o dashboard ainda usa mocks
  locais no frontend, fora de escopo desta sprint). **Toda rota privada
  futura precisa repetir esse mesmo padrão** — validar sessão dentro do
  Worker — e não pode presumir que "a página é protegida no React" seja
  suficiente.

### Fluxo de uma requisição autenticada (`GET /api/auth/session`)

1. Navegador envia o cookie `md_session` (HttpOnly) automaticamente.
2. `readSessionToken` extrai o token do header `Cookie`.
3. `checkSession` calcula `sha256Hex(token)` e busca em `sessions` por `token_hash`
   — o token bruto nunca é comparado nem armazenado.
4. Confirma que a sessão não expirou, não foi revogada, e que
   `session.session_version === user.session_version` (invalidação por troca de senha).
5. Atualiza `last_used_at` e retorna os dados públicos do usuário.

## Modelo de dados (D1)

`migrations/0001_init.sql` (schema inicial) + `migrations/0002_rate_limit_counters.sql`
(correção E — substitui `rate_limit_events` por um contador atômico):

| Tabela | Campos-chave | Índices/restrições |
|---|---|---|
| `users` | `id`, `email_normalized`, `password_hash`, `session_version` | único em `email_normalized` |
| `sessions` | `id`, `user_id`, `token_hash`, `session_version`, `expires_at`, `revoked_at` | único em `token_hash`; índice em `user_id` |
| `email_confirmation_tokens` | `user_id`, `token_hash`, `expires_at`, `used_at` | único em `token_hash` |
| `password_reset_tokens` | `user_id`, `token_hash`, `expires_at`, `used_at` | único em `token_hash` |
| `audit_log` | `user_id`, `event_type`, `metadata` | índices em `user_id` e `event_type` |
| `rate_limit_counters` | `scope`, `identifier_hash`, `window_start`, `count` | chave primária composta (upsert atômico) |
| `dev_email_outbox` | `to_email`, `subject`, `body`, `kind` | uso exclusivo local/dev — ver "Ambiente" abaixo |

Comandos locais (sempre com `-c wrangler.local.jsonc` — ver "Configuração D1" abaixo):

```bash
npm run db:migrate:local
npx wrangler d1 execute matematica-delicada-local --local -c wrangler.local.jsonc --command "SELECT ..."
```

**Nenhum D1 remoto foi criado ou consultado nesta sprint.**

## Configuração D1 — local vs. implantável (correção A)

Dois arquivos, com responsabilidades deliberadamente separadas:

| Arquivo | Uso | `database_id` |
|---|---|---|
| `wrangler.jsonc` | O que `wrangler deploy` usaria | `""` — **vazio de propósito**, nunca um valor inventado |
| `wrangler.local.jsonc` | Só para `wrangler dev`/`wrangler d1 ... --local` | string claramente local (`"local-only-sqlite-not-a-cloudflare-id"`), nunca confundível com um ID real da Cloudflare (que tem formato UUID) |

Todos os scripts locais (`npm run worker:dev`, `worker:preview`,
`db:migrate:local`) usam `-c wrangler.local.jsonc` explicitamente — o
`wrangler.jsonc` "de produção" nunca é tocado no fluxo local.

**O comando de deploy fica bloqueado por construção**: `package.json` define
`"predeploy": "npm run check:deploy-config"` — mecanismo nativo do npm, que
roda automaticamente antes de qualquer `npm run deploy`. O script
`scripts/check-deployable-d1-config.mjs` lê `wrangler.jsonc` e falha
(`exit 1`) se:

- `database_id` estiver vazio, for só zeros, ou contiver `TODO`/`PLACEHOLDER`/`changeme`/`fixme`;
- **(v1.2)** `vars` contiver `DEV_OUTBOX_ENABLED` ou `ALLOW_INSECURE_LOCAL_COOKIE`
  — essas flags são exclusivas de `wrangler.local.jsonc` e nunca podem chegar
  a uma configuração implantável, mesmo com um `database_id` real.

A função `checkDeployableConfig(configPath)` é exportada e testada isoladamente
em `scripts/check-deployable-d1-config.test.ts`, com 6 cenários usando arquivos
de fixture temporários (nunca configuração real): `database_id` vazio, ID
válido sem flags, ID válido com `DEV_OUTBOX_ENABLED`, ID válido com
`ALLOW_INSECURE_LOCAL_COOKIE`, ID só com zeros, ID com texto placeholder.

Só depois que Diego criar o D1 remoto manualmente e preencher o `database_id`
real (após autorização do PO) — **e** garantir que nenhuma flag de
desenvolvimento tenha vazado para `wrangler.jsonc` — é que `npm run deploy`
deixa de ser bloqueado por essa verificação.

## Ambiente e cookie — prova de execução local (v1.2)

**Por que mudou de novo:** a v1.1 já era falha-fechada (`ENVIRONMENT` precisava
ser exatamente `"development"`/`"test"`), mas a auditoria apontou que isso
sozinho ainda não é *prova de execução local* — se `ENVIRONMENT=development`
fosse aplicado por engano a um Worker remoto (erro humano de configuração),
outbox e cookie inseguro seriam habilitados em produção. A v1.2 exige duas
provas adicionais, independentes do valor de `ENVIRONMENT`.

`worker/src/lib/localHost.ts` — reconhece "local" só pela **URL efetivamente
recebida pelo Worker** (`request.url` já resolvido pelo runtime), nunca por um
header que o cliente controla:

```ts
const RECOGNIZED_LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export function isRecognizedLocalHostname(url: URL): boolean {
  return RECOGNIZED_LOCAL_HOSTNAMES.has(url.hostname);
}
```

`X-Forwarded-Host: localhost` **não** é consultado em nenhum momento — só
`url.hostname`. Testado explicitamente (`worker/src/env.test.ts`, "X-Forwarded-Host
alegando localhost NÃO transforma uma URL remota em local").

### Outbox dev / `GET /api/dev/outbox/last` — três condições, todas obrigatórias

`worker/src/env.ts:isDevOutboxAllowed(env, url)`:

1. `ENVIRONMENT` é exatamente `"development"` ou `"test"`;
2. `DEV_OUTBOX_ENABLED === "true"` — flag exclusiva de `wrangler.local.jsonc`;
3. `isRecognizedLocalHostname(url)` — hostname da URL recebida é local.

| `ENVIRONMENT` | `DEV_OUTBOX_ENABLED` | Host | Habilitado? |
|---|---|---|---|
| `development` | `true` | `localhost` | ✅ |
| `test` | `true` | `127.0.0.1` | ✅ |
| `development` | ausente/`false` | `localhost` | ❌ 404 |
| `test` | ausente/`false` | `localhost` | ❌ 404 |
| `production` | `true` | `localhost` | ❌ 404 |
| ausente | `true` | `localhost` | ❌ 404 |
| `development` | `true` | `matematica-delicada.proffandreia5.workers.dev` | ❌ 404 |
| `development` | `true` | domínio arbitrário | ❌ 404 |

`GET /api/dev/outbox/last` responde `404` (não `403`) sempre que qualquer
condição falha — não revela que a rota existe. As 10 combinações acima (+ o
teste de `X-Forwarded-Host`) estão em `worker/src/env.test.ts`.

Local dev define as duas flags **só** em `wrangler.local.jsonc`
(`vars.DEV_OUTBOX_ENABLED`, `vars.ALLOW_INSECURE_LOCAL_COOKIE`) — o
`wrangler.jsonc` implantável nunca as define, e `scripts/check-deployable-d1-config.mjs`
falha o deploy se alguma delas aparecer lá (ver seção "Configuração D1" acima).

## Segurança de senha (correção B, hotfix de restrição de plataforma pós-Sprint 15)

- PBKDF2-HMAC-SHA256 (Web Crypto/`SubtleCrypto`, nativo do runtime Workers).
- **100.000 iterações** — não é uma escolha de segurança "ideal", é uma
  **restrição real da plataforma**: o runtime do Cloudflare Workers em
  produção rejeita PBKDF2 acima de 100.000 iterações, lançando
  `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
  supported`. Isso foi comprovado por uma tentativa REAL de cadastro contra o
  Worker publicado (capturada ao vivo via `wrangler tail`), depois que a v1.1
  havia subido o fator para 600.000 seguindo a recomendação da
  [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  — 600.000 NUNCA funcionou em produção; passava apenas no ambiente local de
  teste anterior (vitest-pool-workers/miniflare), que não reproduz esse teto
  do runtime de borda real. Referência de runtime:
  [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
  (a documentação não declara o teto explicitamente — foi descoberto por
  observação direta do erro em produção).
- Salt aleatório de 16 bytes por senha, chave derivada de 256 bits.
- Formato persistido: `pbkdf2-sha256-v1$<iterações>$<salt base64url>$<hash base64url>`
  — a versão e as iterações ficam junto do hash. `verifyPassword` sempre usa
  as iterações do PRÓPRIO hash armazenado (nunca a constante atual), e agora
  também rejeita, de forma controlada (nunca lançando exceção), qualquer hash
  cujo `iterations` seja `<= 0`, não-inteiro, ou maior que o teto suportado
  pela plataforma (`PBKDF2_MAX_SUPPORTED_ITERATIONS`) — um hash malformado ou
  com iterações acima do limite é tratado como credencial inválida, nunca
  como um 500 genérico. Isso mantém o formato pronto para um aumento futuro
  do fator de hashing SE E SOMENTE SE o teto real da plataforma também
  permitir — nunca invalida hashes antigos gravados com um fator menor.
- Verificação em tempo constante (`timingSafeEqual`).
- Mínimo de 10 caracteres, máximo técnico de 256 — sem regra arbitrária de símbolo/maiúscula.
- Senha, hash e token nunca aparecem em log.

### Benchmark (`worker/scripts/benchmark-pbkdf2.mjs`, Web Crypto nativo, mesma primitiva do Worker)

```
npm run bench:pbkdf2 -- 100000 10
```

| Iterações | Amostras | Mediana | Média | Min | Max |
|---|---|---|---|---|---|
| **100.000 (atual — teto real do runtime Workers)** | 10 | 22.9ms | 23.6ms | 22.0ms | 28.2ms |
| 600.000 (histórico — nunca funcionou em produção) | 10 | 143.1ms | 149.0ms | 139.5ms | 176.6ms |

~23ms por hash é perfeitamente viável para um endpoint de login/cadastro.
Não há margem para subir esse fator sem que a Cloudflare eleve o teto do
runtime — qualquer tentativa de aumentar `PBKDF2_ITERATIONS` sem antes
reverificar o limite real em produção reproduziria exatamente esta falha.

### Upgrade oportunista (`worker/src/services/authService.ts:login`)

Depois de comprovar a senha correta (nunca antes, nunca num login inválido),
`needsRehash(user.password_hash)` verifica se o hash armazenado usa menos que
100.000 iterações; se sim, gera um novo hash com os parâmetros atuais e grava
via `upgradePasswordHash` — **sem** incrementar `session_version` nem revogar
sessões (o segredo comprovado não mudou, só o custo computacional do hash).
Testado em `worker/src/lib/crypto.test.ts`: senha correta/incorreta, salts
diferentes para a mesma senha, formato e fator 100.000, compatibilidade com
hash mais antigo de fator menor, iteration count inválido (zero/negativo/
não-inteiro) e acima do limite suportado (>100.000) sempre tratados sem
lançar exceção, e um cadastro + login completos e reais (via `FakeD1Database`)
usando o crypto de produção de ponta a ponta. Compatibilidade com o runtime
real também foi comprovada via `wrangler dev` local (mesmo binário `workerd`
da produção): um cadastro e um login reais contra `http://127.0.0.1:8793`
completaram com sucesso (201/200), sem `NotSupportedError`.

## Sessão e cookie

- Cookie `md_session`: `HttpOnly`, `Path=/`, `SameSite=Lax`, `Max-Age=14 dias`.
- **`Secure` por padrão.** `shouldOmitSecureCookie(env, url)` (v1.2) só omite
  `Secure` quando **as quatro condições** são verdadeiras ao mesmo tempo:

  1. `ENVIRONMENT === "development"` (exatamente — `"test"` **não** omite);
  2. `ALLOW_INSECURE_LOCAL_COOKIE === "true"` — flag exclusiva de `wrangler.local.jsonc`;
  3. `isRecognizedLocalHostname(url)` — hostname local reconhecido;
  4. `url.protocol === "http:"` — HTTPS local mantém `Secure`.

  | Ambiente | Flag insegura | URL | `Secure`? |
  |---|---|---|---|
  | `development` | `true` | `http://localhost` | ❌ omitido |
  | `development` | `true` | `http://127.0.0.1` | ❌ omitido |
  | `development` | ausente/`false` | `http://localhost` | ✅ mantido |
  | `test` | `true` | `http://localhost` | ✅ mantido |
  | `production` | `true` | `http://localhost` | ✅ mantido |
  | `development` | `true` | `https://localhost` | ✅ mantido |
  | `development` | `true` | `https://...workers.dev` | ✅ mantido |
  | ausente | `true` | `http://localhost` | ✅ mantido |

  As 8 combinações testadas em `worker/src/env.test.ts`; formato do header
  `Set-Cookie` em `worker/src/lib/cookies.test.ts`.
- Nenhum dado pessoal no valor do cookie — token opaco de 256 bits.
- Banco armazena apenas `sha256Hex(token)`.
- Logout revoga a sessão no servidor (`revoked_at`) e expira o cookie com a
  **mesma política de `Secure`** (`buildExpiredSessionCookie` recebe o mesmo
  `shouldOmitSecureCookie(env, url)`, testado).
- Troca de senha incrementa `users.session_version` e revoga todas as sessões.
- Sessão nunca em `localStorage`/`sessionStorage`; `document.cookie` não expõe
  `md_session` (verificado em `e2e/auth-flow.spec.ts`).

## CSRF / Origin

Sem mudanças na v1.1. Toda requisição de mutação (`POST`/`PUT`/`PATCH`/`DELETE`)
valida o header `Origin` contra a origem do próprio Worker antes de qualquer
lógica de negócio (`worker/src/lib/origin.ts`).

## Rate limiting local (correção E)

Reescrito de ponta a ponta. Três mudanças:

1. **Atômico** — antes: `SELECT COUNT` seguido de `INSERT` separado, com uma
   janela de corrida real entre duas requisições concorrentes. Agora: uma
   única instrução `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1
   RETURNING count` — o SQLite/D1 processa isso atomicamente, sem
   check-then-act (`worker/src/lib/rateLimit.ts:incrementAndCheck`).
2. **Duas chaves independentes, ambas precisam passar** — `checkRateLimit`
   (por rota + IP hasheado) e `checkEmailRateLimit` (por rota + e-mail
   normalizado hasheado). Isso impede tanto "muitas tentativas de um IP" quanto
   "muitas tentativas contra UMA conta vindas de IPs diferentes". Aplicado em
   `signup`, `login`, `email/request-confirmation` e `password/request-reset`
   (`checkCombinedRateLimit` em `worker/src/routes/auth.ts`).
3. **Janela fixa de 60 segundos**, documentada como tal (não deslizante — uma
   rajada bem na borda de dois minutos pode, na teoria, somar até 2x o limite
   num intervalo curto; aceito como trade-off de simplicidade nesta escala).
   Limpeza oportunista de janelas com mais de 10 minutos a cada chamada.

Nunca persiste e-mail ou IP em texto puro — só `sha256Hex`. Resposta de
bloqueio é sempre a mesma mensagem genérica (`too_many_requests`), sem
detalhe de qual chave estourou. Testado em `e2e/zz-rate-limit.spec.ts`:
separação de chaves (contadores independentes por e-mail), ausência de dado
sensível em texto puro no D1, e mensagem genérica.

**Limitação conhecida, mantida e reforçada:** em ambiente local, a Cloudflare
não injeta `cf-connecting-ip`, então a dimensão por IP compartilha um único
identificador local entre todo o tráfego (a dimensão por e-mail não sofre
disso). Os limites (`RATE_LIMITS` em `worker/src/routes/auth.ts`) foram
calibrados para acomodar a suíte de testes local inteira. **Este limitador
local D1 não substitui o Rate Limiting nativo da Cloudflare na borda — não é
apresentado como proteção de produção concluída.** Se a escala de produção
exigir garantias atômicas que o D1 não oferece de forma satisfatória
(throughput muito alto, múltiplas regiões), isso deve ser reavaliado antes de
qualquer deploy de autenticação em produção — decisão do PO, não tomada aqui.

## Confirmação de e-mail e recuperação de senha

Tokens de 256 bits, únicos, com expiração (24h/30min), invalidados após uso,
só o hash SHA-256 armazenado. Respostas de "solicitar" são sempre idênticas,
exista ou não o e-mail. Desde a v1.3, consumo do token e a mutação que ele
autoriza são atômicos — ver seção seguinte.

## Atomicidade das operações de token (v1.3)

A auditoria direta do código publicado encontrou três fluxos que faziam
gravações relacionadas em `await`s separados, sem transação — uma falha entre
eles podia deixar o token consumido sem a mutação correspondente, ou
vice-versa. Corrigido usando
[`db.batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/),
que o D1 executa como uma única transação: todos os statements do lote são
aplicados, ou nenhum é.

### Emissão/substituição de token (`tokenRepository.issueToken`)

Invalidar os tokens anteriores do usuário e inserir o novo agora é um único
`db.batch([invalidar, inserir])`. O resultado da inserção é conferido
explicitamente (`meta.changes === 1`); se a inserção falhar por qualquer
motivo, a invalidação do lote também é revertida — o token anterior nunca
fica sem substituto (testado no cenário 10, ver abaixo).

### Consumo condicional — elimina a corrida entre checar e marcar usado

Antes: `SELECT` para achar um token válido, depois `UPDATE ... SET used_at =
...` num `await` separado — duas requisições concorrentes podiam ler o mesmo
token "ainda válido" antes de qualquer uma marcá-lo como usado.

Agora, o consumo é um `UPDATE` condicional que já embute o predicado de
validade (`used_at IS NULL AND expires_at > datetime('now')`) no próprio
`WHERE`, e o chamador confere `meta.changes === 1` para saber se **esta**
requisição venceu a corrida
(`tokenRepository.buildConsumeTokenStatement`/`tokenStillValidGuardSql`). A
leitura inicial (`findValidToken`) só localiza o candidato — a validade real,
dentro da transação, é revalidada pelo `UPDATE` condicional e pelo `EXISTS`
usado nos statements irmãos do mesmo lote. Duas requisições concorrentes com
o mesmo token nunca conseguem as duas mudar `used_at` — exatamente uma vê 1
linha afetada, a outra vê 0.

- **Confirmação de e-mail** (`authService.confirmEmail`): `db.batch([`
  atualizar `users.email_confirmed_at` condicionado ao token ainda válido,
  consumir o token `])`. Ambos os statements enxergam o mesmo estado do token
  (nenhum dos dois o modifica antes do outro ler), então concordam sempre
  sobre o resultado da corrida.
- **Redefinição de senha** (`authService.resetPassword`): `db.batch([`
  trocar `password_hash` e incrementar `session_version`, revogar todas as
  sessões ativas do usuário, consumir o token `])` — as três, condicionadas
  ao mesmo `EXISTS` de token válido, no mesmo lote.

### Validação real do resultado das mutações

Nenhuma das funções acima retorna `{ ok: true }` só porque o `db.batch()` não
lançou exceção. `confirmEmail` exige `meta.changes === 1` tanto na
atualização do usuário quanto no consumo do token; `resetPassword` exige o
mesmo para a troca de senha e o consumo do token (a revogação de sessões pode
legitimamente afetar 0 linhas — usuário sem sessão ativa não é falha). Nomes
de tabela usados nos statements dinâmicos continuam vindo exclusivamente do
mapa fechado `TOKEN_TABLES` (nunca de entrada do usuário) — nenhum SQL é
montado a partir de dado externo.

### Testes de atomicidade (`worker/testing/`)

Não há `miniflare`/`@cloudflare/vitest-pool-workers` neste projeto para rodar
um D1 real dentro do Vitest. Em vez de mockar `.run()`/`.batch()` só contando
chamadas — o que provaria apenas que as funções foram chamadas, não que o
banco fica consistente — `worker/testing/fakeD1.ts` embute um SQLite real
(`node:sqlite`, nativo do Node) e implementa `db.batch()` como uma transação
`BEGIN`/`COMMIT`/`ROLLBACK` verdadeira, incluindo rollback completo quando
qualquer statement falha (mesmo contrato documentado da API D1 real). Esse
seam vive inteiramente fora de `worker/src/` — não é varrido por
`tsc -p worker/tsconfig.json` (que restringe `types` a
`@cloudflare/workers-types` e não conhece `node:sqlite`) e nunca é importado
por código de produção; nenhum comportamento de falha foi adicionado ao
bundle do Worker. A injeção de falha forçada (`failNextMatching`, por padrão
de SQL) só existe nesse fake.

`worker/testing/authAtomicity.test.ts` cobre os 12 cenários exigidos pela
ordem de correção v1.3, sempre conferindo o **estado do banco** depois da
falha simulada (não só a resposta da função):

1. confirmação normal consome o token e confirma o e-mail;
2. reutilização do token de confirmação falha;
3. duas confirmações concorrentes com o mesmo token → exatamente um sucesso;
4. falha forçada na atualização do usuário reverte o consumo do token
   (comprovado: `email_confirmed_at` continua `NULL`, `used_at` continua
   `NULL`, e o token volta a funcionar numa nova tentativa);
5. redefinição normal consome token, troca senha, incrementa `session_version`
   e revoga todas as sessões;
6. reutilização do token de reset falha;
7. duas redefinições concorrentes com o mesmo token → exatamente um sucesso;
8. falha forçada na troca de senha reverte o consumo do token e mantém
   senha/sessões anteriores;
9. falha forçada na revogação de sessões reverte também o consumo do token e
   a troca de senha (statements anteriores no mesmo lote);
10. falha na inserção de um novo token não invalida o token anterior;
11. token expirado não altera usuário, senha ou sessões;
12. token inexistente não altera qualquer estado.

O item 11 revelou um bug real e independente da atomicidade em si: o
`expiresAt` dos tokens era gravado com `Date.toISOString()`
(`"...T...Z"`), formato que a comparação `expires_at > datetime('now')` do
SQLite/D1 (`"YYYY-MM-DD HH:MM:SS"`) compara lexicograficamente de forma
incorreta — o mesmo bug já corrigido em `rateLimit.ts` na v1.1, mas que
persistia, sem cobertura de teste, na expiração de tokens de e-mail/senha.
Corrigido em `authService.ts` (`toSqliteExpiry`), reaproveitando o mesmo
formato de data usado pelo rate limit.

### Adaptador de e-mail (`worker/src/email/`)

- `DevOutboxEmailAdapter`: usado só quando `isLocalDevEnvironment(env)` é
  verdadeiro (correção C). Grava em `dev_email_outbox`; recuperado via
  `GET /api/dev/outbox/last`, também fechada pela mesma checagem.
- `NoProviderEmailAdapter`: usado em qualquer outro ambiente. **Não finge que
  enviou** — retorna `{ sent: false }`.

## Limitações conhecidas desta sprint

- Rate limit local por IP usa identificador fixo em ambiente de
  desenvolvimento (dimensão por e-mail não tem essa limitação).
- Sem 2FA, sem login social, sem verificação de força de senha além do comprimento mínimo.
- `dev_email_outbox` e `/api/dev/outbox/last` só existem sob `ENVIRONMENT`
  explicitamente local — mesmo assim, precisam ser reavaliadas antes de
  qualquer ambiente compartilhado com dados reais.
- Sem rotação automática periódica de sessão (só revogação por logout/troca de senha).
- `wrangler.jsonc` implantável ainda não tem `database_id` real — deploy
  bloqueado por construção até autorização e criação do D1 remoto.

## Rollback seguro

Sem mudanças na v1.1: as migrations (`0001_init.sql`, `0002_rate_limit_counters.sql`)
são não destrutivas para dados de usuário (só criam/removem tabelas de
infraestrutura de rate limit, nunca `users`/`sessions`/tokens). Reverter o
deploy do Worker para a versão da Sprint 1 (sem `main`, sem D1) não exige
desfazer nenhuma migration, pois a Sprint 1 nunca usou D1. Não existe rollback
destrutivo de dados definido nesta sprint.
