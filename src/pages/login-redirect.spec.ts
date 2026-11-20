import { describe, it, expect } from "vitest"

import { resolveLoginRedirect } from "@/pages/login-redirect"

describe("whenFromIsValid_thenReturnsHashForFrom", () => {
  it("rota interna simples", () => {
    expect(resolveLoginRedirect("/contas")).toBe("#/contas")
  })

  it("rota interna com query", () => {
    expect(resolveLoginRedirect("/contas?tab=investimentos")).toBe("#/contas?tab=investimentos")
  })

  it("raiz interna", () => {
    expect(resolveLoginRedirect("/")).toBe("#/")
  })
})

describe("whenFromMissing_thenFallsBackToRoot", () => {
  it("undefined", () => {
    expect(resolveLoginRedirect(undefined)).toBe("#/")
  })

  it("não-string", () => {
    expect(resolveLoginRedirect({evil: true})).toBe("#/")
  })
})

describe("whenFromUnsafe_thenFallsBackToRoot", () => {
  it("protocol-relative (open redirect)", () => {
    expect(resolveLoginRedirect("//evil.com")).toBe("#/")
  })

  it("esquema javascript:", () => {
    expect(resolveLoginRedirect("javascript:alert(1)")).toBe("#/")
  })

  it("URL absoluta externa", () => {
    expect(resolveLoginRedirect("https://evil.com")).toBe("#/")
  })

  it("quebra de linha injetada", () => {
    expect(resolveLoginRedirect("/contas\nSet-Cookie:x=1")).toBe("#/")
  })

  it("empty string", () => {
    expect(resolveLoginRedirect("")).toBe("#/")
  })
})
