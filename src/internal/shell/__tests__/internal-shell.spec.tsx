// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RouterProvider, createMemoryRouter } from "react-router-dom"

const { signOutInternalOperator, useGlobalBalance, listAccounts } = vi.hoisted(() => ({
  signOutInternalOperator: vi.fn(),
  useGlobalBalance: vi.fn(() => ({
    accounts: [],
    loading: false,
    error: false,
    onRetry: () => {},
  })),
  listAccounts: vi.fn(async () => []),
}))

vi.mock("@/internal/data/internal-client", () => ({ signOutInternalOperator }))
// Dado de tenant: o slot de saldo global não pode nem chamar o hook no interno.
vi.mock("@/components/shadcn/navigation/use-global-balance", () => ({ useGlobalBalance }))
vi.mock("@/modules/accounts/service/accounts.service", () => ({
  listAccounts,
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
}))
vi.mock("@/store/auth-store", () => ({
  useAuthStore: (selector?: (state: unknown) => unknown) => {
    const state = { signOut: vi.fn(async () => {}) }
    return typeof selector === "function" ? selector(state) : state
  },
}))

import "@/i18n"
import { InternalShell } from "../internal-shell"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"

const OPERATOR_ID = "11111111-2222-3333-4444-555566667777"

function renderShell(initialEntry = "/internal") {
  const router = createMemoryRouter(
    [
      {
        path: "/internal",
        element: <InternalShell />,
        children: [
          { index: true, element: <div data-testid="shell-child" /> },
          { path: "tenants/:tenantId", element: <div data-testid="tenant-child" /> },
          { path: "*", element: <div data-testid="not-found" /> },
        ],
      },
      { path: "/internal/login", element: <div data-testid="login" /> },
    ],
    { initialEntries: [initialEntry] },
  )
  return render(<RouterProvider router={router} />)
}

function linkHrefs(): string[] {
  return screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "")
}

beforeEach(() => {
  useInternalOperator.setState({
    state: "operator",
    userId: OPERATOR_ID,
    aalKey: "aal2",
    checkedAt: 1,
    lastFailure: null,
  })
  signOutInternalOperator.mockReset()
  signOutInternalOperator.mockResolvedValue(undefined)
  useGlobalBalance.mockClear()
  listAccounts.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("whenShellRenders_thenItComposesTheTemplateShell", () => {
  it("monta sidebar + header do template, sem rail/topbar/bottom-nav próprios", () => {
    const { container } = renderShell()

    expect(container.querySelector('[data-slot="sidebar"]')).not.toBeNull()
    expect(container.querySelector("header")).not.toBeNull()
    expect(container.querySelector('[data-sidebar="trigger"]')).not.toBeNull()
    // rail recolhível próprio e bottom-nav fixa deixaram de existir
    expect(container.querySelector("[data-collapsed]")).toBeNull()
    const fixedNavs = Array.from(container.querySelectorAll("nav")).filter((nav) =>
      nav.className.includes("fixed"),
    )
    expect(fixedNavs).toHaveLength(0)
  })

  it("expõe exatamente 4 âncoras internas e nenhum href de tenant", () => {
    const { container } = renderShell()

    const internal = linkHrefs().filter((href) => href.startsWith("/internal"))
    expect(internal).toEqual([
      "/internal",
      "/internal/tenants",
      "/internal/auditoria",
      "/internal/telemetria",
    ])

    const forbidden = ["/contas", "/cartoes", "/categorias", "/orcamentos", "/config", "/transacoes"]
    for (const href of linkHrefs()) {
      expect(href.startsWith("#/")).toBe(false)
      expect(forbidden).not.toContain(href)
    }

    expect(container.querySelectorAll("select")).toHaveLength(0)
    expect(container.querySelector('[role="combobox"]')).toBeNull()
  })

  it("não renderiza os mocks do template (novo lançamento, inbox, notificações)", () => {
    const { container } = renderShell()
    const text = container.textContent ?? ""

    expect(text).not.toMatch(/novo lançamento/i)
    expect(text).not.toMatch(/caixa de entrada/i)
    expect(text).not.toMatch(/faturamento/i)
    expect(text).not.toMatch(/notificações/i)
  })

  it("mostra o chip aal2 (tabular-nums) e a identidade mascarada no footer", () => {
    const { container } = renderShell()

    const chip = screen.getByText("aal2")
    expect(chip.className).toContain("tabular-nums")
    expect(container.textContent).toContain("Segundo fator (AAL)")
    expect(container.textContent).toContain("Operador")
    expect(container.textContent).toContain("••••7777")
    expect(container.textContent).not.toContain(OPERATOR_ID)
  })

  it("não chama useGlobalBalance nem carrega contas do tenant", () => {
    renderShell()

    expect(useGlobalBalance).not.toHaveBeenCalled()
    expect(listAccounts).not.toHaveBeenCalled()
  })

  it("sem F7 não existe nó de banner de impersonation", () => {
    const { container } = renderShell()

    expect(container.querySelector('[data-slot="internal-impersonation-banner"]')).toBeNull()
    expect(container.querySelector('[data-slot="atlas-banner"]')).toBeNull()
  })

  it("monta o filho da rota e o breadcrumb da área interna", () => {
    renderShell()

    expect(screen.getByTestId("shell-child")).toBeTruthy()
    expect(screen.getAllByText(/área interna/i).length).toBeGreaterThan(0)
  })

  it("whenShellIsMobile_thenTheSidebarTriggerIsTranslatedAnd44px", () => {
    const { container } = renderShell()
    const trigger = container.querySelector<HTMLElement>('[data-sidebar="trigger"]')

    expect(trigger).not.toBeNull()
    expect(trigger?.className ?? "").toMatch(/max-md:min-h-11/)
    expect(trigger?.className ?? "").toMatch(/max-md:min-w-11/)
    expect(screen.getByRole("button", { name: /alternar menu lateral/i })).toBeTruthy()
    expect(container.textContent ?? "").not.toMatch(/toggle sidebar/i)
  })
})

describe("whenInternalShellRenders_thenAtlasContentHasHorizontalPadding", () => {
  it("aplica px-4 lg:px-6 no wrapper de conteúdo, alinhando com o SiteHeader", () => {
    renderShell()

    const content = screen.getByTestId("atlas-content")
    const classes = (content.className ?? "").split(/\s+/)

    expect(classes).toEqual(expect.arrayContaining(["flex", "flex-col", "gap-6", "px-4", "lg:px-6"]))
    // padding entra no conteúdo do template, não em wrapper próprio da página
    expect(content.contains(screen.getByTestId("shell-child"))).toBe(true)
  })
})

describe("whenRouteChanges_thenTheActiveInternalItemIsExact", () => {
  it("em /internal/tenants/:id só Tenants fica aria-current=page", () => {
    const { container } = renderShell("/internal/tenants/abc")

    const active = Array.from(container.querySelectorAll('a[aria-current="page"]'))
    expect(active).toHaveLength(1)
    expect(active[0].getAttribute("href")).toBe("/internal/tenants")
    expect(screen.getByTestId("tenant-child")).toBeTruthy()
  })

  it("em rota desconhecida nenhum item fica ativo", () => {
    const { container } = renderShell("/internal/foo")

    expect(container.querySelectorAll('a[aria-current="page"]')).toHaveLength(0)
    expect(screen.getByTestId("not-found")).toBeTruthy()
  })
})

describe("whenSignOutIsConfirmed_thenSessionEndsAndNavigates", () => {
  it("Sair no menu do operador abre a confirmação e encerra a sessão", async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole("button", { name: /operador/i }))

    // o menu do operador não traz os mocks de conta/faturamento/notificações
    expect(screen.queryByRole("menuitem", { name: /faturamento/i })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: /notificações/i })).toBeNull()

    await user.click(await screen.findByRole("menuitem", { name: /sair/i }))

    expect(await screen.findByRole("heading", { name: /encerrar sessão/i })).toBeTruthy()
    expect(screen.getByText(/sessão do aplicativo do seu tenant não é afetada/i)).toBeTruthy()

    const buttons = screen.getAllByRole("button", { name: /encerrar sessão/i })
    fireEvent.click(buttons[buttons.length - 1])

    await waitFor(() => expect(signOutInternalOperator).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId("login")).toBeTruthy()
  })
})
