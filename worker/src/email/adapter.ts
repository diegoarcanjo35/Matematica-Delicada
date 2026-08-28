export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  kind: "email_confirmation" | "password_reset";
}

export interface EmailAdapter {
  send(message: EmailMessage): Promise<{ sent: boolean }>;
}
