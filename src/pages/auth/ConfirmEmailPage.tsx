import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { LoadingState } from "../../components/LoadingState";
import { confirmEmail } from "../../api/authClient";

type Status = "loading" | "success" | "error";

export function ConfirmEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [status, setStatus] = useState<Status>(token ? "loading" : "error");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    confirmEmail(token)
      .then(() => {
        if (!cancelled) setStatus("success");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AuthLayout title="Confirmação de e-mail">
      {status === "loading" && <LoadingState label="Confirmando seu e-mail…" />}
      {status === "success" && (
        <>
          <Alert variant="success">Seu e-mail foi confirmado com sucesso.</Alert>
          <div style={{ marginTop: "var(--space-5)" }}>
            <Link to="/entrar">
              <Button>Ir para o login</Button>
            </Link>
          </div>
        </>
      )}
      {status === "error" && (
        <>
          <Alert variant="error">
            Este link de confirmação é inválido, já foi usado ou expirou.
          </Alert>
          <div style={{ marginTop: "var(--space-5)" }}>
            <Link to="/entrar">Voltar para o login</Link>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
