# E-mail transacional em produção (Resend) — instruções finais

Sprint 16 v1.2, seção 6 da ordem. O código do A1 (`worker/src/email/resendAdapter.ts`,
`worker/src/routes/auth.ts`, `worker/src/services/authService.ts`) está pronto e
testado desde a v1.0 — este documento cobre **só a configuração de produção**,
que continua **bloqueada** até uma ordem explícita separada autorizar
`wrangler secret put`/deploy. Nada aqui foi executado nesta rodada.

## 1. O que precisa estar configurado

| Nome | Tipo | Onde | Obrigatório |
|---|---|---|---|
| `RESEND_API_KEY` | **secret** | `wrangler secret put` (nunca em arquivo versionado) | Sim |
| `EMAIL_FROM_ADDRESS` | var comum | `wrangler.jsonc`, bloco `"vars"` | Sim |

`isRealEmailProviderConfigured` (`worker/src/env.ts`) só liga o `ResendEmailAdapter`
quando as duas estão presentes e minimamente válidas (`RESEND_API_KEY` com
20+ caracteres, `EMAIL_FROM_ADDRESS` contendo `@`). Enquanto qualquer uma
estiver ausente, produção continua usando `NoProviderEmailAdapter` — sem
regressão, sem envio, mas também sem crash.

## 2. Domínio/remetente — precisa estar validado no Resend ANTES

O endereço usado em `EMAIL_FROM_ADDRESS` (ex.:
`"Matemática Delicada <no-reply@matematicadelicada.com.br>"`) só funciona
de verdade depois que o **domínio** dele estiver com status "Verified" no
painel da Resend (dashboard → Domains → Add Domain → configurar os
registros DNS que a Resend pedir — geralmente SPF/DKIM/DMARC via TXT/CNAME
no provedor de DNS do domínio). Isso é uma etapa **fora do controle do
código** e **fora do escopo desta sprint** — quem tiver acesso ao DNS do
domínio real (Andreia/Diego) precisa fazer essa verificação antes que o
secret seja configurado, ou os envios falharão (de forma auditada, nunca
silenciosa — ver seção 4).

Sem um domínio próprio verificado, a Resend também aceita o subdomínio de
teste deles (`onboarding@resend.dev`) — funciona para validar o mecanismo,
mas não deve ser o remetente definitivo de produção (a Resend limita
volume/reputação desse endereço).

## 3. Comandos para configurar (SÓ quando autorizado)

```bash
# 1) A chave de API da conta Resend (Dashboard → API Keys → Create API Key).
#    NUNCA cole a chave direto no comando em um terminal compartilhado/log —
#    prefira o prompt interativo do próprio wrangler:
wrangler secret put RESEND_API_KEY
# (cola o valor quando o wrangler pedir, sem eco na tela)

# 2) O remetente — não é secret, entra em wrangler.jsonc:
#    "vars": { "EMAIL_FROM_ADDRESS": "Matemática Delicada <no-reply@SEU-DOMINIO-VERIFICADO>" }
#    (edição de arquivo versionado + deploy normal — sem comando `wrangler secret`)
```

Depois de configurar os dois e fazer o deploy (`wrangler deploy`, fora do
escopo desta rodada), `isRealEmailProviderConfigured` passa a retornar
`true` em produção e `emailAdapterFor` (`worker/src/routes/auth.ts`) passa
a escolher `ResendEmailAdapter` automaticamente — nenhuma outra mudança de
código é necessária.

## 4. Como confirmar que funcionou (falha nunca é silenciosa)

Qualquer falha de envio real (API da Resend fora do ar, domínio ainda não
verificado, chave inválida) grava um evento `email_send_failed` em
`audit_log` (metadata: `{ kind: "email_confirmation" | "password_reset" }`)
— consultável via D1 read-only, sem precisar de acesso a logs de aplicação:

```sql
SELECT id, event_type, metadata, created_at
FROM audit_log
WHERE event_type = 'email_send_failed'
ORDER BY created_at DESC
LIMIT 20;
```

Zero linhas nesse período = todo envio tentado nesse período teve sucesso
(ou nenhum foi tentado). A resposta HTTP ao cliente NUNCA muda por causa de
uma falha de envio (contrato anti-enumeração preservado) — esta consulta é
a forma correta de verificar, não o comportamento visível na tela.

## 5. Smoke test — confirmação de e-mail

Depois do secret configurado e do deploy:

1. Cadastre uma conta de teste real (com um e-mail que você controla) pela
   tela normal de cadastro do site em produção.
2. Confirme que o e-mail de confirmação chegou (assunto/remetente
   configurado em `resendAdapter.ts`) dentro de 1-2 minutos.
3. Se não chegar, rode a consulta da seção 4 procurando
   `event_type = 'email_send_failed'` com `metadata.kind = 'email_confirmation'`
   próximo do horário do cadastro.

Alternativa sem criar conta nova — reenviar a confirmação de uma conta já
existente e ainda não confirmada:

```powershell
Invoke-RestMethod -Uri "https://matematica-delicada.proffandreia5.workers.dev/api/auth/email/request-confirmation" `
  -Method POST -ContentType "application/json" `
  -Body '{"email":"conta-de-teste@dominio-que-voce-controla.com"}'
```

A resposta é sempre `{"ok":true}` (anti-enumeração — não revela se a conta
existe/já está confirmada); o sinal real de sucesso é o e-mail chegando OU
a ausência de `email_send_failed` na consulta da seção 4.

## 6. Smoke test — recuperação de senha

```powershell
Invoke-RestMethod -Uri "https://matematica-delicada.proffandreia5.workers.dev/api/auth/password/request-reset" `
  -Method POST -ContentType "application/json" `
  -Body '{"email":"conta-de-teste@dominio-que-voce-controla.com"}'
```

Mesmo contrato: resposta sempre `{"ok":true}`; confirme o e-mail de
recuperação chegando de verdade, ou audite `email_send_failed` com
`metadata.kind = 'password_reset'`.

## 7. Depois de validado

Nenhuma ação de código adicional é necessária — o pipeline já está
completo desde a v1.0. Este documento existe só para a etapa operacional
(configurar secret + DNS + confirmar), que continua bloqueada até o PO
autorizar explicitamente esta rodada de produção.
