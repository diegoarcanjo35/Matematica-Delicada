import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { FormField } from "../../components/FormField";
import { Button } from "../../components/Button";
import { Alert } from "../../components/Alert";
import { useAuth } from "../../auth/useAuth";
import { ApiRequestError } from "../../api/authClient";

export function LoginPage() {
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);
  // Guarda por ref, não só por state: dois cliques quase simultâneos podem
  // disparar dois handlers antes que o re-render com isSubmitting=true aconteça
  // (state não é síncrono entre dois eventos nativos separados). A ref é.
  const isSubmittingRef = useRef(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return; // previne duplo envio

    setFormError(null);

    if (!email || !password) {
      setFormError("Informe e-mail e senha.");
      emailRef.current?.focus();
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      await login(email, password);
      // Sem navegação manual aqui de propósito: assim que o status vira
      // "authenticated", <PublicOnlyRoute> (que envolve esta página) redireciona
      // declarativamente para location.state.from — fonte única de verdade,
      // evitando a corrida entre duas navegações concorrentes.
    } catch (error) {
      // Mensagem genérica — não revela se o e-mail existe.
      setFormError(
        error instanceof ApiRequestError && error.status === 429
          ? "Muitas tentativas. Tente novamente em alguns minutos."
          : "E-mail ou senha incorretos."
      );
      emailRef.current?.focus();
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Entrar"
      description="Continue seu treino estratégico para o ENEM."
      footer={
        <>
          <Link to="/esqueci-minha-senha">Esqueci minha senha</Link>
          <span>
            Ainda não tem conta? <Link to="/criar-conta">Criar conta</Link>
          </span>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        {formError && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Alert variant="error">{formError}</Alert>
          </div>
        )}

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
          <FormField
            label="Senha"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <Button type="submit" isLoading={isSubmitting}>
            Entrar
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
