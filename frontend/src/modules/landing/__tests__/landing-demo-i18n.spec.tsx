// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "../../../i18n"
import ptBR from "../../../i18n/messages/pt-BR"
import enUS from "../../../i18n/messages/en-US"
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

function demoScreen(): HTMLElement {
  const demo = document.getElementById("demo")
  expect(demo).not.toBeNull()
  return demo as HTMLElement
}

function openRulesTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: enUS.landing.showcaseRulesTab }))
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage("pt-BR")
})

// #demo é conteúdo da landing: as regras de categorização usavam literais
// pt-BR ('mercado'/'salario') que vazavam na tela em en-US. Agora vêm do i18n.
describe("whenDemoInEnUs_thenRuleKeywordsAreEnglish", () => {
  it("keywords das regras traduzem e não vazam pt-BR", async () => {
    await i18n.changeLanguage("en-US")
    renderLanding()
    openRulesTab()

    const text = demoScreen().textContent ?? ""
    expect(text).toContain(enUS.landing.showcaseRuleKeywordMarket)
    expect(text).toContain(enUS.landing.showcaseRuleKeywordSalary)
    expect(text.toLowerCase()).not.toContain(ptBR.landing.showcaseRuleKeywordMarket)
    expect(text.toLowerCase()).not.toContain(ptBR.landing.showcaseRuleKeywordSalary)
    expect(text).not.toMatch(/\bmercad?o\b/i)
    expect(text).not.toMatch(/\bsal[aá]rio\b/i)
  })

  it("#demo inteiro não expõe chave crua nem copy pt-BR", async () => {
    await i18n.changeLanguage("en-US")
    renderLanding()
    openRulesTab()

    const text = demoScreen().textContent ?? ""
    expect(text).not.toMatch(/\b(?:landing|pricing)\.[A-Za-z]/)
    for (const pt of ["Faturas", "Extrato", "Orçamentos", "Regras", "Limite do cartão"]) {
      expect(text, `pt-BR no #demo: ${pt}`).not.toContain(pt)
    }
  })
})

describe("whenDemoInPtBr_thenRuleKeywordsStayPortuguese", () => {
  it("keywords pt-BR continuam vindo do bundle", () => {
    renderLanding()
    fireEvent.click(screen.getByRole("tab", { name: ptBR.landing.showcaseRulesTab }))
    const text = demoScreen().textContent ?? ""
    expect(text).toContain(ptBR.landing.showcaseRuleKeywordMarket)
    expect(text).toContain(ptBR.landing.showcaseRuleKeywordSalary)
  })
})
