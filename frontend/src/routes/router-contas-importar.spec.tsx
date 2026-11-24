// @vitest-environment happy-dom
// P1.1 — rota filha contas/importar: deep-link renderiza ImportOfxPage
// (activeView accounts, breadcrumb, voltar) sem quebrar o shell.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
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

function supabaseOk() {
  fromMock.mockImplementation((table: string) => {
    if (table === "accounts") {
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
    }
    return {
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }
  })
}

describe("whenImportRouteOpened_thenImportOfxPageRenders", () => {
  beforeEach(() => {
    getSession.mockReset()
    fromMock.mockReset()
    cleanup()
    window.location.hash = ""
    useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })
    supabaseOk()
  })

  it("deep-link direto em /#/contas/importar abre a página (estado vazio, sem quebra)", { timeout: 20000 }, async () => {
    window.location.hash = "#/contas/importar?conta=acc-1"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(
      () => {
        expect(window.location.hash).toContain("#/contas/importar")
        expect(screen.getAllByText(/importar extrato ofx/i).length).toBeGreaterThan(0)
      },
      { timeout: 10000 },
    )

    // Etapa 1 visível: dropzone + voltar para /contas
    await waitFor(
      () => {
        expect(screen.getByText(/arraste seu arquivo/i)).toBeTruthy()
        expect(screen.getByRole("link", { name: /voltar/i }).getAttribute("href")).toBe("#/contas")
      },
      { timeout: 10000 },
    )
  })
})
