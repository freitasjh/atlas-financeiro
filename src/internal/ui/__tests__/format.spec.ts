import { describe, expect, it } from "vitest"

import {
  formatCount,
  formatCurrency,
  formatDate,
  formatDateTime,
  maskDocument,
  maskId,
} from "../format"

describe("whenCentsAreFormatted_thenValueUsesBRLWithoutFloat", () => {
  it("inteiro em cents vira moeda BRL", () => {
    expect(formatCurrency(123456)).toContain("1.234,56")
    expect(formatCurrency(0)).toContain("0,00")
  })

  it("entrada inválida vira travessão, nunca NaN", () => {
    expect(formatCurrency(null)).toBe("—")
    expect(formatCurrency(undefined)).toBe("—")
    expect(formatCurrency(Number.NaN)).toBe("—")
    expect(formatCurrency(10.5)).toBe("—")
  })
})

describe("whenDatesAreFormatted_thenLocaleIsStable", () => {
  it("data-only vira dd/mm/aaaa", () => {
    expect(formatDate("2026-11-01")).toBe("01/11/2026")
    expect(formatDate("2026-11-01T00:00:00Z")).toBe("01/11/2026")
  })

  it("data inválida vira travessão", () => {
    expect(formatDate(null)).toBe("—")
    expect(formatDate("nope")).toBe("—")
    expect(formatDateTime("nope")).toBe("—")
  })

  it("timestamp vira dd/mm/aaaa hh:mm", () => {
    expect(formatDateTime("2026-11-19T17:30:00Z")).toMatch(/19\/11\/2026,?\s+\d{2}:\d{2}/)
  })
})

describe("whenCountsAreFormatted_thenThousandsAreSeparated", () => {
  it("contagem inteira pt-BR", () => {
    expect(formatCount(1234)).toBe("1.234")
    expect(formatCount(0)).toBe("0")
    expect(formatCount(null)).toBe("—")
  })
})

describe("whenDocumentsAreShown_thenOnlyTheTailSurvives", () => {
  it("CPF e CNPJ mascarados preservam 3 dígitos", () => {
    expect(maskDocument("12345678909")).toBe("••••••••909")
    expect(maskDocument("12345678000199")).toBe("•••••••••••199")
  })

  it("documento ausente ou curto vira travessão", () => {
    expect(maskDocument(null)).toBe("—")
    expect(maskDocument("12")).toBe("—")
  })

  it("UUID mascarado preserva 4 caracteres", () => {
    expect(maskId("11111111-2222-3333-4444-555566667777")).toBe("••••7777")
    expect(maskId(null)).toBe("—")
  })
})
