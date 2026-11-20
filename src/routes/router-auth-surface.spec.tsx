// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { RouterProvider } from "react-router-dom"

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      setSession: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
    },
  },
}))

import { createAppRouter } from "@/router"
import { useAuthStore } from "@/store/auth-store"
import "@/i18n"

beforeEach(() => {
  cleanup()
  getSession.mockReset()
  getSession.mockResolvedValue({ data: { session: null }, error: null })
  useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
  window.location.hash = ""
  document.cookie = "pendingPasswordSetup=; Path=/; Max-Age=0"
})

describe("superfície de auth pós invite-only", () => {
  it("whenRegisterWithPlan_thenRedirectsToRequestInvitePreservingSearch", async () => {
    window.location.hash = "#/register?plano=pro"
    render(<RouterProvider router={createAppRouter()} />)
    await waitFor(() => expect(window.location.hash).toBe("#/solicitar-convite?plano=pro"))
    expect(await screen.findByRole("heading", { name: /acesso por convite/i })).toBeTruthy()
    expect(screen.queryByText(/criar sua conta/i)).toBeNull()
  })

  it("whenSignupRoute_thenRedirectsToRequestInvite", async () => {
    window.location.hash = "#/signup"
    render(<RouterProvider router={createAppRouter()} />)
    await waitFor(() => expect(window.location.hash).toBe("#/solicitar-convite"))
    expect(await screen.findByRole("heading", { name: /acesso por convite/i })).toBeTruthy()
  })

  it("whenSetPasswordWithoutSession_thenRedirectsToLinkExpired", async () => {
    window.location.hash = "#/definir-senha?origem=convite"
    render(<RouterProvider router={createAppRouter()} />)
    await waitFor(() => expect(window.location.hash).toBe("#/link-expirado?motivo=sem-sessao"))
    expect(await screen.findByRole("heading", { name: /você precisa de um link válido/i })).toBeTruthy()
  })

  it("whenSessionOwnsPendingCookie_thenRedirectsToSetPasswordInvite", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "user-1", email: null } } }, error: null })
    document.cookie = "pendingPasswordSetup=user-1; Path=/"
    window.location.hash = "#/"
    render(<RouterProvider router={createAppRouter()} />)
    await waitFor(() => expect(window.location.hash).toBe("#/definir-senha?origem=convite"))
    expect(await screen.findByRole("heading", { name: /crie sua senha/i })).toBeTruthy()
  })

  it("whenPendingCookieCarriesRecovery_thenRedirectKeepsOrigin", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "user-1", email: null } } }, error: null })
    document.cookie = `pendingPasswordSetup=${encodeURIComponent("user-1:recuperacao")}; Path=/`
    window.location.hash = "#/"
    render(<RouterProvider router={createAppRouter()} />)
    await waitFor(() => expect(window.location.hash).toBe("#/definir-senha?origem=recuperacao"))
    expect(await screen.findByRole("heading", { name: /crie uma nova senha/i })).toBeTruthy()
  })

  it("whenPendingCookieBelongsToOtherUser_thenRendersProtectedChild", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "user-1", email: null } } }, error: null })
    document.cookie = "pendingPasswordSetup=user-2; Path=/"
    window.location.hash = "#/"
    render(<RouterProvider router={createAppRouter()} />)
    expect(await screen.findAllByText(/Visão Geral/i, undefined, { timeout: 10000 })).toBeTruthy()
    expect(window.location.hash).toBe("#/")
  })

  it("whenNoPendingCookie_thenRendersProtectedChild", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "user-1", email: null } } }, error: null })
    window.location.hash = "#/"
    render(<RouterProvider router={createAppRouter()} />)
    expect(await screen.findAllByText(/Visão Geral/i, undefined, { timeout: 10000 })).toBeTruthy()
    expect(window.location.hash).toBe("#/")
  })
})
