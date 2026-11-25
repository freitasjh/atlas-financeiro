// @vitest-environment happy-dom
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
import { useCategoriesStore } from "@/modules/categories/store/categories.store"

function supabaseMocks() {
  getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } })
  fromMock.mockImplementation((table: string) => {
    if (table === "categories") {
      const eqLevel = {
        order: () => Promise.resolve({ data: [], error: null }),
        in: () => Promise.resolve({ data: [], error: null }),
        eq: () => Promise.resolve({ count: 0, error: null }),
      }
      return { select: () => ({ eq: () => eqLevel }) }
    }
    if (table === "transactions") {
      const eqLevel = {
        in: () => Promise.resolve({ data: [], error: null }),
        eq: () => Promise.resolve({ count: 0, error: null }),
        order: () => Promise.resolve({ data: [], error: null }),
      }
      return { select: () => ({ eq: () => eqLevel }) }
    }
    return {
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }
  })
}

describe("whenCategoriasRouteLoads_thenCategoriesScreenRenders", () => {
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
    useCategoriesStore.setState({ categories: [], status: "idle", error: null })
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })
    supabaseMocks()
  })

  it("navegação direta em /#/categorias renderiza a tela com handle title", { timeout: 20000 }, async () => {
    window.location.hash = "#/categorias"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(window.location.hash).toBe("#/categorias")
        expect(screen.getByRole("heading", { level: 1, name: /categorias/i })).toBeTruthy()
      },
      { timeout: 10000 },
    )

    // Empty global honesto (sem seed demo).
    await waitFor(
      () => {
        expect(screen.getByText(/nenhuma categoria ainda/i)).toBeTruthy()
      },
      { timeout: 10000 },
    )
  })

  it("sidebar tem item Categorias que navega para /#/categorias", { timeout: 20000 }, async () => {
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

    await user.click(screen.getByRole("link", { name: /^categorias$/i }))

    await waitFor(
      () => {
        expect(window.location.hash).toBe("#/categorias")
      },
      { timeout: 10000 },
    )
  })
})
