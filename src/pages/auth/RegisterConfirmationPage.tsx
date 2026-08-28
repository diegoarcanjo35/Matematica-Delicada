import { Link, useLocation } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";

interface LocationState {
  email?: string;
}

export function RegisterConfirmationPage() {
  const location = useLocation();
  const email = (location.state as LocationState | null)?.email;

  return (
    <AuthLayout title="Cadastro criado">
      <Alert variant="success" title="Sua conta foi criada">
        {email
          ? `Enviamos um link de confirmação para ${email}. Confirme seu e-mail para liberar todos os recursos.`
          : "Enviamos um link de confirmação para o e-mail informado."}
      </Alert>
      <div style={{ marginTop: "var(--space-5)" }}>
        <Link to="/entrar">
          <Button>Ir para o login</Button>
        </Link>
      </div>
    </AuthLayout>
  );
}
