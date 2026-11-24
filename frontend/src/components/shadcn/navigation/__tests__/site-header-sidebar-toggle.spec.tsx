// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import i18n from "@/i18n"
import { SidebarProvider } from "@/components/shadcn/ui/sidebar"
import { SiteHeader, type SiteHeaderProps } from "../site-header"

function renderHeader(props: Partial<SiteHeaderProps> = {}) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SiteHeader showGlobalBalance={false} {...props} />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

function sidebarTrigger(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-sidebar="trigger"]')
}

afterEach(async () => {
  await i18n.changeLanguage("pt-BR")
  cleanup()
})

describe("whenHeaderRendersOnMobile_thenTheTriggerMeetsThe44pxTouchTarget", () => {
  it("whenViewportIsSmall_thenTriggerCarriesMinHeightAndMinWidth", () => {
    const { container } = renderHeader()
    const trigger = sidebarTrigger(container)

    expect(trigger).not.toBeNull()
    expect(trigger?.className ?? "").toMatch(/max-md:min-h-11/)
    expect(trigger?.className ?? "").toMatch(/max-md:min-w-11/)
  })

  it("whenNoLabelIsGiven_thenTheTemplateDefaultStays", () => {
    renderHeader()

    expect(screen.getByRole("button", { name: /toggle sidebar/i })).toBeTruthy()
  })

  it("whenLabelIsGiven_thenTheAccessibleNameIsTranslatedWithoutEnglishLeftover", () => {
    const { container } = renderHeader({ sidebarToggleLabel: "Alternar menu lateral" })

    expect(screen.getByRole("button", { name: /alternar menu lateral/i })).toBeTruthy()
    expect(container.textContent ?? "").not.toMatch(/toggle sidebar/i)
  })
})
