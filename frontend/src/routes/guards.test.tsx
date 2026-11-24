// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() } },
}))

import i18n from "@/i18n"
import { RequireSession } from "@/routes/guards"
import { useAuthStore } from "@/store/auth-store"

describe("guards", () => {
  beforeEach(() => {
    cleanup()
    useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
  })

  it("authenticated renders child", () => {
    useAuthStore.setState({ status: "authenticated", initialized: true, user: { id: "u1", email: null } })
    render(
      <MemoryRouter>
        <RequireSession>
          <div data-testid="child" />
        </RequireSession>
      </MemoryRouter>,
    )
    expect(screen.getByTestId("child")).toBeTruthy()
  })

  it("unauthenticated redirects to /login", () => {
    useAuthStore.setState({ status: "unauthenticated", initialized: true, user: null })
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/login" element={<div data-testid="login" />} />
          <Route path="*" element={<RequireSession><div data-testid="child" /></RequireSession>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId("login")).toBeTruthy()
  })

  it("whenLoading_thenSkeletonIsVisible", () => {
    useAuthStore.setState({ status: "loading", initialized: false })
    render(
      <MemoryRouter>
        <RequireSession>
          <div data-testid="child" />
        </RequireSession>
      </MemoryRouter>,
    )
    const status = screen.getByRole("status")
    expect(status).toBeTruthy()
    // Conteúdo visível (não apenas sr-only) e placeholder Skeleton presente.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(status.textContent).toContain("Carregando")
  })

  it("whenInitFails_thenErrorStateWithRetry", () => {
    useAuthStore.setState({ status: "error", initialized: true, error: "Falha ao carregar sessão" })
    const spy = vi.spyOn(useAuthStore.getState(), "retryInit")
    render(
      <MemoryRouter>
        <RequireSession>
          <div data-testid="child" />
        </RequireSession>
      </MemoryRouter>,
    )
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(screen.getByText(i18n.t("shell.guardErrorTitle"))).toBeTruthy()
    expect(screen.getByText(/Falha ao carregar sessão/)).toBeTruthy()
    expect(screen.getByText(/Verifique sua conexão/)).toBeTruthy()
    const retry = screen.getByRole("button", { name: i18n.t("common.retry") })
    retry.click()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it("whenErrorWithoutMessage_thenFallbackFromI18n", () => {
    useAuthStore.setState({ status: "error", initialized: true, error: null })
    render(
      <MemoryRouter>
        <RequireSession>
          <div data-testid="child" />
        </RequireSession>
      </MemoryRouter>,
    )
    expect(screen.getByText(/Ocorreu um erro inesperado/)).toBeTruthy()
  })

  it("whenError_thenChildNotRendered", () => {
    useAuthStore.setState({ status: "error", initialized: true, error: "Falha ao carregar sessão" })
    render(
      <MemoryRouter>
        <RequireSession>
          <div data-testid="child" />
        </RequireSession>
      </MemoryRouter>,
    )
    expect(screen.queryByTestId("child")).toBeNull()
  })
})