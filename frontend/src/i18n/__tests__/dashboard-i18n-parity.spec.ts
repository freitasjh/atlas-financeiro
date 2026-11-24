// @vitest-environment node
import { describe, expect, it } from "vitest"

import ptBR from "@/i18n/messages/pt-BR"
import enUS from "@/i18n/messages/en-US"

function dashboardKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    const nested = dashboardKeys(child, path)
    return nested.length > 0 ? nested : [path]
  })
}

describe("i18n do dashboard (DASH-12 / RF-15 / NFR-06)", () => {
  it("projectedBreakdown não cita faturas em aberto nem deixa placeholder órfão", () => {
    for (const [locale, catalog] of [
      ["pt-BR", ptBR],
      ["en-US", enUS],
    ] as const) {
      const value = catalog.dashboard.projectedBreakdown
      expect(value, locale).not.toContain("faturas em aberto")
      expect(value, locale).not.toContain("open invoices")
      expect(value, locale).not.toContain("{{invoices}}")
      expect(value, locale).toContain("{{liquidity}}")
      expect(value, locale).toContain("{{income}}")
      expect(value, locale).toContain("{{spent}}")
    }
  })

  it("dashboard.loadError e dashboard.retry existem nas duas línguas", () => {
    for (const catalog of [ptBR, enUS]) {
      expect(catalog.dashboard.loadError.length).toBeGreaterThan(0)
      expect(catalog.dashboard.retry.length).toBeGreaterThan(0)
    }
  })

  it("catálogos têm exatamente as mesmas chaves de dashboard (nenhuma chave inventada só numa língua)", () => {
    expect(dashboardKeys(ptBR.dashboard).sort()).toEqual(dashboardKeys(enUS.dashboard).sort())
  })
})
