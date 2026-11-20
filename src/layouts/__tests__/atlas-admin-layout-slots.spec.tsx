// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import { RouterProvider, createMemoryRouter } from "react-router-dom"

const { useGlobalBalance } = vi.hoisted(() => ({
  useGlobalBalance: vi.fn(() => ({
    accounts: [],
    loading: false,
    error: false,
    onRetry: () => {},
  })),
}))

vi.mock("@/components/shadcn/navigation/use-global-balance", () => ({ useGlobalBalance }))

import i18n from "@/i18n"
import { AtlasAdminLayout } from "@/layouts/AtlasAdminLayout"

afterEach(async () => {
  cleanup()
  useGlobalBalance.mockClear()
  await i18n.changeLanguage("pt-BR")
})

function renderLayout(element: React.ReactElement) {
  const router = createMemoryRouter([{ element, children: [{ index: true, element: <p>rota</p> }] }])
  return render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

describe("whenLayoutReceivesSlots_thenTheyLandInsideTheInset", () => {
  it("banner vira nó sticky dentro do main, depois do header", () => {
    const { container } = renderLayout(
      <AtlasAdminLayout
        headerProps={{ showGlobalBalance: false }}
        banner={<div data-testid="banner-child">impersonation</div>}
      />,
    )

    const banner = container.querySelector('[data-slot="atlas-banner"]')
    expect(banner).not.toBeNull()
    expect(banner?.className).toContain("sticky")
    const main = container.querySelector("main")
    expect(main?.contains(banner ?? null)).toBe(true)

    const header = container.querySelector("header")
    const children = Array.from(main?.children ?? [])
    expect(children.indexOf(banner as Element)).toBeGreaterThan(
      children.indexOf(header as Element),
    )
    expect(screen.getByTestId("banner-child")).toBeTruthy()
  })

  it("sem banner nenhum nó é renderizado", () => {
    const { container } = renderLayout(
      <AtlasAdminLayout headerProps={{ showGlobalBalance: false }} />,
    )
    expect(container.querySelector('[data-slot="atlas-banner"]')).toBeNull()
  })

  it("mainId identifica o landmark <main>", () => {
    renderLayout(
      <AtlasAdminLayout mainId="internal-main" headerProps={{ showGlobalBalance: false }} />,
    )
    expect(document.querySelector("main")?.id).toBe("internal-main")
  })
})

describe("whenHeaderDisablesGlobalBalance_thenTenantHookIsNotCalled", () => {
  it("showGlobalBalance=false não chama useGlobalBalance", () => {
    renderLayout(<AtlasAdminLayout headerProps={{ showGlobalBalance: false }} />)
    expect(useGlobalBalance).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: /saldo total/i })).toBeNull()
  })
})

describe("whenSidebarPropsAreGiven_thenTenantNavigationIsReplaced", () => {
  it("navMain/navSecondary/brand/user substituem o padrão do tenant", () => {
    renderLayout(
      <AtlasAdminLayout
        headerProps={{ showGlobalBalance: false }}
        sidebarProps={{
          navMain: [{ title: "Tenants", url: "/internal/tenants", end: false }],
          navSecondary: [],
          brand: { title: "Atlas", subtitle: "Área interna", href: null },
          user: { name: "Operador", email: "••••7777", avatar: "", secondaryMono: true },
          quickCreate: null,
          userMenuItems: [],
          showPresence: false,
        }}
      />,
    )

    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "")
    expect(hrefs).toContain("/internal/tenants")
    expect(hrefs).not.toContain("/contas")
    expect(screen.queryByText(/novo lançamento/i)).toBeNull()
    expect(screen.getByText("••••7777")).toBeTruthy()
  })
})
