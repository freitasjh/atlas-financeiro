// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

const { readInternalRpc, recoveryCodesService } = vi.hoisted(() => ({
  readInternalRpc: vi.fn(),
  recoveryCodesService: {
    generate: vi.fn(),
    status: vi.fn(),
    regenerate: vi.fn(),
  },
}))

vi.mock("@/internal/data/internal-client", () => ({ readInternalRpc, writeInternalRpc: vi.fn() }))
vi.mock("@/internal/data/mfa-recovery-codes.service", () => ({ recoveryCodesService }))

import "@/i18n"
import { InternalHomePage } from "../internal-home-page"
import type { MrrSummary, UsageSeriesRow } from "@/internal/data/internal-types"

const SUMMARY: MrrSummary = {
  competencia: "2026-11-01",
  mrr_cents: 1234567,
  active_count: 7,
  past_due_count: 2,
  overdue_cents: 50000,
  overdue_count: 3,
}

const SERIES: UsageSeriesRow[] = [
  { competencia: "2026-10-01", tenant_id: "t-1", events: 4 },
  { competencia: "2026-11-01", tenant_id: "t-1", events: 5 },
  { competencia: "2026-11-01", tenant_id: "t-2", events: 6 },
]

function mockHome() {
  readInternalRpc.mockImplementation(async (name: string) => {
    if (name === "admin_mrr_summary") return SUMMARY
    if (name === "admin_count_tenants") return 42
    if (name === "admin_usage_series") return SERIES
    return null
  })
}

beforeEach(() => {
  readInternalRpc.mockReset()
  recoveryCodesService.status.mockReset()
  recoveryCodesService.regenerate.mockReset()
  recoveryCodesService.status.mockResolvedValue({
    ok: true,
    data: {
      total: 10,
      remaining: 2,
      low: true,
      codes: Array.from({ length: 10 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        used_at: index < 8 ? "2026-11-21T00:00:00Z" : null,
      })),
    },
  })
})

afterEach(() => cleanup())

describe("whenMrrSummaryLoads_thenEachKpiComesFromTheRpc", () => {
  it("renderiza os 4 KPIs com os valores exatos da RPC", async () => {
    mockHome()
    const { container } = render(<InternalHomePage />)

    await screen.findByText(/assinaturas ativas/i)

    expect(container.textContent).toContain("12.345,67")
    expect(container.textContent).toContain("500,00")
    expect(container.textContent).toContain("01/11/2026")
    const kpis = container.querySelectorAll(".font-mono.tabular-nums")
    expect(kpis.length).toBeGreaterThanOrEqual(4)
    expect(readInternalRpc).toHaveBeenCalledWith("admin_mrr_summary", {})
  })

  it("não inventa percentual nem variação", async () => {
    mockHome()
    const { container } = render(<InternalHomePage />)
    await screen.findByText(/assinaturas ativas/i)
    expect(container.textContent).not.toMatch(/%/)
    expect(container.textContent).not.toMatch(/vs\.|anterior|projeção/i)
  })

  it("contexto operacional usa count_tenants e a competência mais recente", async () => {
    mockHome()
    const { container } = render(<InternalHomePage />)
    await screen.findByText(/tenants cadastrados/i)
    expect(container.textContent).toContain("42")
    // 5 + 6 eventos da competência mais recente (2026-11-01)
    expect(container.textContent).toContain("11")
  })
})

describe("whenSummaryFails_thenErrorStateOffersExplicitRetry", () => {
  it("erro rotulado sem PII", async () => {
    readInternalRpc.mockRejectedValue(new Error("boom"))
    const { container } = render(<InternalHomePage />)

    const alerts = await screen.findAllByRole("alert")
    expect(alerts[0].textContent).toContain("Não foi possível carregar")
    expect(alerts[0].textContent).not.toContain("boom")
    expect(container.textContent).toContain("Tentar novamente")
  })
})

describe("whenRecoveryManagementOpens_thenStatusAndRevocationAreFetchedFromTheInternalEdge", () => {
  it("gestão exibe X/10, banner ≤2 e códigos usados", async () => {
    mockHome()
    render(<InternalHomePage />)
    await screen.findByText(/assinaturas ativas/i)

    fireEvent.click(
      screen.getByRole("button", { name: /gerenciar códigos de recuperação/i }),
    )

    expect(await screen.findByText(/2 de 10 códigos restantes/i)).toBeTruthy()
    expect(screen.getByRole("status").textContent).toMatch(/restam 2/i)
    expect(screen.getAllByText("(Usado)")).toHaveLength(8)
    expect(recoveryCodesService.status).toHaveBeenCalledTimes(1)
  })

  it("regeneração envia confirmação textual e exibe nova lista uma vez", async () => {
    mockHome()
    const codes = Array.from(
      { length: 10 },
      (_, row) =>
        Array.from({ length: 24 }, (_, column) =>
          "abcdefghijklmnopqrstuvwxyz"[(row + column) % 26],
        ).join(""),
    )
    recoveryCodesService.regenerate.mockResolvedValue({
      ok: true,
      data: { set_id: "00000000-0000-4000-8000-000000000009", codes },
    })
    render(<InternalHomePage />)
    await screen.findByText(/assinaturas ativas/i)

    fireEvent.click(screen.getByRole("button", { name: /gerenciar códigos de recuperação/i }))
    await screen.findByText(/2 de 10 códigos restantes/i)
    fireEvent.click(screen.getByRole("button", { name: /gerar novos códigos/i }))
    fireEvent.change(screen.getByLabelText(/digite revogar_codigos_atuais/i), {
      target: { value: "REVOGAR_CODIGOS_ATUAIS" },
    })
    fireEvent.click(screen.getByRole("button", { name: /revogar e gerar/i }))

    expect(await screen.findByText(/novos códigos de recuperação/i)).toBeTruthy()
    expect(recoveryCodesService.regenerate).toHaveBeenCalledWith("REVOGAR_CODIGOS_ATUAIS")
    expect(screen.getByText("abcd-efgh-ijkl-mnop-qrst-uvwx")).toBeTruthy()
  })
})

describe("whenDataIsEmpty_thenZeroIsShownHonestly", () => {
  it("base vazia devolve zero, não mock", async () => {
    readInternalRpc.mockImplementation(async (name: string) => {
      if (name === "admin_mrr_summary") {
        return {
          competencia: "2026-11-01",
          mrr_cents: 0,
          active_count: 0,
          past_due_count: 0,
          overdue_cents: 0,
          overdue_count: 0,
        }
      }
      if (name === "admin_count_tenants") return 0
      if (name === "admin_usage_series") return []
      return null
    })
    const { container } = render(<InternalHomePage />)
    await screen.findByText(/tenants cadastrados/i)
    expect(container.textContent).toContain("0,00")
  })
})
