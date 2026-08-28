import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { FormField } from "../../components/FormField";
import { Button } from "../../components/Button";
import { Alert } from "../../components/Alert";
import { resetPassword, ApiRequestError } from "../../api/authClient";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);

  if (!token) {
    return (
      <AuthLayout title="Link inválido">
        <Alert variant="error">
          Este link de redefinição está incompleto. Solicite um novo link.
        </Alert>
        <div style={{ marginTop: "var(--space-5)" }}>
          <Link to="/esqueci-minha-senha">
            <Button>Solicitar novo link</Button>
          </Link>
        </div>
      </AuthLayout>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;

    setFormError(null);
    if (password.length < 10) {
      setFormError("A senha deve ter pelo menos 10 caracteres.");
      passwordRef.current?.focus();
      return;
    }
    if (password !== confirmPassword) {
      setFormError("As senhas não coincidem.");
      confirmRef.current?.focus();
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      await resetPassword({ token: token as string, password, confirmPassword });
      navigate("/entrar", { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiRequestError
          ? "Link de redefinição inválido, já usado ou expirado. Solicite um novo."
          : "Não foi possível redefinir a senha. Tente novamente."
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Redefinir senha">
      <form onSubmit={handleSubmit} noValidate>
        {formError && (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Alert variant="error">{formError}</Alert>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <FormField
            ref={passwordRef}
            label="Nova senha"
            type="password"
            autoComplete="new-password"
            helpText="Mínimo de 10 caracteres."
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <FormField
            ref={confirmRef}
            label="Confirmar nova senha"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
          <Button type="submit" isLoading={isSubmitting}>
            Redefinir senha
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
