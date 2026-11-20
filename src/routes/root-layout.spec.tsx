// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
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

describe("whenAnyRouteIsRendered_thenToasterIsMountedOnce", () => {
  beforeEach(() => {
    getSession.mockReset()
    cleanup()
    window.location.hash = ""
    useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
  })

  it("monta o Toaster no root do router (rota fora do App)", async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    window.location.hash = "#/login"
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(screen.getByText(/entrar na sua conta/i)).toBeTruthy()
    })

    expect(document.querySelectorAll('section[aria-label^="Notifications"]')).toHaveLength(1)
  })
})
