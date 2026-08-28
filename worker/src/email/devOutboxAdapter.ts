import type { EmailAdapter, EmailMessage } from "./adapter";

/* Adaptador de desenvolvimento/teste — nunca usado em produção real.
   Grava o e-mail (incluindo o link com token) numa caixa de saída local no D1,
   para que testes automatizados consigam recuperar o link de forma controlada,
   sem depender de nenhuma conta ou serviço externo de e-mail. */
export class DevOutboxEmailAdapter implements EmailAdapter {
  constructor(private readonly db: D1Database, private readonly newId: () => string) {}

  async send(message: EmailMessage): Promise<{ sent: boolean }> {
    await this.db
      .prepare("INSERT INTO dev_email_outbox (id, to_email, subject, body, kind) VALUES (?, ?, ?, ?, ?)")
      .bind(this.newId(), message.to, message.subject, message.body, message.kind)
      .run();
    return { sent: true };
  }
}

/* Adaptador de produção sem provedor configurado — nunca finge que enviou.
   Enquanto não houver um provedor real de e-mail (decisão de produto pendente),
   a produção deve falhar de forma clara e auditável em vez de fingir sucesso. */
export class NoProviderEmailAdapter implements EmailAdapter {
  async send(): Promise<{ sent: boolean }> {
    return { sent: false };
  }
}
