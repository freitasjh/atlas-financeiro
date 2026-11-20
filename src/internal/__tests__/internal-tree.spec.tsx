// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"

const {
  readInternalRpc,
  writeInternalRpc,
  signInInternalOperator,
  signOutInternalOperator,
  readInternalSession,
  getInternalAccessToken,
  subscribeInternalAuthState,
} = vi.hoisted(() => ({
  readInternalRpc: vi.fn(),
  writeInternalRpc: vi.fn(),
  signInInternalOperator: vi.fn(),
  signOutInternalOperator: vi.fn(),
  readInternalSession: vi.fn(async () => ({ userId: null, aalKey: null })),
  getInternalAccessToken: vi.fn(async () => null),
  subscribeInternalAuthState: vi.fn(() => () => {}),
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
import { InternalTree } from "../internal-tree"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: "/internal/*", element: <InternalTree /> }],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  readInternalRpc.mockReset()
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
    if (name === "list_admin_audit_page") return []
    return null
  })
  useInternalOperator.setState({
    state: "operator",
    userId: "u-1",
    aalKey: "aal2",
    checkedAt: Date.now(),
    lastFailure: null,
  })
})

afterEach(() => cleanup())

describe("whenTreeIsMounted_thenEachRouteLandsOnItsPage", () => {
  it("/internal monta a home sob o shell", async () => {
    renderAt("/internal")
    expect(await screen.findByRole("heading", { name: /visão geral/i })).toBeTruthy()
    expect(screen.getAllByText(/área interna/i).length).toBeGreaterThan(0)
  })

  it("/internal/tenants monta a listagem", async () => {
    renderAt("/internal/tenants")
    expect(await screen.findByRole("heading", { name: "Tenants" })).toBeTruthy()
  })

  it("/internal/auditoria monta a trilha", async () => {
    renderAt("/internal/auditoria")
    expect(await screen.findByRole("heading", { name: "Auditoria" })).toBeTruthy()
  })

  it("/internal/telemetria monta a série", async () => {
    renderAt("/internal/telemetria")
    expect(await screen.findByRole("heading", { name: "Telemetria" })).toBeTruthy()
  })
})

describe("whenAnUnknownInternalSegmentIsOpened_thenItNeverRendersBlank", () => {
  it("/internal/foo ⇒ 404 dentro do shell (nunca página branca)", async () => {
    renderAt("/internal/foo")
    expect(await screen.findByRole("heading", { name: "404" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: /visão geral/i })).toBeNull()
  })
})

describe("whenSurfacesAreTerminal_thenTheyMountWithoutTheShell", () => {
  it("/internal/login monta sem navegação interna", () => {
    useInternalOperator.setState({
      state: "unauthenticated",
      userId: null,
      aalKey: null,
      checkedAt: null,
      lastFailure: null,
    })
    renderAt("/internal/login")
    expect(screen.getByLabelText(/e-mail/i)).toBeTruthy()
    expect(screen.queryByRole("navigation")).toBeNull()
  })

  it("/internal/acesso-negado monta a tela de estado", () => {
    renderAt("/internal/acesso-negado")
    expect(screen.getByRole("heading", { name: "Acesso restrito" })).toBeTruthy()
  })
})
