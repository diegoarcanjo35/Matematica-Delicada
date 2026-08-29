import { Outlet, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { PublicOnlyRoute } from "./auth/PublicOnlyRoute";
import { RequireOnboardingComplete } from "./auth/RequireOnboardingComplete";
import { OnboardingStatusProvider } from "./onboarding/OnboardingStatusProvider";
import { StudentLayout } from "./layouts/StudentLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { SettingsPage } from "./pages/SettingsPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { RegisterPage } from "./pages/auth/RegisterPage";
import { RegisterConfirmationPage } from "./pages/auth/RegisterConfirmationPage";
import { ForgotPasswordPage } from "./pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/auth/ResetPasswordPage";
import { ConfirmEmailPage } from "./pages/auth/ConfirmEmailPage";
import { OnboardingPage } from "./pages/onboarding/OnboardingPage";
import { STUDENT_NAV_ITEMS } from "./routes/studentNav";

const PLACEHOLDER_ITEMS = STUDENT_NAV_ITEMS.filter((item) => item.path !== "/");

export function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Rotas públicas de autenticação — fora do shell do aluno */}
        <Route
          path="/entrar"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route
          path="/criar-conta"
          element={
            <PublicOnlyRoute>
              <RegisterPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="/cadastro-confirmado" element={<RegisterConfirmationPage />} />
        <Route
          path="/esqueci-minha-senha"
          element={
            <PublicOnlyRoute>
              <ForgotPasswordPage />
            </PublicOnlyRoute>
          }
        />
        <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
        <Route path="/confirmar-email" element={<ConfirmEmailPage />} />
        <Route
          path="/termos"
          element={<PlaceholderPage title="Termos de Uso" description="Conteúdo jurídico definitivo pendente." />}
        />
        <Route
          path="/privacidade"
          element={
            <PlaceholderPage title="Política de Privacidade" description="Conteúdo jurídico definitivo pendente." />
          }
        />

        {/* Área do aluno — exige sessão válida no servidor. OnboardingStatusProvider
            fica aqui, acima de /onboarding e da área gated, para que ambos
            compartilhem a mesma consulta a /api/onboarding sem duplicar a
            requisição (Sprint 3). */}
        <Route
          element={
            <ProtectedRoute>
              <OnboardingStatusProvider>
                <Outlet />
              </OnboardingStatusProvider>
            </ProtectedRoute>
          }
        >
          <Route path="/onboarding" element={<OnboardingPage />} />

          <Route element={<RequireOnboardingComplete><StudentLayout /></RequireOnboardingComplete>}>
            <Route path="/" element={<DashboardPage />} />
            {PLACEHOLDER_ITEMS.map((item) => (
              <Route
                key={item.path}
                path={item.path}
                element={<PlaceholderPage title={item.label} description={item.description} />}
              />
            ))}
            <Route
              path="/diagnostico"
              element={
                <PlaceholderPage
                  title="Diagnóstico"
                  description="Será implementado na próxima sprint."
                />
              }
            />
            <Route path="/configuracoes" element={<SettingsPage />} />
            <Route
              path="/ajuda"
              element={<PlaceholderPage title="Ajuda/Suporte" description="Central de ajuda e contato." />}
            />
            <Route
              path="/assinatura"
              element={<PlaceholderPage title="Assinatura/Plano" description="Detalhes do seu plano." />}
            />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
