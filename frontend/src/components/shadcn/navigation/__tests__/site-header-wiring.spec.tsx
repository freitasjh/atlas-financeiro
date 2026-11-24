// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

const svc = vi.hoisted(() => ({ listAccounts: vi.fn() }))
vi.mock("@/modules/accounts/service/accounts.service", () => svc)

import i18n from "@/i18n"
import { SidebarProvider } from "@/components/shadcn/ui/sidebar"
import { SiteHeader } from "../site-header"
import { useAccountsStore } from "@/modules/accounts/store/accounts.store"
import { accountRowToBankAccount } from "@/modules/accounts/model/accounts.adapter"
import { computeTreasuryMetrics } from "@/modules/accounts/model/view-model"
import type { AccountRow } from "@/modules/accounts/service/accounts.service"

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "a1",
    user_id: "u1",
    tenant_id: null,
    name: "Conta A",
    type: "checking",
    initial_balance_cents: 0,
    current_balance_cents: 0,
    color: null,
    institution: "itau",
    agency: null,
    account_number: null,
    account_digit: null,
    is_default: false,
    connection_status: "manual",
    created_at: "",
    updated_at: "",
    ...overrides,
  }
}

function renderHeader() {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SiteHeader title="Visão geral" />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

describe("SiteHeader wiring useAccountsStore (topbar == Contas)", () => {
  beforeEach(() => {
    svc.listAccounts.mockReset()
    svc.listAccounts.mockResolvedValue([])
  })
  afterEach(async () => {
    await i18n.changeLanguage("pt-BR")
    cleanup()
    useAccountsStore.setState({ accounts: [], status: "idle", error: null })
  })

  it("whenStorePopulated_thenTopbarTotalEqualsTreasuryMetrics", () => {
    const rows = [
      row({ id: "a1", name: "Itaú • Operacional", current_balance_cents: 15000 }),
      row({ id: "a2", name: "Nubank PJ", current_balance_cents: 5000 }),
    ]
    useAccountsStore.setState({ accounts: rows, status: "ready", error: null })
    renderHeader()
    const expected = computeTreasuryMetrics(rows.map(accountRowToBankAccount))
      .totalConsolidatedBalanceCents
    expect(expected).toBe(20000)
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    const value = trigger.querySelector(".tabular-nums")
    // R$ 200,00 — mesma fonte da tela Contas (current_balance_cents, cents inteiros)
    expect(value?.textContent).toContain("200,00")
  })

  it("whenStoreLoading_thenSkeletonWithoutRZeroFlash", () => {
    useAccountsStore.setState({ accounts: [], status: "loading", error: null })
    renderHeader()
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    const value = trigger.querySelector(".tabular-nums")
    expect(value?.textContent).toBe("—")
    expect(value?.textContent).not.toContain("0,00")
  })

  it("whenStoreError_thenAlertAndRetry", async () => {
    useAccountsStore.setState({ accounts: [], status: "error", error: "boom" })
    renderHeader()
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    const alert = await screen.findByRole("alert")
    expect(alert).toBeTruthy()
    const retry = screen.getByRole("button", { name: /tentar novamente/i })
    expect(retry.getAttribute("class")).toMatch(/min-h-11/)
    fireEvent.click(retry)
    expect(svc.listAccounts).toHaveBeenCalled()
  })

  it("whenStoreEmpty_thenEmptyCountZero", async () => {
    useAccountsStore.setState({ accounts: [], status: "ready", error: null })
    renderHeader()
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    expect(await screen.findByText(/nenhuma conta/i)).toBeTruthy()
  })
})
