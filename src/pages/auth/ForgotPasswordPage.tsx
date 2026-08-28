import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { FormField } from "../../components/FormField";
import { Button } from "../../components/Button";
import { Alert } from "../../components/Alert";
import { requestPasswordReset } from "../../api/authClient";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [wasSubmitted, setWasSubmitted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      emailRef.current?.focus();
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      // A resposta é sempre a mesma, exista ou não o e-mail — não enumeramos usuários.
      await requestPasswordReset(email);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      setWasSubmitted(true);
    }
  }

  if (wasSubmitted) {
    return (
      <AuthLayout title="Verifique seu e-mail">
        <Alert variant="info">
          Se houver uma conta com o e-mail <strong>{email}</strong>, você receberá um link para
          redefinir sua senha em instantes. O link expira em 30 minutos.
        </Alert>
        <div style={{ marginTop: "var(--space-5)" }}>
          <Link to="/entrar">Voltar para o login</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Esqueci minha senha"
      description="Informe seu e-mail para receber o link de redefinição."
      footer={<Link to="/entrar">Voltar para o login</Link>}
    >
      <form onSubmit={handleSubmit} noValidate>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <FormField
            ref={emailRef}
            label="E-mail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Button type="submit" isLoading={isSubmitting}>
            Enviar link de redefinição
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
