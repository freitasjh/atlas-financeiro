import { describe, expect, it } from "vitest"

import {
  COMPARISON_TABLE,
  PRICING_PLANS,
  type ComparisonCategory,
  type PricingPlan,
} from "@/components/shadcn/pricing/pricing-types"
import ptBR from "@/i18n/messages/pt-BR"
import enUS from "@/i18n/messages/en-US"

type Messages = { [key: string]: unknown }

/** Lê `a.b.c` do bundle cru — nunca do i18next (fallback mascararia o buraco). */
function resolveKey(bundle: Messages, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object") return (node as Messages)[part]
    return undefined
  }, bundle)
}

function collectPlanKeys(plan: PricingPlan): string[] {
  const keys: string[] = []
  for (const key of [plan.descriptionKey, plan.badgeKey, plan.ctaKey, plan.limitLabelKey]) {
    if (key) keys.push(key)
  }
  for (const feature of plan.features) {
    if (feature.textKey) keys.push(feature.textKey)
  }
  return keys
}

type ComparisonFeature = ComparisonCategory["features"][number]

function collectComparisonKeys(feature: ComparisonFeature): string[] {
  const keys: string[] = []
  if (feature.nameKey) keys.push(feature.nameKey)
  if (feature.tooltipKey) keys.push(feature.tooltipKey)
  const cells = [
    feature.free,
    feature.standard,
    feature.pro,
    feature.full,
    feature.starter,
    feature.professional,
    feature.enterprise,
  ]
  for (const cell of cells) {
    // Célula textual é sempre chave `pricing.*` quando não é booleano.
    if (typeof cell === "string" && cell.startsWith("pricing.")) keys.push(cell)
  }
  return keys
}

function collectPricingKeys(): string[] {
  const keys: string[] = []
  for (const plan of PRICING_PLANS) keys.push(...collectPlanKeys(plan))
  for (const category of COMPARISON_TABLE) {
    if (category.categoryKey) keys.push(category.categoryKey)
    for (const feature of category.features) keys.push(...collectComparisonKeys(feature))
  }
  return [...new Set(keys)]
}

describe("whenPricingKeysDeclared_thenEveryKeyResolvesInBothLocales", () => {
  const keys = collectPricingKeys()

  it("declara um conjunto não trivial de chaves", () => {
    // 4 planos (32 features + 4 descrições + 3 badges + 6 limites/CTA) + 5 categorias + 15 features.
    expect(keys.length).toBeGreaterThan(50)
  })

  it("toda chave resolve em pt-BR com texto não vazio", () => {
    for (const key of keys) {
      const value = resolveKey(ptBR as unknown as Messages, key)
      expect(typeof value, `pt-BR ${key} ausente ou não textual`).toBe("string")
      expect((value as string).trim().length, `pt-BR ${key} vazia`).toBeGreaterThan(0)
    }
  })

  it("toda chave resolve em en-US com texto não vazio", () => {
    for (const key of keys) {
      const value = resolveKey(enUS as unknown as Messages, key)
      expect(typeof value, `en-US ${key} ausente ou não textual`).toBe("string")
      expect((value as string).trim().length, `en-US ${key} vazia`).toBeGreaterThan(0)
    }
  })
})
