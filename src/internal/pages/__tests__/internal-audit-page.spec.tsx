// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const { readInternalRpc } = vi.hoisted(() => ({ readInternalRpc: vi.fn() }))

vi.mock("@/internal/data/internal-client", () => ({ readInternalRpc, writeInternalRpc: vi.fn() }))

import "@/i18n"
import { InternalAuditPage } from "../internal-audit-page"
import type { AdminAuditRow } from "@/internal/data/internal-types"

const ROWS: AdminAuditRow[] = [
  {
    id: "a-1",
    actor_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    target_id: "11111111-2222-3333-4444-555566667777",
    tenant_id: "11111111-2222-3333-4444-555566667777",
    action: "change_plan",
    from_value: "free",
    to_value: "full",
    reason: "contrato assinado",
    at: "2026-11-19T12:00:00Z",
  },
]

beforeEach(() => {
  readInternalRpc.mockReset()
})

afterEach(() => cleanup())

describe("whenAuditLoads_thenTimelineIsPaged", () => {
  it("renderiza ação, motivo e ator mascarado", async () => {
    readInternalRpc.mockResolvedValue(ROWS)
    const { container } = render(<InternalAuditPage />)
    await screen.findByText("change_plan")

    expect(container.textContent).toContain("contrato assinado")
    expect(container.textContent).toContain("free → full")
    expect(container.textContent).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    expect(container.textContent).toContain("eeee")
    expect(readInternalRpc).toHaveBeenCalledWith("list_admin_audit_page", {
      p_action: null,
      p_limit: 20,
      p_offset: 0,
    })
  })

  it("não oferece filtro por data: a RPC não aceita", async () => {
    readInternalRpc.mockResolvedValue(ROWS)
    const { container } = render(<InternalAuditPage />)
    await screen.findByText("change_plan")
    expect(container.querySelector('input[type="date"]')).toBeNull()
    expect(container.textContent).not.toMatch(/data inicial|data final/i)
  })

  it("paginação sem total inventado: só a página corrente", async () => {
    readInternalRpc.mockResolvedValue(ROWS)
    const { container } = render(<InternalAuditPage />)
    await screen.findByText("change_plan")
    expect(container.textContent).toContain("Página 1")
    expect(container.textContent).not.toMatch(/de \d+/)
  })
})

describe("whenAuditIsEmptyOrFails_thenStatesAreExplicit", () => {
  it("vazio explícito", async () => {
    readInternalRpc.mockResolvedValue([])
    render(<InternalAuditPage />)
    expect(await screen.findByText(/sem registros/i)).toBeTruthy()
  })

  it("erro sem PII", async () => {
    readInternalRpc.mockRejectedValue(new Error("rls denied for tenant 1111"))
    render(<InternalAuditPage />)
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Não foi possível carregar")
    expect(alert.textContent).not.toContain("rls denied")
  })
})

describe("whenActionFilterChanges_thenOffsetResets", () => {
  it("filtro por ação reconsulta com p_action", async () => {
    readInternalRpc.mockResolvedValue(ROWS)
    render(<InternalAuditPage />)
    await screen.findByText("change_plan")
    expect(screen.getByLabelText(/ação/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/ação/i))
    expect(readInternalRpc).toHaveBeenCalledTimes(1)
  })
})
