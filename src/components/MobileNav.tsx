import { useState } from "react";
import { NavLink } from "react-router-dom";
import { MOBILE_NAV_ITEMS, STUDENT_NAV_ITEMS } from "../routes/studentNav";
import "./MobileNav.css";

export function MobileNav() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const remainingItems = STUDENT_NAV_ITEMS.filter(
    (item) => !MOBILE_NAV_ITEMS.some((mobileItem) => mobileItem.path === item.path)
  );

  return (
    <>
      {isMenuOpen && (
        <div className="mobile-menu" role="dialog" aria-modal="true" aria-label="Mais opções">
          <div className="mobile-menu__panel">
            <div className="mobile-menu__header">
              <span className="mobile-menu__title">Mais opções</span>
              <button
                type="button"
                className="mobile-menu__close"
                onClick={() => setIsMenuOpen(false)}
                aria-label="Fechar menu"
              >
                ✕
              </button>
            </div>
            <ul className="mobile-menu__list">
              {remainingItems.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    className="mobile-menu__link"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    <span aria-hidden="true">{item.icon}</span>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <nav className="mobile-nav" aria-label="Navegação móvel">
        {MOBILE_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              `mobile-nav__link${isActive ? " mobile-nav__link--active" : ""}`
            }
            onClick={() => setIsMenuOpen(false)}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
        <button
          type="button"
          className="mobile-nav__link"
          aria-haspopup="dialog"
          aria-expanded={isMenuOpen}
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">☰</span>
          Menu
        </button>
      </nav>
    </>
  );
}
