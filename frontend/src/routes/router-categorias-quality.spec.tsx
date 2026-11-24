// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
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

describe("whenCategoriasDeepLinkLoads_thenValidRendersInvalid404s", () => {
  beforeEach(() => {
    getSession.mockReset()
    fromMock.mockReset()
    getUserMock.mockReset()
    cleanup()
    window.location.hash = ""
    useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
    useCategoriesStore.setState({ categories: [], status: "idle", error: null })
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })
    supabaseMocks()
  })

  it("deep-link válido /#/categorias com query renderiza a tela", { timeout: 20000 }, async () => {
    window.location.hash = "#/categorias?tipo=receitas"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(screen.getByRole("heading", { level: 1, name: /categorias/i })).toBeTruthy()
      },
      { timeout: 10000 },
    )
  })

  it("deep-link inválido /#/categoria (typo) cai no 404", { timeout: 20000 }, async () => {
    window.location.hash = "#/categoria"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(screen.getByRole("heading", { level: 1, name: "404" })).toBeTruthy()
      },
      { timeout: 10000 },
    )
  })
})
