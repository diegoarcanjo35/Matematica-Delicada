import type { EmailAdapter, EmailMessage } from "./adapter";

/* Adaptador de e-mail transacional real — Sprint 16 v1.0 (A1).

   Resend (https://resend.com) escolhido por ser a opção mais adequada ao
   runtime Workers: API HTTP pura (POST + JSON via `fetch`, nenhum SMTP —
   Workers não expõe sockets TCP genéricos para esse caso), sem dependência
   nativa/binário, com um plano gratuito suficiente para o volume desta
   plataforma nesta fase. O valor do secret nunca é lido de nenhum arquivo
   versionado (worker/src/env.ts:RESEND_API_KEY) — configurado via
   `wrangler secret put` numa rodada separada e futura, com autorização
   explícita do PO (mesma disciplina já usada para ADMIN_BOOTSTRAP_SECRET).

   Falha de envio NUNCA é silenciosa (ordem, seção A1): qualquer falha —
   HTTP não-2xx da Resend ou erro de rede no próprio `fetch` — é logada via
   `console.error` com contexto suficiente para diagnosticar (tipo de
   mensagem, status HTTP, corpo da resposta truncado) e sempre devolve
   `{ sent: false }` para o chamador, que por sua vez (worker/src/routes/
   auth.ts) grava um evento de auditoria `email_send_failed` — nunca apenas
   "engolida". O corpo do e-mail em si (que pode conter o link com token)
   nunca é logado. */

const RESEND_API_URL = "https://api.resend.com/emails";

export class ResendEmailAdapter implements EmailAdapter {
  constructor(private readonly apiKey: string, private readonly fromAddress: string) {}

  async send(message: EmailMessage): Promise<{ sent: boolean }> {
    try {
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "(sem corpo de resposta)");
        console.error(
          `Falha ao enviar e-mail via Resend (kind=${message.kind}, status=${response.status}): ${detail.slice(0, 500)}`
        );
        return { sent: false };
      }

      return { sent: true };
    } catch (error) {
      console.error(`Falha ao enviar e-mail via Resend (kind=${message.kind}): erro de rede/fetch`, error);
      return { sent: false };
    }
  }
}
