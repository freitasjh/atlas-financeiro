// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { RouterProvider, createMemoryRouter } from "react-router-dom"

/**
 * Regressão do H3 (P1): o runtime do guard precisa existir **antes** do
 * primeiro `verify()`. Antes a configuração morava num `useEffect` do pai, que
 * roda depois dos efeitos do filho ⇒ `runtime === null` ⇒ `error` sem rede.
 */
const h = vi.hoisted(() => {
  const verifyWire = vi.fn(async () => ({
    status: 200,
    body: { is_operator: true, aal: "aal2", user_id: "u-1" },
    failure: null,
  }))
  const sessionKey = vi.fn(async () => ({ userId: "u-1", aalKey: "aal2" as const }))
  const createInternalOperatorRuntime = vi.fn(() => ({ sessionKey, verify: verifyWire }))
  return { verifyWire, sessionKey, createInternalOperatorRuntime }
})

vi.mock("@/internal/data/operator-runtime", () => ({
  createInternalOperatorRuntime: h.createInternalOperatorRuntime,
}))

vi.mock("@/internal/data/internal-client", () => ({
  readInternalRpc: vi.fn(async (name: string) => {
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
  }),
  writeInternalRpc: vi.fn(),
  signInInternalOperator: vi.fn(),
  signOutInternalOperator: vi.fn(),
  readInternalSession: vi.fn(async () => ({ userId: "u-1", aalKey: "aal2" })),
  getInternalAccessToken: vi.fn(async () => null),
}))

import "@/i18n"
import { InternalTree } from "../internal-tree"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"

function renderTree(path: string) {
  const router = createMemoryRouter(
    [{ path: "/internal/*", element: <InternalTree /> }],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  h.verifyWire.mockClear()
  h.createInternalOperatorRuntime.mockClear()
  useInternalOperator.getState().reset()
})

afterEach(() => cleanup())

describe("whenTreeMounts_thenRuntimeIsReadyForTheFirstVerify", () => {
  it("hard load: guard verifica 1× e entra em operator", async () => {
    renderTree("/internal")

    expect(await screen.findByRole("heading", { name: /visão geral/i })).toBeTruthy()
    expect(h.verifyWire).toHaveBeenCalledTimes(1)
    expect(useInternalOperator.getState().state).toBe("operator")
  })
})
