// @vitest-environment happy-dom
// O2.1 — TDD: rota /orcamentos (handle title i18n) + item Orçamentos na sidebar.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider } from "react-router-dom"

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

const fromMock = vi.hoisted(() => vi.fn())
const getUserMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession,
      getUser: getUserMock,
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
import { useBudgetsStore } from "@/modules/budgets/store/budgets.store"
import { useCategoriesStore } from "@/modules/categories/store/categories.store"

// Query encadeável genérica: cada método retorna a query; await resolve
// para objeto sem data/error (listas vazias honestas, sem throw).
function stubQuery(): Record<string, (...args: unknown[]) => unknown> {
  const query: Record<string, (...args: unknown[]) => unknown> = {}
  const methods = ["select", "eq", "order", "gte", "lt", "in"]
  for (const method of methods) {
    query[method] = () => query
  }
  query.single = () => Promise.resolve({ data: null, error: null })
  return query
}

function supabaseMocks() {
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } })
  fromMock.mockImplementation(() => stubQuery())
}

describe("whenOrcamentosRouteLoads_thenBudgetsScreenRenders", () => {
  beforeEach(() => {
    getSession.mockReset()
    fromMock.mockReset()
    getUserMock.mockReset()
    cleanup()
    window.location.hash = ""
    useAuthStore.setState({
      status: "authenticated",
      initialized: true,
      user: { id: "u1", email: "a@b.com" },
      error: null,
      reLoginRequired: false,
    })
    useBudgetsStore.setState({ budgets: [], spending: new Map(), status: "idle", error: null, month: "" })
    useCategoriesStore.setState({ categories: [], status: "idle", error: null })
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })
    supabaseMocks()
  })

  it("navegação direta em /#/orcamentos renderiza a tela com handle title", { timeout: 20000 }, async () => {
    window.location.hash = "#/orcamentos"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(window.location.hash).toBe("#/orcamentos")
        expect(screen.getByRole("heading", { level: 1, name: /orçamentos/i })).toBeTruthy()
      },
      { timeout: 10000 },
    )

    // Empty global honesto (sem seed demo).
    await waitFor(
      () => {
        expect(screen.getByText(/nenhum teto ainda/i)).toBeTruthy()
      },
      { timeout: 10000 },
    )
  })

  it("sidebar tem item Orçamentos que navega para /#/orcamentos", { timeout: 20000 }, async () => {
    const user = userEvent.setup()
    window.location.hash = "#/"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(screen.getAllByText(/visão geral/i).length).toBeGreaterThan(0)
      },
      { timeout: 10000 },
    )

    await user.click(screen.getByRole("link", { name: /^orçamentos$/i }))

    await waitFor(
      () => {
        expect(window.location.hash).toBe("#/orcamentos")
      },
      { timeout: 10000 },
    )
  })
})
