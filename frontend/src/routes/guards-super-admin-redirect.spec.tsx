// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const { from, getSession } = vi.hoisted(() => ({
  from: vi.fn(),
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
    from,
  },
}))

// Boot pendurado de propósito: o teste controla a transição via `signIn`.
vi.mock("@/session/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/session/session")>()
  return { ...actual, refreshCheck: vi.fn(() => new Promise(() => {})) }
})

import "@/i18n"
import { RequireSession } from "@/routes/guards"
import { useAuthStore } from "@/store/auth-store"

type Builder = {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  maybeSingle?: ReturnType<typeof vi.fn>
}

function mockRoleQuery(role: string | null, options: { pending?: boolean } = {}): void {
  const builder: Builder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  }
  builder.select.mockReturnValue(builder)
  builder.eq.mockReturnValue(builder)
  builder.single.mockImplementation(() => {
    if (options.pending) return new Promise(() => {})
    return Promise.resolve({ data: role === null ? null : { role }, error: null })
  })
  from.mockImplementation(() => builder)
}

let tenantRenderCount = 0

function TenantSpy() {
  tenantRenderCount += 1
  return <div data-testid="tenant" />
}

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/internal" element={<div data-testid="internal" />} />
        <Route path="/login" element={<div data-testid="login" />} />
        <Route
          path="*"
          element={
            <RequireSession>
              <TenantSpy />
            </RequireSession>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

function startLoading(): void {
  useAuthStore.setState({ status: "loading", initialized: false, user: null, error: null })
}

function signIn(user: { id: string; email: string | null; role?: string | null }): void {
  act(() => {
    useAuthStore.setState({ status: "authenticated", initialized: true, user, error: null })
  })
}

describe("RequireSession — redirect de super_admin para o control plane", () => {
  beforeEach(() => {
    cleanup()
    tenantRenderCount = 0
    from.mockReset()
    getSession.mockReset()
    // Boot pendurado de propósito: o teste controla a transição de sessão via
    // `signIn`, sem `init()` sobrescrevendo o estado.
    getSession.mockImplementation(() => new Promise(() => {}))
    document.cookie = "pendingPasswordSetup=; Max-Age=0; Path=/"
    startLoading()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("enquanto o papel não resolve, não renderiza o tenant (sem flash de dashboard)", async () => {
    mockRoleQuery(null, { pending: true })
    renderGuard()

    signIn({ id: "admin-1", email: "admin@esticagrana.com" })

    // O tenant nunca pode ser commitado enquanto o papel não foi resolvido —
    // nem por um frame. Na implementação antiga, `roleResolved` initializer
    // ficava `true` quando `user` era nulo no mount e o guard renderizava o
    // dashboard antes do efeito buscar `profiles.role`.
    expect(tenantRenderCount).toBe(0)
    expect(screen.queryByTestId("tenant")).toBeNull()
    expect(screen.queryByTestId("internal")).toBeNull()
    expect(screen.getByRole("status")).toBeTruthy()
  })

  it("redireciona super_admin para /internal quando o papel resolve", async () => {
    mockRoleQuery("super_admin")
    renderGuard()

    signIn({ id: "admin-1", email: "admin@esticagrana.com" })

    await waitFor(() => {
      expect(screen.getByTestId("internal")).toBeTruthy()
    })
    expect(screen.queryByTestId("tenant")).toBeNull()
  })

  it("mantém usuário comum no tenant", async () => {
    mockRoleQuery("user")
    renderGuard()

    signIn({ id: "demo-1", email: "demo@esticagrana.com" })

    await waitFor(() => {
      expect(screen.getByTestId("tenant")).toBeTruthy()
    })
    expect(screen.queryByTestId("internal")).toBeNull()
  })

  it("redireciona sem consultar profiles quando user.role já é super_admin", () => {
    renderGuard()

    signIn({ id: "admin-1", email: null, role: "super_admin" })

    expect(screen.getByTestId("internal")).toBeTruthy()
    expect(from).not.toHaveBeenCalled()
  })

  it("mantém no tenant quando user.role já é user", () => {
    renderGuard()

    signIn({ id: "demo-1", email: null, role: "user" })

    expect(screen.getByTestId("tenant")).toBeTruthy()
    expect(from).not.toHaveBeenCalled()
  })
})
