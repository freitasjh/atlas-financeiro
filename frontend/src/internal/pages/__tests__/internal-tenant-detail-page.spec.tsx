// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const { readInternalRpc, writeInternalRpc } = vi.hoisted(() => ({
  readInternalRpc: vi.fn(),
  writeInternalRpc: vi.fn(),
}))

vi.mock("@/internal/data/internal-client", () => ({ readInternalRpc, writeInternalRpc }))

import "@/i18n"
import { InternalTenantDetailPage } from "../internal-tenant-detail-page"
import type {
  AdminAuditRow,
  TenantBilling,
  TenantDetailRow,
  TenantMemberRow,
  TenantOnboardingStateRow,
  TenantUsageRow,
} from "@/internal/data/internal-types"

const TENANT_ID = "11111111-2222-3333-4444-555566667777"

const DETAIL: TenantDetailRow = {
  id: TENANT_ID,
  kind: "pj",
  document: "12345678000199",
  razao_social: "Alfa Comércio Ltda",
  nome_fantasia: "Alfa",
  plan_id: "full",
  subscription_status: "past_due",
  created_at: "2026-01-05T10:00:00Z",
}

const ONBOARDING: TenantOnboardingStateRow[] = [
  { tenant_id: TENANT_ID, state: "onboarding-complete", missing: [] },
]

const USAGE: TenantUsageRow[] = [
  { resource: "transactions", used: 12, limit_max: 100 },
  { resource: "members", used: 3, limit_max: null },
]

const BILLING: TenantBilling = {
  subscription: {
    plan_slug: "full",
    status: "past_due",
    trial_ends_at: null,
    billing_day: 10,
    period_start: "2026-11-01",
    period_end: "2026-11-30",
    past_due_since: "2026-11-12",
    pending_plan_slug: null,
    pending_plan_at: null,
    cancel_at_period_end: false,
    created_at: "2026-01-05T10:00:00Z",
    updated_at: "2026-11-12T10:00:00Z",
  },
  invoices: {
    items: [
      {
        id: "inv-1",
        competencia: "2026-11-01",
        period_start: "2026-11-01",
        period_end: "2026-11-30",
        due_date: "2026-11-10",
        amount_cents: 49900,
        status: "overdue",
        paid_at: null,
        created_at: "2026-11-01T00:00:00Z",
      },
    ],
    total: 1,
  },
  usage: null,
}

const MEMBERS: TenantMemberRow[] = [
  { user_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", role: "owner", created_at: "2026-01-05T10:00:00Z" },
]

const TRAIL: AdminAuditRow[] = [
  {
    id: "a-1",
    actor_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    target_id: TENANT_ID,
    tenant_id: TENANT_ID,
    action: "other",
    from_value: null,
    to_value: null,
    reason: "internal_admin_read",
    at: "2026-11-19T12:00:00Z",
  },
]

/**
 * `admin_get_tenant` é `RETURNS TABLE` (`0042:26`) ⇒ PostgREST devolve **array**.
 * O mock segue a forma real; o objeto solto era a causa do DOM vazio no re-H3.
 */
function mockDetail(overrides: { detail?: Partial<TenantDetailRow>; onboarding?: TenantOnboardingStateRow[] } = {}) {
  readInternalRpc.mockImplementation(async (name: string) => {
    if (name === "admin_get_tenant") return [{ ...DETAIL, ...overrides.detail }]
    if (name === "admin_tenant_onboarding_state") return overrides.onboarding ?? ONBOARDING
    if (name === "get_tenant_usage") return USAGE
    if (name === "admin_get_tenant_billing") return BILLING
    if (name === "admin_list_members") return MEMBERS
    if (name === "list_admin_audit_page") return TRAIL
    return null
  })
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/internal/tenants/${TENANT_ID}`]}>
      <Routes>
        <Route path="/internal/tenants/:tenantId" element={<InternalTenantDetailPage />} />
        <Route path="/internal/tenants" element={<div data-testid="list" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  readInternalRpc.mockReset()
  writeInternalRpc.mockReset()
})

afterEach(() => cleanup())

describe("whenTenantDetailLoads_thenHeaderTracesToTheRpc", () => {
  it("cabeçalho, plano real e documento mascarado", async () => {
    mockDetail()
    const { container } = renderPage()
    await screen.findByRole("heading", { name: "Alfa" })

    expect(container.textContent).toContain("Alfa Comércio Ltda")
    expect(container.textContent).toContain("full")
    expect(container.textContent).not.toContain("12345678000199")
    expect(container.textContent).toContain("199")
    expect(readInternalRpc).toHaveBeenCalledWith("admin_get_tenant", { p_tenant: TENANT_ID })
  })

  it("array de RETURNS TABLE preenche tipo, status e Criado em (nunca DOM vazio)", async () => {
    mockDetail()
    const { container } = renderPage()
    await screen.findByRole("heading", { name: "Alfa" })

    expect(container.textContent).toContain("pj")
    expect(container.textContent).toContain("05/01/2026")
    expect(screen.getByText("Em atraso")).toBeTruthy()
  })

  it("banner de past_due aparece quando a RPC indica", async () => {
    mockDetail()
    renderPage()
    expect(await screen.findByText(/assinatura em atraso/i)).toBeTruthy()
  })

  it("banner de cancelado aparece quando o status é canceled", async () => {
    mockDetail({ detail: { subscription_status: "canceled" } })
    renderPage()
    expect(await screen.findByText(/assinatura cancelada/i)).toBeTruthy()
  })

  it("banner de drift lista as peças ausentes", async () => {
    mockDetail({
      onboarding: [
        { tenant_id: TENANT_ID, state: "tenant-provision-failed", missing: ["membership", "acceptance"] },
      ],
    })
    const { container } = renderPage()
    expect(await screen.findByText(/onboarding incompleto/i)).toBeTruthy()
    expect(container.textContent).toContain("membership, acceptance")
  })
})

describe("whenTabsAreUsed_thenEachOneReadsItsOwnRpc", () => {
  it("declara as 5 abas", async () => {
    mockDetail()
    renderPage()
    await screen.findByRole("heading", { name: "Alfa" })
    expect(screen.getAllByRole("tab")).toHaveLength(5)
  })

  it("whenViewportIsSmall_thenEachTabKeepsA44pxTouchTarget", async () => {
    mockDetail()
    renderPage()
    await screen.findByRole("heading", { name: "Alfa" })

    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(5)
    for (const tab of tabs) {
      expect(tab.className).toMatch(/max-md:min-h-11/)
    }
    // A lista precisa crescer junto: altura fixa de 36px recortaria o alvo.
    const list = screen.getAllByRole("tab")[0].parentElement
    expect(list?.className ?? "").toMatch(/max-md:group-data-\[orientation=horizontal\]\/tabs:h-auto/)
  })

  it("aba Uso consulta get_tenant_usage com o tenant da rota", async () => {
    mockDetail()
    renderPage()
    await screen.findByRole("heading", { name: "Alfa" })

    fireEvent.mouseDown(screen.getByRole("tab", { name: /uso/i }), { button: 0 })

    expect(await screen.findByText("transactions")).toBeTruthy()
    expect(readInternalRpc).toHaveBeenCalledWith("get_tenant_usage", { p_tenant: TENANT_ID })
    const gauge = screen.getByRole("progressbar")
    expect(gauge.getAttribute("aria-valuenow")).toBe("12")
  })

  it("aba Faturamento avisa o cap de 50 faturas e formata o valor", async () => {
    mockDetail()
    const { container } = renderPage()
    await screen.findByRole("heading", { name: "Alfa" })

    fireEvent.mouseDown(screen.getByRole("tab", { name: /faturamento/i }), { button: 0 })

    expect(await screen.findByText(/no máximo 50 são listadas/i)).toBeTruthy()
    expect(container.textContent).toContain("499,00")
    expect(container.textContent).not.toContain("usage")
  })
})

describe("whenSensitiveActionOpens_thenConsequenceAndReasonAreRequired", () => {
  it("alterar assinatura exige motivo e declara a consequência", async () => {
    mockDetail()
    renderPage()
    await screen.findByRole("heading", { name: "Alfa" })

    fireEvent.click(screen.getByRole("button", { name: /alterar assinatura/i }))

    expect(await screen.findByRole("heading", { name: /alterar assinatura/i })).toBeTruthy()
    expect(screen.getByText(/fica registrada na trilha com o motivo informado/i)).toBeTruthy()

    const confirm = screen.getByRole("button", { name: /aplicar alteração/i }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/^motivo$/i), { target: { value: "ajuste contrato" } })
    expect((screen.getByRole("button", { name: /aplicar alteração/i }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it("reparar onboarding não promete recriar, apagar ou conceder trial", async () => {
    mockDetail({
      onboarding: [{ tenant_id: TENANT_ID, state: "tenant-provision-failed", missing: ["acceptance"] }],
    })
    renderPage()
    await screen.findByText(/onboarding incompleto/i)

    fireEvent.click(screen.getByRole("button", { name: /reparar onboarding/i }))

    const consequence = await screen.findByText(/não recria dados, não apaga nada e não concede trial/i)
    expect(consequence).toBeTruthy()
  })
})
