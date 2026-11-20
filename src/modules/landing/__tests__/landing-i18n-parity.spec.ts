// @vitest-environment happy-dom
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
