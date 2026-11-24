import { describe, expect, it } from "vitest"

import { INTERNAL_NAV_ITEMS, internalNavTitleKey, isInternalNavActive } from "../internal-nav"

describe("whenShellRendersNavigation_thenThereAreExactlyFourAnchors", () => {
  it("4 âncoras, sem seletor de tenant e sem rota de tenant ativo", () => {
    expect(INTERNAL_NAV_ITEMS).toHaveLength(4)
    expect(INTERNAL_NAV_ITEMS.map((item) => item.to)).toEqual([
      "/internal",
      "/internal/tenants",
      "/internal/auditoria",
      "/internal/telemetria",
    ])
    expect(INTERNAL_NAV_ITEMS.some((item) => item.to.includes(":tenant"))).toBe(false)
  })
})

describe("whenPathnameIsResolved_thenActiveItemIsExact", () => {
  const [home, tenants] = INTERNAL_NAV_ITEMS

  it("raiz só fica ativa na raiz", () => {
    expect(isInternalNavActive("/internal", home)).toBe(true)
    expect(isInternalNavActive("/internal/tenants", home)).toBe(false)
  })

  it("seção fica ativa em si e nas filhas", () => {
    expect(isInternalNavActive("/internal/tenants", tenants)).toBe(true)
    expect(isInternalNavActive("/internal/tenants/abc", tenants)).toBe(true)
    expect(isInternalNavActive("/internal/tenantsx", tenants)).toBe(false)
  })
})

describe("whenTitleIsResolved_thenItFollowsTheActiveAnchor", () => {
  it("raiz e seções resolvem a chave i18n da âncora", () => {
    expect(internalNavTitleKey("/internal")).toBe("internalAdmin.nav.home")
    expect(internalNavTitleKey("/internal/tenants")).toBe("internalAdmin.nav.tenants")
    expect(internalNavTitleKey("/internal/tenants/abc")).toBe("internalAdmin.nav.tenants")
    expect(internalNavTitleKey("/internal/auditoria")).toBe("internalAdmin.nav.audit")
    expect(internalNavTitleKey("/internal/telemetria")).toBe("internalAdmin.nav.telemetry")
  })

  it("rota desconhecida cai no rótulo de não encontrado", () => {
    expect(internalNavTitleKey("/internal/foo")).toBe("internalAdmin.notFoundTitle")
  })
})
