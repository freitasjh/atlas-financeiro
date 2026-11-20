import { useEffect, useMemo } from "react"
import { useAccountsStore } from "@/modules/accounts/store/accounts.store"
import type { GlobalBalanceAccount } from "./global-balance-popover"

// Hook-first: SiteHeader consome a mesma fonte da tela Contas.
// AccountRow (BIGINT cents) → GlobalBalanceAccount; soma em cents inteiros.
export function accountRowToGlobalBalance(
  row: { id: string; name: string; current_balance_cents: number },
): GlobalBalanceAccount {
  if (!Number.isInteger(row.current_balance_cents)) {
    throw new Error("saldos devem ser inteiros em cents (sem float)")
  }
  return { id: row.id, nickname: row.name, balanceCents: row.current_balance_cents }
}

export function useGlobalBalance() {
  const accounts = useAccountsStore((s) => s.accounts)
  const status = useAccountsStore((s) => s.status)
  const load = useAccountsStore((s) => s.load)

  useEffect(() => {
    if (status === "idle") void load()
  }, [status, load])

  const mapped = useMemo(() => accounts.map(accountRowToGlobalBalance), [accounts])

  return {
    accounts: mapped,
    loading: status === "idle" || status === "loading",
    error: status === "error",
    onRetry: () => void load(),
  }
}
