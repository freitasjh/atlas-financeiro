// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))

import "@/i18n"
import { SidebarProvider, useSidebar } from "@/components/shadcn/ui/sidebar"
import { NavMain } from "../nav-main"

function DrawerProbe() {
  const { openMobile, setOpenMobile } = useSidebar()
  return (
    <div>
      <span data-testid="open-mobile">{openMobile ? "open" : "closed"}</span>
      <button type="button" onClick={() => setOpenMobile(true)}>
        abrir gaveta
      </button>
    </div>
  )
}

const items = [
  { title: "Visão geral", url: "/internal", end: true },
  { title: "Tenants", url: "/internal/tenants", end: false },
]

function renderNav() {
  return render(
    <MemoryRouter initialEntries={["/internal"]}>
      <SidebarProvider>
        <NavMain items={items} quickCreate={null} />
        <DrawerProbe />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe("whenMobileNavItemIsClicked_thenTheDrawerCloses", () => {
  it("fechar ao navegar: openMobile volta a false", async () => {
    const user = userEvent.setup()
    renderNav()

    await user.click(screen.getByRole("button", { name: /abrir gaveta/i }))
    expect(screen.getByTestId("open-mobile").textContent).toBe("open")

    await user.click(screen.getByRole("link", { name: /tenants/i }))

    expect(screen.getByTestId("open-mobile").textContent).toBe("closed")
  })

  it("alvos de toque ≥44px no mobile e nenhuma ação de lançamento", () => {
    const { container } = renderNav()
    const links = Array.from(container.querySelectorAll("a"))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.className).toContain("max-md:min-h-11")
    }
    expect(screen.queryByText(/novo lançamento/i)).toBeNull()
    expect(screen.queryByText(/caixa de entrada/i)).toBeNull()
  })
})
