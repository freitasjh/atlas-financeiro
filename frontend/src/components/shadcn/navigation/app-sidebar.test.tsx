// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"

import "@/i18n"
import { SidebarProvider } from "@/components/shadcn/ui/sidebar"
import { AppSidebar } from "./app-sidebar"

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderSidebar(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider>
        <AppSidebar />
        <LocationProbe />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

describe("whenSidebarItemClicked_thenRouterNavigates", () => {
  afterEach(cleanup)

  it("clicar em Contas navega para /contas (sem onSelectView)", async () => {
    const user = userEvent.setup()
    renderSidebar("/")

    const link = screen.getByRole("link", { name: /contas/i })
    expect(link.getAttribute("href")).toBe("/contas")

    await user.click(link)

    expect(screen.getByTestId("location").textContent).toBe("/contas")
  })

  it("clicar em Transações navega para /transacoes", async () => {
    const user = userEvent.setup()
    renderSidebar("/")

    await user.click(screen.getByRole("link", { name: /transações/i }))

    expect(screen.getByTestId("location").textContent).toBe("/transacoes")
  })

})

describe("whenRouteMatches_thenItemIsCurrentPage", () => {
  beforeEach(() => {
    cleanup()
  })

  it("em / o item Visão geral recebe aria-current=page", () => {
    renderSidebar("/")
    const link = screen.getByRole("link", { name: /visão geral/i })
    expect(link.getAttribute("aria-current")).toBe("page")
  })

  it("em /contas o item Contas recebe aria-current=page e Visão geral não", () => {
    renderSidebar("/contas")
    expect(screen.getByRole("link", { name: /contas/i }).getAttribute("aria-current")).toBe("page")
    expect(screen.getByRole("link", { name: /visão geral/i }).getAttribute("aria-current")).toBeNull()
  })
})
