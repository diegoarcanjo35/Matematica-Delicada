import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { FormField } from "../../components/FormField";
import { Button } from "../../components/Button";
import { Alert } from "../../components/Alert";
import { signup, ApiRequestError } from "../../api/authClient";
import "./RegisterPage.css";

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  acceptTerms?: string;
}

export function RegisterPage() {
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const termsRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (name.trim().length < 2) errors.name = "Informe seu nome completo.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Informe um e-mail válido.";
    if (password.length < 10) errors.password = "A senha deve ter pelo menos 10 caracteres.";
    if (password !== confirmPassword) errors.confirmPassword = "As senhas não coincidem.";
    if (!acceptTerms) errors.acceptTerms = "É necessário aceitar os termos e a política de privacidade.";
    return errors;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingRef.current) return;

    setFormError(null);
    const errors = validate();
    setFieldErrors(errors);

    if (errors.name) return nameRef.current?.focus();
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();
    if (errors.confirmPassword) return confirmPasswordRef.current?.focus();
    if (errors.acceptTerms) return termsRef.current?.focus();

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      await signup({ name, email, password, confirmPassword, acceptTerms });
      navigate("/cadastro-confirmado", { replace: true, state: { email } });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 429) {
        setFormError("Muitas tentativas. Tente novamente em alguns minutos.");
      } else if (error instanceof ApiRequestError) {
        setFormError(error.apiError.message);
      } else {
        setFormError("Não foi possível concluir o cadastro. Tente novamente.");
      }
      emailRef.current?.focus();
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Criar conta"
      description="Comece seu caderno estratégico para o ENEM."
      footer={
        <span>
          Já tem conta? <Link to="/entrar">Entrar</Link>
        </span>
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
            ref={nameRef}
            label="Nome"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            errorMessage={fieldErrors.name}
            required
          />
          <FormField
            ref={emailRef}
            label="E-mail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            errorMessage={fieldErrors.email}
            required
          />
          <FormField
            ref={passwordRef}
            label="Senha"
            type="password"
            autoComplete="new-password"
            helpText="Mínimo de 10 caracteres. Sem regras arbitrárias de símbolo/maiúscula."
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            errorMessage={fieldErrors.password}
            required
          />
          <FormField
            ref={confirmPasswordRef}
            label="Confirmar senha"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            errorMessage={fieldErrors.confirmPassword}
            required
          />

          <div className="register-page__terms">
            <label className="register-page__terms-label">
              <input
                ref={termsRef}
                type="checkbox"
                checked={acceptTerms}
                onChange={(event) => setAcceptTerms(event.target.checked)}
                aria-describedby="terms-pending-notice"
              />
              {/* Todo o texto num único span: o label é flex (checkbox + texto lado a
                  lado), e sem esse agrupamento cada palavra/link vira um item de flex
                  separado, quebrando linha de forma estranha em vez de fluir como texto. */}
              <span>
                Li e aceito os{" "}
                <Link to="/termos" target="_blank" rel="noreferrer">
                  termos de uso
                </Link>{" "}
                e a{" "}
                <Link to="/privacidade" target="_blank" rel="noreferrer">
                  política de privacidade
                </Link>
                .
              </span>
            </label>
            <p id="terms-pending-notice" className="register-page__terms-notice">
              Conteúdo jurídico definitivo pendente — texto provisório, não é uma versão
              final para produção comercial.
            </p>
            {fieldErrors.acceptTerms && (
              <p className="form-field__error" role="alert">
                {fieldErrors.acceptTerms}
              </p>
            )}
          </div>

          <Button type="submit" isLoading={isSubmitting}>
            Criar conta
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
