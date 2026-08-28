import { useAuth } from "../auth/useAuth";
import "./Header.css";

interface HeaderProps {
  title: string;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export function Header({ title }: HeaderProps) {
  const { user } = useAuth();

  return (
    <header className="header">
      <h1 className="header__title">{title}</h1>
      <div className="header__actions">
        <button type="button" className="header__icon-button" aria-label="Notificações">
          🔔
        </button>
        <button type="button" className="header__icon-button" aria-label="Ajuda e suporte">
          ❓
        </button>
        {user && (
          <div className="header__profile" aria-label={`${user.name}, sessão ativa`}>
            <span className="header__avatar" aria-hidden="true">
              {initialsOf(user.name)}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
