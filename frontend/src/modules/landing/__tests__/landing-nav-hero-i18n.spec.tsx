// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "../../../i18n"
import ptBR from "../../../i18n/messages/pt-BR"
import enUS from "../../../i18n/messages/en-US"
import { LandingPage } from "../pages/LandingPage"

// Chave crua vazando para a tela: `landing.` ou `pricing.` no texto renderizado.
const RAW_KEY = /\b(?:landing|pricing)\.[A-Za-z]/

function renderLanding() {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <LandingPage />
      </I18nextProvider>
    </MemoryRouter>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage("pt-BR")
})

// H3 passo 8 — navbar e hero da landing não podem ficar em pt-BR sob en-US.
describe("whenLandingInEnUs_thenNavbarAndHeroAreEnglish", () => {
  it("links da navbar vêm de landing.nav*", async () => {
    await i18n.changeLanguage("en-US")
    const { container } = renderLanding()

    const nav = container.querySelector('[data-testid="nav-desktop"]')
    expect(nav).not.toBeNull()
    // Contrato C1: a nav desktop só aparece em `≥lg` (o disclosure cobre `<lg`).
    // A query por testid é independente de layout, mas o elemento precisa ser
    // o mesmo que o browser exibe em 1024 — por isso o corte é fixado aqui.
    expect(nav?.className ?? "").toContain("lg:flex")
    expect(nav?.className ?? "").not.toMatch(/\bmd:flex\b/)
    const labels = Array.from(nav?.querySelectorAll("a") ?? []).map((a) =>
      (a.textContent ?? "").trim(),
    )
    // Assimétrico de propósito: compara com o bundle cru de en-US. Comparar
    // com `i18n.t(...)` faria os dois lados serem a chave crua quando a
    // tradução não existe (fallback), e o teste passaria com a tela quebrada.
    const expected = [
      enUS.landing.navHero,
      enUS.landing.navDemo,
      enUS.landing.navProof,
      enUS.landing.navFeatures,
      enUS.landing.navSteps,
      enUS.landing.navPlans,
      enUS.landing.navFaqShort,
    ]
    expect(labels).toEqual(expected)
    for (const label of labels) {
      expect(label, `chave crua na navbar: ${label}`).not.toMatch(RAW_KEY)
    }
    // pt-BR realmente difere: se as traduções estão certas, os textos não batem.
    const ptNav = [
      ptBR.landing.navHero,
      ptBR.landing.navDemo,
      ptBR.landing.navProof,
      ptBR.landing.navFeatures,
      ptBR.landing.navSteps,
      ptBR.landing.navPlans,
      ptBR.landing.navFaqShort,
    ]
    expect(labels).not.toEqual(ptNav)
    for (const pt of ["Início", "Recursos", "Como Funciona", "Planos"]) {
      expect(nav?.textContent ?? "", `pt-BR na navbar: ${pt}`).not.toContain(pt)
    }
  })

  it("hero (badge, h1, subtítulo e pills) traduz por completo", async () => {
    await i18n.changeLanguage("en-US")
    renderLanding()

    const hero = document.getElementById("hero")
    expect(hero).not.toBeNull()
    const text = hero?.textContent ?? ""
    expect(text).toContain(enUS.landing.heroEyebrow)
    expect(text).toContain(enUS.landing.heroAnnounce)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      enUS.landing.heroTitle,
    )
    expect(text).toContain(enUS.landing.heroSubtitleLong)
    expect(text).toContain(enUS.landing.heroPillOfx)
    expect(text).toContain(enUS.landing.heroPillIsolation)
    expect(text, "chave crua no hero").not.toMatch(RAW_KEY)

    for (const pt of ["Novidade", "Suas contas", "Diga adeus", "Acesso por convite", "Dados isolados"]) {
      expect(text, `pt-BR no hero: ${pt}`).not.toContain(pt)
    }
  })

  it("botão Entrar da navbar traduz", async () => {
    await i18n.changeLanguage("en-US")
    renderLanding()
    const headerActions = document.querySelector('[data-testid="header-actions"]')
    expect(headerActions).not.toBeNull()
    expect(headerActions?.textContent ?? "").toContain(enUS.landing.heroLogin)
    expect(headerActions?.textContent ?? "").not.toContain(ptBR.landing.heroLogin)
  })
})

describe("whenNewKeysAdded_thenBothLocalesCarry", () => {
  it("chaves novas existem em pt-BR e en-US", async () => {
    const { default: ptBR } = await import("../../../i18n/messages/pt-BR")
    const { default: enUS } = await import("../../../i18n/messages/en-US")

    const landingKeys = [
      "navFaqShort",
      "heroEyebrow",
      "heroAnnounce",
      "heroSubtitleLong",
      "heroPillOfx",
      "heroPillIsolation",
    ] as const
    for (const key of landingKeys) {
      expect(ptBR.landing[key], `pt-BR landing.${key}`).toBeTruthy()
      expect(enUS.landing[key], `en-US landing.${key}`).toBeTruthy()
    }

    const authKeys = [
      "loginHeading",
      "loginSubtitle",
      "show",
      "hide",
      "capsLockOn",
      "signingIn",
      "secureFooter",
      "tooManyAttempts",
      "networkError",
      "welcomeBackDescription",
    ] as const
    for (const key of authKeys) {
      expect(ptBR.auth[key], `pt-BR auth.${key}`).toBeTruthy()
      expect(enUS.auth[key], `en-US auth.${key}`).toBeTruthy()
    }
    for (const key of ["invalidEmail", "shortPassword"] as const) {
      expect(ptBR.auth.errors[key], `pt-BR auth.errors.${key}`).toBeTruthy()
      expect(enUS.auth.errors[key], `en-US auth.errors.${key}`).toBeTruthy()
    }
  })

  it("pt-BR preserva o texto atual das telas (sem reescrita de copy)", async () => {
    const { default: ptBR } = await import("../../../i18n/messages/pt-BR")
    expect(ptBR.auth.loginHeading).toBe("Entrar na sua conta")
    expect(ptBR.auth.loginSubtitle).toBe("Informe seu e-mail e senha para acessar o painel.")
    expect(ptBR.auth.secureFooter).toBe(
      "Ambiente seguro. Seus dados são protegidos com criptografia.",
    )
    expect(ptBR.landing.heroEyebrow).toBe("Novidade")
    expect(ptBR.landing.heroAnnounce).toBe(
      "Gestão de contas, faturas de cartão por ciclo e importação OFX",
    )
  })
})
