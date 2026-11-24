// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider } from "react-router-dom"

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

const fromMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession,
      getUser: vi.fn(async () => ({ data: { user: { id: "u1" } } })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
    from: fromMock,
  },
}))

import "@/i18n"
import { createAppRouter } from "@/router"
import { useAuthStore } from "@/store/auth-store"

function accountsFromMock() {
  fromMock.mockImplementation((table: string) => {
    if (table !== "accounts") {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }
    }
    const chain = {
      select: () => chain,
      order: () =>
        Promise.resolve({
          data: [
            {
              id: "acc-1",
              user_id: "u1",
              name: "Conta corrente",
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
            },
          ],
          error: null,
        }),
    }
    return chain
  })
}

describe("whenContasClicked_thenHashRouteShowsBankAccountsView", () => {
  beforeEach(() => {
    getSession.mockReset()
    fromMock.mockReset()
    cleanup()
    window.location.hash = ""
    useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })
    accountsFromMock()
  })

  it("clicar em Contas no menu navega para /#/contas e renderiza BankAccountsView", { timeout: 20000 }, async () => {
    const user = userEvent.setup()
    window.location.hash = "#/"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    // Overview carregada antes do clique
    await waitFor(
      () => {
        expect(screen.getAllByText(/visão geral/i).length).toBeGreaterThan(0)
      },
      { timeout: 10000 },
    )

    await user.click(screen.getByRole("link", { name: /^contas$/i }))

    await waitFor(
      () => {
        expect(window.location.hash).toBe("#/contas")
      },
      { timeout: 10000 },
    )

    // Conteúdo de BankAccountsView (não só o título da página)
    await waitFor(
      () => {
        expect(screen.getAllByText(/extrato & conciliação/i).length).toBeGreaterThan(0)
      },
      { timeout: 10000 },
    )
  })

  it("navegação direta em /#/contas renderiza BankAccountsView", { timeout: 20000 }, async () => {
    window.location.hash = "#/contas"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(window.location.hash).toBe("#/contas")
        expect(screen.getAllByText(/extrato & conciliação/i).length).toBeGreaterThan(0)
      },
      { timeout: 10000 },
    )
  })
})
