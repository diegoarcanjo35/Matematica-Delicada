import { createContext, useContext } from "react";
import type { AdminDashboard } from "../api/adminClient";

/* O dashboard já é buscado uma vez por RequireAdminRole.tsx (é a mesma
   chamada usada para verificar o papel — mesmo raciocínio de
   src/auth/teacherDashboardContext.ts: "não aumentar a API sem
   necessidade"). AdminOverviewPage lê esta mesma resposta em vez de buscar
   de novo. */
export const AdminDashboardContext = createContext<AdminDashboard | null>(null);

export function useAdminDashboard(): AdminDashboard | null {
  return useContext(AdminDashboardContext);
}
