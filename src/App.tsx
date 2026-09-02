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
import { DiagnosticPage } from "./pages/diagnostic/DiagnosticPage";
import { SchedulePage } from "./pages/schedule/SchedulePage";
import { DailyTrainingPage } from "./pages/dailyTraining/DailyTrainingPage";
import { SimuladosPage } from "./pages/simulations/SimuladosPage";
import { SimuladoBlocoPage } from "./pages/simulations/SimuladoBlocoPage";
import { PatternsPage } from "./pages/patterns/PatternsPage";
import { PatternDetailPage } from "./pages/patterns/PatternDetailPage";
import { QuestionStartPage } from "./pages/player/QuestionStartPage";
import { AttemptPage } from "./pages/player/AttemptPage";
import { ErrorNotebookListPage } from "./pages/errorNotebook/ErrorNotebookListPage";
import { ErrorNotebookDetailPage } from "./pages/errorNotebook/ErrorNotebookDetailPage";
import { MapaEnemListPage } from "./pages/studentMetrics/MapaEnemListPage";
import { MapaEnemDetailPage } from "./pages/studentMetrics/MapaEnemDetailPage";
import { WeeklyReviewPage } from "./pages/weeklyReview/WeeklyReviewPage";
import { EditorialQuestionsPage } from "./pages/editorial/EditorialQuestionsPage";
import { EditorialQuestionFormPage } from "./pages/editorial/EditorialQuestionFormPage";
import { EditorialImportsPage } from "./pages/editorial/EditorialImportsPage";
import { RequireEditorialRole } from "./auth/RequireEditorialRole";
import { STUDENT_NAV_ITEMS } from "./routes/studentNav";

// Rotas do menu do aluno que já têm tela real e por isso NÃO recebem
// placeholder: dashboard (/), cronograma (Sprint 5) e padrões ENEM (Sprint 6).
const IMPLEMENTED_NAV_PATHS = new Set([
  "/",
  "/cronograma",
  "/padroes-enem",
  "/caderno-de-erros",
  "/mapa-enem",
  "/treino-diario",
  "/simulados",
  "/relatorio-semanal",
]);
const PLACEHOLDER_ITEMS = STUDENT_NAV_ITEMS.filter((item) => !IMPLEMENTED_NAV_PATHS.has(item.path));

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

        {/* Área editorial — Sprint 7 v1.0. Exige sessão válida (ProtectedRoute)
            E papel editor/admin (RequireEditorialRole, que consulta o banco via
            /api/editorial/me). Deliberadamente FORA do StudentLayout/
            OnboardingStatusProvider/menu do aluno (seção 9 da ordem: "Não
            adicionar ao menu do aluno") — só alcançável por navegação direta
            à URL, e mesmo assim bloqueada sem papel. */}
        <Route
          element={
            <ProtectedRoute>
              <RequireEditorialRole>
                <Outlet />
              </RequireEditorialRole>
            </ProtectedRoute>
          }
        >
          <Route path="/editorial/questoes" element={<EditorialQuestionsPage />} />
          <Route path="/editorial/questoes/nova" element={<EditorialQuestionFormPage />} />
          <Route path="/editorial/questoes/:id" element={<EditorialQuestionFormPage />} />
          <Route path="/editorial/importacoes" element={<EditorialImportsPage />} />
        </Route>

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
            <Route path="/diagnostico" element={<DiagnosticPage />} />
            <Route path="/cronograma" element={<SchedulePage />} />
            <Route path="/treino-diario" element={<DailyTrainingPage />} />
            <Route path="/simulados" element={<SimuladosPage />} />
            <Route path="/simulados/:blockId" element={<SimuladoBlocoPage />} />
            <Route path="/padroes-enem" element={<PatternsPage />} />
            <Route path="/padroes-enem/:slug" element={<PatternDetailPage />} />
            <Route path="/questoes/:questionId" element={<QuestionStartPage />} />
            <Route path="/tentativas/:attemptId" element={<AttemptPage />} />
            <Route path="/caderno-de-erros" element={<ErrorNotebookListPage />} />
            <Route path="/caderno-de-erros/:entryId" element={<ErrorNotebookDetailPage />} />
            <Route path="/mapa-enem" element={<MapaEnemListPage />} />
            <Route path="/mapa-enem/:slug" element={<MapaEnemDetailPage />} />
            <Route path="/relatorio-semanal" element={<WeeklyReviewPage />} />
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
