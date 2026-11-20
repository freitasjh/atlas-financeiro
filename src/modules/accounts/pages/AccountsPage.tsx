import { BankAccountsScreen } from "./BankAccountsScreen"

/**
 * Rota /contas — conteúdo puro; o esqueleto (sidebar + header) vem do
 * AtlasAdminLayout pathless montado pelo router (Outlet), nunca daqui.
 * O header de página (h1 + subtítulo) é único e pertence a AccountsView.
 */
export default function AccountsPage() {
  return <BankAccountsScreen />
}

export { AccountsPage }
