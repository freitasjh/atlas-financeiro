// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { formatCents } from "@/lib/dashboard/format"

describe("formatCents (DASH-14 / RF-17 / RN01)", () => {
  it("formata bigint em pt-BR sem perda: 12509000n -> R$ 125.090,00", () => {
    expect(formatCents(12509000n, "pt-BR")).toBe("R$ 125.090,00")
  })

  it("formata em en-US com agrupamento e decimal da língua", () => {
    expect(formatCents(12509000n, "en-US")).toBe("R$125,090.00")
  })

  it("formata zero nas duas línguas", () => {
    expect(formatCents(0n, "pt-BR")).toBe("R$ 0,00")
    expect(formatCents(0n, "en-US")).toBe("R$0.00")
  })

  it("aceita number inteiro seguro e rejeita fração", () => {
    expect(formatCents(12345, "pt-BR")).toBe("R$ 123,45")
    expect(() => formatCents(123.45)).toThrow()
  })

  it("não usa notação científica nem perde precisão acima de MAX_SAFE_INTEGER", () => {
    const output = formatCents(9007199254740993n, "en-US")
    expect(output).not.toMatch(/e[+-]/i)
    expect(output).toContain("90,071,992,547,409.93")
  })

  it("mantém sinal negativo", () => {
    expect(formatCents(-500n, "pt-BR")).toBe("-R$ 5,00")
  })

  it("falha explicitamente com null/undefined: contrato não admite dado nulo", () => {
    expect(() => formatCents(null as unknown as bigint)).toThrow()
    expect(() => formatCents(undefined as unknown as bigint)).toThrow()
  })

  it("usa Intl.NumberFormat e aritmética bigint (sem Number(cents)/100)", () => {
    const source = readFileSync(join(__dirname, "..", "dashboard", "format.ts"), "utf8")
    expect(source).toContain("Intl.NumberFormat")
    expect(source).toContain("absolute / 100n")
    expect(source).not.toMatch(/Number\([^)]*\)\s*\/\s*100/)
  })
})
