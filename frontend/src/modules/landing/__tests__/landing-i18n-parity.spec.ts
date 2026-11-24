// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"

import i18n from "../../../i18n"
import ptBR from "../../../i18n/messages/pt-BR"
import enUS from "../../../i18n/messages/en-US"

type Dict = Record<string, unknown>

/** Coleta os caminhos-folha (somente strings) de um dicionário aninhado. */
function leafPaths(node: Dict, prefix: string): string[] {
  const paths: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const path = `${prefix}.${key}`
    if (value && typeof value === "object") {
      paths.push(...leafPaths(value as Dict, path))
    } else if (typeof value === "string") {
      paths.push(path)
    }
  }
  return paths.sort()
}

afterEach(async () => {
  await i18n.changeLanguage("pt-BR")
})

const LANDING_PT = ptBR.landing as unknown as Dict
const LANDING_EN = enUS.landing as unknown as Dict
const PRICING_PT = (ptBR as unknown as Dict).pricing as Dict
const PRICING_EN = (enUS as unknown as Dict).pricing as Dict

describe("whenLocalesCompared_thenNamespacesHaveExactParity", () => {
  it("landing tem as mesmas chaves em pt-BR e en-US", () => {
    expect(leafPaths(LANDING_EN, "landing")).toEqual(leafPaths(LANDING_PT, "landing"))
  })

  it("pricing tem as mesmas chaves em pt-BR e en-US", () => {
    expect(leafPaths(PRICING_EN, "pricing")).toEqual(leafPaths(PRICING_PT, "pricing"))
  })

  it("pricing não é vazio e cobre as seções obrigatórias", () => {
    const keys = leafPaths(PRICING_PT, "pricing")
    expect(keys.length).toBeGreaterThanOrEqual(70)
    for (const required of [
      "pricing.eyebrow",
      "pricing.heading",
      "pricing.lead",
      "pricing.ctaChoose",
      "pricing.compareHeader",
      "pricing.catAccounts",
      "pricing.freeFeature1",
      "pricing.fullFeature6",
    ]) {
      expect(keys, `chave ausente: ${required}`).toContain(required)
    }
  })

  it("landing.included/notIncluded existem nos dois locales (fallback literal eliminado)", () => {
    expect(LANDING_PT.included).toBe("Sim")
    expect(LANDING_PT.notIncluded).toBe("Não")
    expect(LANDING_EN.included).toBe("Yes")
    expect(LANDING_EN.notIncluded).toBe("No")
  })
})

describe("whenTResolves_thenNoKeyIsRenderedRaw", () => {
  it.each(["pt-BR", "en-US"] as const)("%s resolve todas as folhas", async (lng) => {
    await i18n.changeLanguage(lng)
    const paths = [
      ...leafPaths(lng === "pt-BR" ? LANDING_PT : LANDING_EN, "landing"),
      ...leafPaths(lng === "pt-BR" ? PRICING_PT : PRICING_EN, "pricing"),
    ]
    expect(paths.length).toBeGreaterThan(150)
    for (const path of paths) {
      const value = i18n.t(path)
      expect(value, `chave crua renderizada: ${path}`).not.toBe(path)
      expect(value.length, `valor vazio: ${path}`).toBeGreaterThan(0)
    }
  })
})

const COPY_KEYS = [
  "invitePill1",
  "inviteFinalBody",
  "inviteStep1Title",
  "inviteStep1Desc",
  "inviteFaqAnswer1",
] as const

describe("whenTwoPathsCopyAudited_thenSignupPrimaryInviteAlternative", () => {
  it("heroCta é Criar conta/Create account sem interpolação de slug", () => {
    expect(LANDING_PT.heroCta).toBe("Criar conta")
    expect(LANDING_EN.heroCta).toBe("Create account")
    for (const value of [LANDING_PT.heroCta, LANDING_EN.heroCta]) {
      expect(value).not.toMatch(/\{\{|free|standard|pro|full/)
    }
    expect(LANDING_PT.inviteCta).toBe("Solicitar convite")
    expect(LANDING_EN.inviteCta).toBe("Request an invite")
  })

  it.each([
    ["pt-BR", LANDING_PT, /criar conta|crie sua conta|crie sua/i, /convite/i],
    ["en-US", LANDING_EN, /create (your )?account|sign up/i, /invite/i],
  ] as const)("%s: todo landing.* de convite vira cadastro principal + convite alternativa", (_lng, dict, signup, invite) => {
    for (const key of COPY_KEYS) {
      const value = String(dict[key])
      expect(value, `${key} sem cadastro principal`).toMatch(signup)
      expect(value, `${key} sem alternativa de convite`).toMatch(invite)
    }
    const lead = String((_lng === "pt-BR" ? PRICING_PT : PRICING_EN).lead)
    expect(lead).toMatch(signup)
    expect(lead).toMatch(invite)
  })

  it("copy anti-cobrança preservada nas duas locales", () => {
    const all = `${COPY_KEYS.map((k) => `${LANDING_PT[k]} ${LANDING_EN[k]}`).join(" ")} ${PRICING_PT.lead} ${PRICING_EN.lead}`.toLowerCase()
    for (const banned of ["assinar", "checkout", "pagar", "pague agora", "trial", "upgrade", "subscribe", "pay now"]) {
      expect(all, `termo de cobrança: ${banned}`).not.toContain(banned)
    }
    expect(String(LANDING_PT.inviteFaqAnswer1)).toContain("cobrança")
    expect(String(PRICING_PT.lead)).toContain("cobrança")
  })

  it("0 literal de produto nos componentes (só chaves i18n)", () => {
    for (const file of [
      "frontend/src/modules/landing/pages/LandingPage.tsx",
      "frontend/src/components/shadcn/pricing/pricing-table.tsx",
      "frontend/src/pages/RequestInvitePage.tsx",
    ]) {
      const source = readFileSync(file, "utf8")
      for (const literal of ["Criar conta", "Create account", "Solicitar convite", "Request an invite"]) {
        expect(source, `${file} com literal: ${literal}`).not.toContain(literal)
      }
    }
  })
})
