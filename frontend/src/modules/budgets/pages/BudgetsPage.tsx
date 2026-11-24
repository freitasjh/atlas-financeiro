import { BudgetsScreen } from "./BudgetsScreen"

/**
 * Rota /orcamentos — conteúdo puro; o esqueleto (sidebar + header) vem do
 * AtlasAdminLayout pathless montado pelo router (Outlet), nunca daqui.
 */
export default function BudgetsPage() {
  return <BudgetsScreen />
}

export { BudgetsPage }
