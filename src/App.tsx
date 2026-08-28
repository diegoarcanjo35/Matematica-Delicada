import { Route, Routes } from "react-router-dom";
import { StudentLayout } from "./layouts/StudentLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { STUDENT_NAV_ITEMS } from "./routes/studentNav";

const PLACEHOLDER_ITEMS = STUDENT_NAV_ITEMS.filter((item) => item.path !== "/");

export function App() {
  return (
    <Routes>
      <Route element={<StudentLayout />}>
        <Route path="/" element={<DashboardPage />} />
        {PLACEHOLDER_ITEMS.map((item) => (
          <Route
            key={item.path}
            path={item.path}
            element={<PlaceholderPage title={item.label} description={item.description} />}
          />
        ))}
        <Route
          path="/configuracoes"
          element={
            <PlaceholderPage title="Configurações" description="Preferências da sua conta." />
          }
        />
        <Route
          path="/ajuda"
          element={
            <PlaceholderPage title="Ajuda/Suporte" description="Central de ajuda e contato." />
          }
        />
        <Route
          path="/assinatura"
          element={
            <PlaceholderPage title="Assinatura/Plano" description="Detalhes do seu plano." />
          }
        />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
