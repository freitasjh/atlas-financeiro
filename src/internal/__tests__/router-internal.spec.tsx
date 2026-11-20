// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { RouterProvider } from "react-router-dom"

const {
  readInternalRpc,
  writeInternalRpc,
  signInInternalOperator,
  signOutInternalOperator,
  readInternalSession,
  getInternalAccessToken,
  subscribeInternalAuthState,
  getSession,
} = vi.hoisted(() => ({
  readInternalRpc: vi.fn(),
  writeInternalRpc: vi.fn(),
  signInInternalOperator: vi.fn(),
  signOutInternalOperator: vi.fn(),
  readInternalSession: vi.fn(async () => ({ userId: null, aalKey: null })),
  getInternalAccessToken: vi.fn(async () => null),
  subscribeInternalAuthState: vi.fn(() => () => {}),
  getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
}))

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

vi.mock("@/internal/data/internal-client", () => ({
  readInternalRpc,
  writeInternalRpc,
  signInInternalOperator,
  signOutInternalOperator,
  readInternalSession,
  getInternalAccessToken,
  subscribeInternalAuthState,
}))

import "@/i18n"
import { createAppRouter } from "@/router"
import { useAuthStore } from "@/store/auth-store"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"

function mockInternalRpc() {
  readInternalRpc.mockImplementation(async (name: string) => {
    if (name === "admin_mrr_summary") {
      return {
        competencia: "2026-11-01",
        mrr_cents: 1000,
        active_count: 1,
        past_due_count: 0,
        overdue_cents: 0,
        overdue_count: 0,
      }
    }
    if (name === "admin_count_tenants") return 1
    if (name === "admin_usage_series") return []
    if (name === "admin_list_tenants") return []
    if (name === "admin_list_pending_invites") return []
    if (name === "admin_invite_quota") return 0
    if (name === "list_admin_audit_page") return []
    return null
  })
}

const FIND_OPTIONS = { timeout: 5000 } as const

function renderAtHash(hash: string) {
  window.location.hash = hash
  return render(<RouterProvider router={createAppRouter()} />)
}

beforeEach(() => {
  cleanup()
  readInternalRpc.mockReset()
  writeInternalRpc.mockReset()
  mockInternalRpc()
  getSession.mockReset()
  getSession.mockResolvedValue({ data: { session: null }, error: null })
  useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
  useInternalOperator.setState({
    state: "operator",
    userId: "11111111-2222-3333-4444-555566667777",
    aalKey: "aal2",
    checkedAt: Date.now(),
    lastFailure: null,
  })
})

describe("whenLegacyInternalRouteIsOpened_thenRedirectsToInternalPreservingSearchAndHash", () => {
  it("/admin?x=1#y ⇒ /internal?x=1#y", async () => {
    renderAtHash("#/admin?x=1#y")
    await waitFor(() => expect(window.location.hash).toBe("#/internal?x=1#y"), FIND_OPTIONS)
    expect(
      await screen.findByRole("heading", { name: /visão geral/i }, FIND_OPTIONS),
    ).toBeTruthy()
  })

  it("/backoffice ⇒ /internal", async () => {
    renderAtHash("#/backoffice")
    await waitFor(() => expect(window.location.hash).toBe("#/internal"), FIND_OPTIONS)
    expect(
      await screen.findByRole("heading", { name: /visão geral/i }, FIND_OPTIONS),
    ).toBeTruthy()
  })

  it("/admin/tenants?x=1 ⇒ /internal?x=1", async () => {
    renderAtHash("#/admin/tenants?x=1")
    await waitFor(() => expect(window.location.hash).toBe("#/internal?x=1"), FIND_OPTIONS)
  })
})

describe("whenInternalTreeIsOpened_thenItMountsUnderTheInternalGuard", () => {
  it("/internal/tenants monta a listagem no shell do template", async () => {
    renderAtHash("#/internal/tenants")
    expect(
      await screen.findByRole("heading", { name: "Tenants" }, FIND_OPTIONS),
    ).toBeTruthy()
    // Shell do template: âncoras internas presentes, nenhuma âncora de tenant.
    const links = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
    expect(links.some((href) => href.endsWith("/internal/tenants"))).toBe(true)
    expect(links.some((href) => href.endsWith("/contas"))).toBe(false)
    const forbidden = ["#/contas", "#/cartoes", "#/categorias", "#/orcamentos", "#/config", "#/transacoes"]
    for (const href of links) expect(forbidden).not.toContain(href)
  })

  it("/internal/acesso-negado é superfície terminal sem navegação", async () => {
    renderAtHash("#/internal/acesso-negado")
    expect(
      await screen.findByRole("heading", { name: "Acesso restrito" }, FIND_OPTIONS),
    ).toBeTruthy()
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("denied ⇒ navega para /internal/acesso-negado em vez de renderizar inline", async () => {
    useInternalOperator.setState({
      state: "denied",
      userId: null,
      aalKey: null,
      checkedAt: null,
      lastFailure: null,
    })
    renderAtHash("#/internal/tenants")

    await waitFor(
      () => expect(window.location.hash).toBe("#/internal/acesso-negado"),
      FIND_OPTIONS,
    )
    expect(
      await screen.findByRole("heading", { name: "Acesso restrito" }, FIND_OPTIONS),
    ).toBeTruthy()
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("error ⇒ hash vira #/internal/acesso-negado?motivo=indisponivel (SPEC §3.3)", async () => {
    useInternalOperator.setState({
      state: "error",
      userId: null,
      aalKey: null,
      checkedAt: null,
      lastFailure: "timeout",
    })
    renderAtHash("#/internal/tenants")

    await waitFor(
      () => expect(window.location.hash).toBe("#/internal/acesso-negado?motivo=indisponivel"),
      FIND_OPTIONS,
    )
    expect(
      await screen.findByRole("heading", { name: /verificação indisponível/i }, FIND_OPTIONS),
    ).toBeTruthy()
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("/internal/foo desconhecida ⇒ 404 no shell (teste de hash, nunca branco)", async () => {
    renderAtHash("#/internal/foo")
    expect(await screen.findByRole("heading", { name: "404" }, FIND_OPTIONS)).toBeTruthy()
    expect(window.location.hash).toBe("#/internal/foo")
  })
})
