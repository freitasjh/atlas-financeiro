// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "../../../i18n"
import { LandingPage } from "../pages/LandingPage"

function renderLanding() {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <LandingPage />
      </I18nextProvider>
    </MemoryRouter>,
  )
}

function panel() {
  return document.getElementById("landing-mobile-nav")
}

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await i18n.changeLanguage("pt-BR")
})

describe("whenMobileDisclosureIsClosed_thenItIsOutsideTheA11yTree", () => {
  it("painel não é renderizado e o botão anuncia o estado", () => {
    renderLanding()
    expect(panel()).toBeNull()

    const toggle = screen.getByTestId("landing-mobile-nav-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.getAttribute("aria-controls")).toBe("landing-mobile-nav")
    expect(toggle.getAttribute("aria-label")).toBe(i18n.t("landing.navMenuOpen"))
    expect(toggle.className).toMatch(/h-11/)
    expect(toggle.className).toMatch(/w-11/)
  })
})

// Contrato C1 (ux-designer, vinculante): a quebra do header é única e fica em
// `lg` (1024). Abaixo disso só o disclosure; a partir disso só a nav. O corte
// real é medido em browser (`scrollWidth === clientWidth`, `rect` por link) —
// happy-dom não faz layout, então aqui a prova é o contrato de classes +
// a media query consultada.
describe("whenViewportCrossesLg_thenNavAndToggleNeverCoexist", () => {
  it("fixa nav em lg:flex e toggle/painel em lg:hidden", () => {
    renderLanding()

    const nav = screen.getByTestId("nav-desktop")
    const navClasses = nav.className.split(/\s+/)
    expect(navClasses, "nav desktop sem corte em lg").toContain("lg:flex")
    expect(navClasses, "nav desktop ainda visível em md").not.toContain("md:flex")
    expect(navClasses, "nav desktop sem esconder abaixo de lg").toContain("hidden")
    expect(navClasses, "nav desktop sem gap-4 (≥lg)").toContain("gap-4")
    expect(navClasses, "nav desktop sem xl:gap-6").toContain("xl:gap-6")

    const toggle = screen.getByTestId("landing-mobile-nav-toggle")
    expect(toggle.className.split(/\s+/), "toggle visível em ≥lg").toContain("lg:hidden")
    expect(toggle.className, "toggle com corte antigo em sm").not.toMatch(/\bsm:hidden\b/)

    fireEvent.click(toggle)
    const openPanel = panel()
    expect(openPanel).not.toBeNull()
    expect(
      openPanel?.className.split(/\s+/),
      "painel visível em ≥lg",
    ).toContain("lg:hidden")
    expect(openPanel?.className ?? "").not.toMatch(/\bsm:hidden\b/)
  })

  // Ações do header visíveis a partir de `sm`: alvo de toque de 44px (DESIGN.md).
  // O browser confirma a altura real (`rect.height`) nas 10 faixas; aqui a
  // prova é a classe que a produz.
  it("mantém as ações do header com alvo de 44px", () => {
    renderLanding()
    const actions = screen.getByTestId("header-actions")
    const buttons = Array.from(actions.querySelectorAll("button"))
    expect(buttons).toHaveLength(3)
    const cta = buttons[buttons.length - 1]
    const entrar = buttons[buttons.length - 2]
    for (const button of [cta, entrar]) {
      expect(button.className, "ação do header sem alvo de 44px").toMatch(/\bh-11\b/)
    }
  })

  it("consulta só a media query de lg e fecha o painel ao cruzar para desktop", () => {    let desktop = false
    const listeners: Array<() => void> = []
    const matchMedia = vi.fn((query: string) => ({
      get matches() {
        return query === "(min-width: 1024px)" ? desktop : false
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        listeners.push(listener)
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    vi.stubGlobal("matchMedia", matchMedia)

    renderLanding()
    fireEvent.click(screen.getByTestId("landing-mobile-nav-toggle"))
    expect(panel()).not.toBeNull()

    const queries = matchMedia.mock.calls.map(([query]) => query)
    expect(queries, "corte antigo de 640 ainda consultado").not.toContain("(min-width: 640px)")
    expect(queries, "corte de lg não consultado").toContain("(min-width: 1024px)")

    desktop = true
    act(() => {
      for (const listener of listeners) listener()
    })
    expect(panel()).toBeNull()
    expect(
      screen.getByTestId("landing-mobile-nav-toggle").getAttribute("aria-expanded"),
    ).toBe("false")
  })
})

describe("whenMobileDisclosureIsOpen_thenTargetsAndOrderAreCorrect", () => {
  it("renderiza 10 alvos de toque ≥44 na ordem links → Entrar → CTA", () => {
    renderLanding()
    fireEvent.click(screen.getByTestId("landing-mobile-nav-toggle"))

    const nav = panel()
    expect(nav).not.toBeNull()
    expect(screen.getByTestId("landing-mobile-nav-toggle").getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("landing-mobile-nav-toggle").getAttribute("aria-label")).toBe(
      i18n.t("landing.navMenuClose"),
    )

    const links = Array.from(nav?.querySelectorAll("a[data-scroll-target]") ?? [])
    expect(links.map((a) => a.getAttribute("data-scroll-target"))).toEqual([
      "hero",
      "demo",
      "prova",
      "recursos",
      "como-funciona",
      "planos",
      "faq",
    ])
    for (const link of links) {
      expect(link.className, "link mobile sem min-h-11").toMatch(/min-h-11/)
      expect(link.className).toMatch(/w-full/)
    }

    const buttons = Array.from(nav?.querySelectorAll("button") ?? [])
    // Entrar (outline) + Solicitar convite (primary) + ModeToggle.
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button.className, "botão mobile sem alvo de 44px").toMatch(/min-h-11|h-11/)
    }

    const navText = (nav?.textContent ?? "").trim()
    expect(navText).toContain(i18n.t("landing.heroLogin"))
    expect(navText).toContain(i18n.t("landing.inviteCta"))
    expect(navText).toContain(i18n.t("shell.theme"))

    // Ordem DOM: 7 links → botões de ação → alternador de tema.
    const order = [
      ...links.map((a) => a.getAttribute("data-scroll-target")),
      ...buttons.map((b) => (b.getAttribute("aria-pressed") !== null ? "theme" : "action")),
    ]
    expect(order.slice(7)).toEqual(["action", "action", "theme"])
  })
})

describe("whenEscapePressed_thenPanelClosesAndFocusReturnsToButton", () => {
  it("Escape fecha o painel e devolve o foco ao botão que abriu", () => {
    renderLanding()
    const toggle = screen.getByTestId("landing-mobile-nav-toggle")
    fireEvent.click(toggle)
    expect(panel()).not.toBeNull()

    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })
})

describe("whenSectionLinkClicked_thenPanelClosesAndPageScrolls", () => {
  it("clique em link fecha o painel e rola até a seção", () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    renderLanding()
    fireEvent.click(screen.getByTestId("landing-mobile-nav-toggle"))
    const link = panel()?.querySelector('a[data-scroll-target="faq"]')
    expect(link).not.toBeNull()

    fireEvent.click(link as HTMLAnchorElement)
    expect(panel()).toBeNull()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

describe("whenSecondClickOnToggle_thenPanelCloses", () => {
  it("segundo clique no botão fecha o painel", () => {
    renderLanding()
    const toggle = screen.getByTestId("landing-mobile-nav-toggle")
    fireEvent.click(toggle)
    expect(panel()).not.toBeNull()
    fireEvent.click(toggle)
    expect(panel()).toBeNull()
  })
})
