// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import i18n from "@/i18n"
import { SidebarProvider } from "@/components/shadcn/ui/sidebar"
import { NavMain } from "./nav-main"

function renderNav(items: { title: string; url: string }[] = []) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <NavMain items={items} />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

describe("NavMain (i18n)", () => {
  afterEach(cleanup)

  it("whenRendered_thenNewEntryAndInboxFromSidebarKeys", () => {
    renderNav()
    expect(screen.getByText(i18n.t("sidebar.newEntry"))).toBeTruthy()
    expect(screen.getByText(i18n.t("sidebar.inbox"))).toBeTruthy()
  })

  it("whenItemsGiven_thenEachTitleRenderedOnce", () => {
    renderNav([
      { title: "Início", url: "/" },
      { title: "Cartões", url: "/cartoes" },
    ])
    expect(screen.getByText("Início")).toBeTruthy()
    expect(screen.getByText("Cartões")).toBeTruthy()
  })

  it("whenNewEntryKey_thenMatchesPtBrLiteral", () => {
    expect(i18n.t("sidebar.newEntry", { lng: "pt-BR" })).toBe("Novo lançamento")
    expect(i18n.t("sidebar.newEntry", { lng: "en-US" })).toBe("New entry")
    expect(i18n.t("sidebar.inbox", { lng: "pt-BR" })).toBe("Caixa de entrada")
    expect(i18n.t("sidebar.inbox", { lng: "en-US" })).toBe("Inbox")
  })
})
