// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import { RouterProvider } from "react-router-dom"

const { getSession } = vi.hoisted(() => ({
  getSession: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}))

import { createAppRouter } from "@/router"
import { useAuthStore } from "@/store/auth-store"
import "@/i18n"

describe("roteamento hash", () => {
  beforeEach(() => {
    getSession.mockReset()
    cleanup()
    window.location.hash = ""
    useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
  })

  it("renderiza LoginPage em /login", async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    window.location.hash = "#/login"
    const r = createAppRouter()
    render(<RouterProvider router={r} />)
    await waitFor(() => {
      expect(screen.getByText(/entrar na sua conta/i)).toBeTruthy()
    })
  })

  it("renderiza app com sessão", { timeout: 20000 }, async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })
    window.location.hash = "#/"
    const r = createAppRouter()
    render(<RouterProvider router={r} />)
    await waitFor(
      () => {
        expect(screen.getAllByText(/Visão Geral/i).length).toBeGreaterThan(0)
      },
      { timeout: 10000 },
    )
  })

  it("redireciona para /login sem sessão", async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    window.location.hash = "#/"
    const r = createAppRouter()
    render(<RouterProvider router={r} />)
    await waitFor(() => {
      expect(screen.getByText(/entrar na sua conta/i)).toBeTruthy()
    })
  })
})