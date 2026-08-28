import "./Header.css";

interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
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
        <div className="header__profile" aria-label="Ana Cláudia, plano Estratégico">
          <span className="header__avatar" aria-hidden="true">
            AC
          </span>
        </div>
      </div>
    </header>
  );
}
