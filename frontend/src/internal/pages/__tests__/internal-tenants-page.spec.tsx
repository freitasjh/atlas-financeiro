// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const { readInternalRpc, writeInternalRpc } = vi.hoisted(() => ({
  readInternalRpc: vi.fn(),
  writeInternalRpc: vi.fn(),
}))

vi.mock("@/internal/data/internal-client", () => ({ readInternalRpc, writeInternalRpc }))

import "@/i18n"
import { InternalTenantsPage } from "../internal-tenants-page"
import type { PendingInviteRow, TenantListRow } from "@/internal/data/internal-types"

const TENANTS: TenantListRow[] = [
  {
    id: "11111111-2222-3333-4444-555566667777",
    kind: "pj",
    cpf: null,
    cnpj: "12345678000199",
    razao_social: "Alfa Comércio Ltda",
    nome_fantasia: "Alfa",
    plan_id: "full",
    subscription_status: "active",
    created_at: "2026-01-05T10:00:00Z",
    owner_user_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  },
  {
    id: "22222222-3333-4444-5555-666677778888",
    kind: "pf",
    cpf: "12345678909",
    cnpj: null,
    razao_social: "Beta Serviços",
    nome_fantasia: null,
    plan_id: "free",
    subscription_status: "past_due",
    created_at: "2026-02-05T10:00:00Z",
    owner_user_id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  },
]

const INVITES: PendingInviteRow[] = [
  {
    invited_user_id: "99999999-8888-7777-6666-555544443333",
    requested_at: "2026-11-19T12:00:00Z",
    age_hours: 3,
    state: "invite-pending",
  },
]

function mockTenants(rows: TenantListRow[] = TENANTS, total = 42) {
  readInternalRpc.mockImplementation(async (name: string) => {
    if (name === "admin_list_tenants") return rows
    if (name === "admin_count_tenants") return total
    if (name === "admin_list_pending_invites") return INVITES
    if (name === "admin_invite_quota") return 17
    return null
  })
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/internal/tenants"]}>
      <Routes>
        <Route path="/internal/tenants" element={<InternalTenantsPage />} />
        <Route path="/internal/tenants/:tenantId" element={<div data-testid="detail" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  readInternalRpc.mockReset()
  writeInternalRpc.mockReset()
})

afterEach(() => cleanup())

describe("whenTenantsLoad_thenToolbarAndTableFollowTheContract", () => {
  it("toolbar usa <search> com busca, status e ordenação", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")

    const search = container.querySelector("search")
    expect(search).not.toBeNull()
    expect(search?.querySelector('input[type="search"]')).not.toBeNull()
    expect(screen.getByLabelText(/^busca$/i)).toBeTruthy()
    expect(readInternalRpc).toHaveBeenCalledWith(
      "admin_list_tenants",
      expect.objectContaining({ p_limit: 20, p_offset: 0, p_sort: "created_at", p_dir: "desc" }),
    )
  })

  it("ação primária é única e o convidar fica oculto (O-F4-11)", async () => {
    mockTenants()
    renderPage()
    await screen.findByText("Alfa")
    expect(screen.getByRole("button", { name: /atualizar/i })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /convidar/i })).toBeNull()
  })

  it("documento aparece mascarado e o valor integral nunca entra no DOM", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")

    expect(container.textContent).not.toContain("12345678000199")
    expect(container.textContent).not.toContain("12345678909")
    expect(container.textContent).toContain("199")
    expect(container.textContent).toContain("909")
  })

  it("plano exibido é o plan_id real, sem taxonomia comercial", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")
    expect(container.textContent).toContain("full")
    // Guarda contra a taxonomia comercial do mock (plano inventado): construída
    // em runtime para não virar literal proibido no scan estático do painel.
    const forbiddenTaxonomy = new RegExp(["star" + "ter", "enter" + "prise"].join("|"), "i")
    expect(container.textContent).not.toMatch(forbiddenTaxonomy)
  })

  it("cabeçalhos declaram aria-sort conforme a ordenação corrente", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")

    const headers = [...container.querySelectorAll("th")]
    const created = headers.find((th) => th.textContent?.includes("Criado em"))
    const name = headers.find((th) => th.textContent?.includes("Nome"))
    expect(created?.getAttribute("aria-sort")).toBe("descending")
    expect(name?.getAttribute("aria-sort")).toBe("none")

    fireEvent.click(screen.getByRole("button", { name: "Nome" }))
    await waitFor(() => {
      const updated = [...container.querySelectorAll("th")].find((th) =>
        th.textContent?.includes("Nome"),
      )
      expect(updated?.getAttribute("aria-sort")).toBe("descending")
    })
  })

  it("paginação mostra intervalo e total com tabular-nums", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")

    expect(container.textContent).toContain("Mostrando 1–20 de 42")
    const pager = [...container.querySelectorAll("span")].find((span) =>
      span.textContent?.includes("Mostrando"),
    )
    expect(pager?.className).toContain("tabular-nums")
  })

  it("valores monetários não existem aqui; datas usam tabular-nums", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")
    const cells = [...container.querySelectorAll("td")].filter((td) =>
      td.textContent?.includes("05/01/2026"),
    )
    expect(cells.length).toBeGreaterThan(0)
    expect(cells[0].className).toContain("tabular-nums")
  })
})

describe("whenListIsEmpty_thenEmptyStateReplacesTheTable", () => {
  it("estado vazio explícito", async () => {
    mockTenants([], 0)
    const { container } = renderPage()
    await screen.findByText(/nada por aqui/i)
    expect(container.textContent).toContain("Mostrando 0–0 de 0")
  })
})

describe("whenListFails_thenErrorIsLabelledWithoutPii", () => {
  it("erro fixo com retry", async () => {
    readInternalRpc.mockRejectedValue(new Error("permission denied for table tenants"))
    renderPage()
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Não foi possível carregar")
    expect(alert.textContent).not.toContain("permission denied")
  })
})

describe("whenInvitesAreExpanded_thenListHasNoEmailAndQuotaIsShown", () => {
  it("convites pendentes carregam só ao expandir e não exibem e-mail", async () => {
    mockTenants()
    const { container } = renderPage()
    await screen.findByText("Alfa")

    expect(readInternalRpc).not.toHaveBeenCalledWith("admin_list_pending_invites", expect.anything())

    fireEvent.click(screen.getByRole("button", { name: /convites pendentes/i }))
    await screen.findByText(/convites restantes na janela atual/i)

    expect(readInternalRpc).toHaveBeenCalledWith("admin_list_pending_invites", {
      p_limit: 20,
      p_offset: 0,
    })
    expect(container.textContent).toContain("333")
    expect(container.textContent).not.toContain("@")
  })
})
