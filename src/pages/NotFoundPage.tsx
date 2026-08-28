import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import "./NotFoundPage.css";

export function NotFoundPage() {
  return (
    <div className="not-found">
      <p className="not-found__code" aria-hidden="true">
        404
      </p>
      <h1 className="not-found__title">Página não encontrada</h1>
      <p className="not-found__description">
        O endereço que você tentou acessar não existe ou foi movido.
      </p>
      <Link to="/">
        <Button>Voltar ao Início</Button>
      </Link>
    </div>
  );
}
