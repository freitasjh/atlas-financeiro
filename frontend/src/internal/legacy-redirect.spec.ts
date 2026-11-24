import { describe, expect, it } from "vitest"

import {
  LEGACY_INTERNAL_REDIRECT_DEATH,
  isLegacyInternalPath,
  isLegacyInternalRedirectExpired,
  resolveLegacyInternalRedirect,
} from "./legacy-redirect"

const BEFORE_DEATH = new Date("2026-11-19T12:00:00Z")
const AFTER_DEATH = new Date("2027-01-01T00:00:00Z")

describe("whenLegacyPathIsGiven_thenRedirectTargetPreservesSearchAndHash", () => {
  it("/admin?x=1#y vira /internal?x=1#y", () => {
    expect(resolveLegacyInternalRedirect("/admin", "?x=1", "#y", BEFORE_DEATH)).toEqual({
      pathname: "/internal",
      search: "?x=1",
      hash: "#y",
    })
  })

  it("/backoffice sem query/hash vira /internal", () => {
    expect(resolveLegacyInternalRedirect("/backoffice", "", "", BEFORE_DEATH)).toEqual({
      pathname: "/internal",
      search: "",
      hash: "",
    })
  })

  it("subárvore /admin/tenants também redireciona", () => {
    expect(resolveLegacyInternalRedirect("/admin/tenants", "?x=1", "", BEFORE_DEATH)).toEqual({
      pathname: "/internal",
      search: "?x=1",
      hash: "",
    })
  })

  it("query literal //evil.com é preservada sem virar URL", () => {
    expect(
      resolveLegacyInternalRedirect("/admin", "?next=//evil.com", "", BEFORE_DEATH),
    ).toEqual({
      pathname: "/internal",
      search: "?next=//evil.com",
      hash: "",
    })
  })

  it("prefixos ausentes são normalizados", () => {
    expect(resolveLegacyInternalRedirect("/admin", "x=1", "y", BEFORE_DEATH)).toEqual({
      pathname: "/internal",
      search: "?x=1",
      hash: "#y",
    })
  })
})

describe("whenPathIsNotLegacy_thenNoRedirect", () => {
  it.each([
    "/",
    "/internal",
    "/internal/tenants",
    "/administrador",
    "/backofficex",
    "",
  ])("%s não é legado", (pathname) => {
    expect(isLegacyInternalPath(pathname)).toBe(false)
    expect(resolveLegacyInternalRedirect(pathname, "?x=1", "#y", BEFORE_DEATH)).toBeNull()
  })
})

describe("whenDateIsAfterDeath_thenLegacyEntriesExpire", () => {
  it("declara a data de morte", () => {
    expect(LEGACY_INTERNAL_REDIRECT_DEATH).toBe("2026-12-31")
  })

  it("ainda ativo no último instante do dia declarado", () => {
    expect(
      isLegacyInternalRedirectExpired(new Date("2026-12-31T23:59:59Z")),
    ).toBe(false)
    expect(
      resolveLegacyInternalRedirect("/admin", "", "", new Date("2026-12-31T23:59:59Z")),
    ).not.toBeNull()
  })

  it("expirado no dia seguinte — cai no 404", () => {
    expect(isLegacyInternalRedirectExpired(AFTER_DEATH)).toBe(true)
    expect(resolveLegacyInternalRedirect("/admin", "?x=1", "#y", AFTER_DEATH)).toBeNull()
  })

  it("é total: entradas inválidas nunca lançam", () => {
    expect(() =>
      resolveLegacyInternalRedirect(
        undefined as unknown as string,
        undefined as unknown as string,
        undefined as unknown as string,
        new Date(Number.NaN),
      ),
    ).not.toThrow()
    expect(
      resolveLegacyInternalRedirect(
        undefined as unknown as string,
        undefined as unknown as string,
        undefined as unknown as string,
        new Date(Number.NaN),
      ),
    ).toBeNull()
  })
})
