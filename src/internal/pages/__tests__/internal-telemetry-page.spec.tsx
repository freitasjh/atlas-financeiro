// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const { readInternalRpc } = vi.hoisted(() => ({ readInternalRpc: vi.fn() }))

vi.mock("@/internal/data/internal-client", () => ({ readInternalRpc, writeInternalRpc: vi.fn() }))

import "@/i18n"
import { InternalTelemetryPage } from "../internal-telemetry-page"
import { RequireInternalOperator } from "@/internal/guard/RequireInternalOperator"
import {
  configureOperatorRuntime,
  useInternalOperator,
} from "@/internal/guard/use-internal-operator"
import type { UsageSeriesRow } from "@/internal/data/internal-types"

const SERIES: UsageSeriesRow[] = [
  { competencia: "2026-10-01", tenant_id: "11111111-2222-3333-4444-555566667777", events: 4 },
  { competencia: "2026-11-01", tenant_id: "11111111-2222-3333-4444-555566667777", events: 5 },
  { competencia: "2026-11-01", tenant_id: "22222222-3333-4444-5555-666677778888", events: 6 },
]

beforeEach(() => {
  readInternalRpc.mockReset()
})

afterEach(() => {
  cleanup()
  configureOperatorRuntime(null)
})

describe("whenSeriesLoads_thenTotalsComeFromTheRpc", () => {
  it("soma eventos por competência sem inventar métrica", async () => {
    readInternalRpc.mockResolvedValue(SERIES)
    const { container } = render(<InternalTelemetryPage />)
    await screen.findAllByText("01/11/2026")

    expect(readInternalRpc).toHaveBeenCalledWith("admin_usage_series", {})
    expect(container.textContent).toContain("11")
    expect(container.textContent).toContain("4")
    expect(container.textContent).not.toMatch(/%/)
  })

  it("tenant aparece mascarado, nunca com UUID completo", async () => {
    readInternalRpc.mockResolvedValue(SERIES)
    const { container } = render(<InternalTelemetryPage />)
    await screen.findAllByText("01/11/2026")
    expect(container.textContent).not.toContain("11111111-2222-3333-4444-555566667777")
    expect(container.textContent).toContain("7777")
  })
})

describe("whenSeriesIsEmpty_thenEmptyStateIsHonest", () => {
  it("base vazia mostra estado vazio, não número inventado", async () => {
    readInternalRpc.mockResolvedValue([])
    render(<InternalTelemetryPage />)
    expect(await screen.findByText(/sem eventos/i)).toBeTruthy()
  })

  it("erro com retry", async () => {
    readInternalRpc.mockRejectedValue(new Error("boom"))
    render(<InternalTelemetryPage />)
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Não foi possível carregar")
  })
})

describe("whenHealthIsMeasured_thenItIsClientObservedNotFabricated", () => {
  /** A página real vive sob o guard: a revalidação não pode desmontá-la. */
  function renderGuarded() {
    return render(
      <MemoryRouter initialEntries={["/internal/telemetria"]}>
        <Routes>
          <Route
            path="/internal/telemetria"
            element={
              <RequireInternalOperator>
                <InternalTelemetryPage />
              </RequireInternalOperator>
            }
          />
          <Route path="/internal/login" element={<div data-testid="login" />} />
          <Route path="/internal/mfa" element={<div data-testid="mfa" />} />
          <Route path="/internal/acesso-negado" element={<div data-testid="denied" />} />
          <Route path="/definir-senha" element={<div data-testid="set-password" />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it("medir agora registra veredito e latência reais", async () => {
    readInternalRpc.mockResolvedValue(SERIES)
    configureOperatorRuntime({
      sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
      verify: async () => ({
        status: 200,
        body: { is_operator: true, aal: "aal2", user_id: "u-1" },
        failure: null,
      }),
    })
    useInternalOperator.setState({
      state: "operator",
      userId: "u-1",
      aalKey: "aal2",
      checkedAt: 1,
      lastFailure: null,
    })

    const { container } = renderGuarded()
    await screen.findAllByText("01/11/2026")

    expect(container.textContent).toContain("Nenhuma medição nesta sessão")

    fireEvent.click(screen.getByRole("button", { name: /medir agora/i }))

    expect(await screen.findByText("operator")).toBeTruthy()
    expect(container.textContent).toContain("ms")
    // A revalidação em background não troca a página pelo skeleton: o sample
    // local (estado do componente) precisa sobreviver.
    expect(screen.queryByText(/verificando acesso/i)).toBeNull()
    expect(screen.getByRole("heading", { name: /telemetria/i })).toBeTruthy()
    expect(container.textContent).not.toMatch(/disponibilidade|99,9/i)
  })
})
