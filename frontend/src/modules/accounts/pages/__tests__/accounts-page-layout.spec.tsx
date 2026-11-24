// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("@/modules/accounts/service/accounts.service", () => ({
  listAccounts: vi.fn(async () => []),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
}))

import "@/i18n"
import { AccountsPage } from "@/modules/accounts/pages/AccountsPage"
import { useAccountsStore } from "@/modules/accounts/store/accounts.store"
import { AccountsView } from "@/modules/accounts/components/AccountsView"
import type { AccountViewItem } from "@/modules/accounts/model/view-model"

const VIEW_WRAPPER = "flex w-full flex-col gap-5 px-4 pb-8 lg:px-6"

function row(id: string, name: string) {
  return {
    id,
    user_id: "u1",
    name,
    type: "checking",
    initial_balance_cents: 100000,
    current_balance_cents: 100000,
    color: null,
    institution: null,
    agency: null,
    account_number: null,
    account_digit: null,
    is_default: false,
    connection_status: "manual",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  } as never
}

describe("whenAccountsPageRenders_thenSingleTemplateHeader", () => {
  beforeEach(() => {
    cleanup()
    useAccountsStore.setState({
      accounts: [row("acc-1", "Conta corrente")],
      status: "ready",
      error: null,
      load: async () => {},
    })
  })

  it("renders exactly one h1 owned by AccountsView (no TreasuryHeader duplicate)", () => {
    const { container } = render(<AccountsPage />)
    const h1s = container.querySelectorAll("h1")
    expect(h1s).toHaveLength(1)
  })

  it("success view uses the template wrapper spacing", () => {
    const { container } = render(<AccountsPage />)
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute("class")).toContain("flex w-full flex-col gap-5")
    expect(wrapper?.getAttribute("class")).toContain("px-4 pb-8 lg:px-6")
  })
})

describe("whenAccountsViewRendersGridMode_thenHeaderStaysSingle", () => {
  beforeEach(() => {
    cleanup()
  })

  it("modo carteira também tem exatamente um h1 (A-C1)", () => {
    const item: AccountViewItem = {
      id: "acc-1",
      nickname: "Conta corrente",
      institution: "itau",
      type: "checking",
      agency: "0001",
      accountNumber: "12345",
      accountDigit: "0",
      currentBalanceCents: 100000,
      reconciledBalanceCents: 100000,
      blockedBalanceCents: 0,
      isDefault: false,
      connectionStatus: "connected",
    }

    const { container } = render(<AccountsView accounts={[item]} initialViewMode="grid" />)
    const h1s = container.querySelectorAll("h1")
    expect(h1s).toHaveLength(1)
    expect(h1s[0]?.textContent).toContain("Contas Bancárias & Tesouraria")
  })
})

describe("whenAccountsScreenStatesRender_thenConsistentSpacing", () => {
  beforeEach(() => {
    cleanup()
  })

  it("loading state shares the view wrapper and exposes aria-busy", () => {
    useAccountsStore.setState({ accounts: [], status: "loading", error: null, load: async () => {} })
    const { container } = render(<AccountsPage />)
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute("class")).toContain("flex w-full flex-col gap-5")
    expect(wrapper?.getAttribute("class")).toContain("px-4 pb-8 lg:px-6")
    expect(wrapper?.getAttribute("aria-busy")).toBe("true")
  })

  it("error state shares the view wrapper with alert role and retry action", async () => {
    const { listAccounts } = await import("@/modules/accounts/service/accounts.service")
    vi.mocked(listAccounts).mockRejectedValueOnce(new Error("boom"))
    useAccountsStore.setState({ accounts: [], status: "error", error: "boom", load: async () => {} })
    const { container } = render(<AccountsPage />)
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute("class")).toContain("flex w-full flex-col gap-5")
    expect(screen.getByRole("alert")).toBeDefined()
    expect(screen.getByRole("button").textContent?.length).toBeGreaterThan(0)
    void VIEW_WRAPPER
  })
})
