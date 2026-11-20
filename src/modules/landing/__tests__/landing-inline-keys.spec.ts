import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import ptBR from "@/i18n/messages/pt-BR"
import enUS from "@/i18n/messages/en-US"

type Messages = { [key: string]: unknown }

/** Lê `a.b.c` do bundle cru — o fallback do i18next mascararia a chave ausente. */
function resolveKey(bundle: Messages, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object") return (node as Messages)[part]
    return undefined
  }, bundle)
}

/** Chave plural do i18next (`showcaseCount_one`/`_other`) também é válida. */
function resolveTextual(bundle: Messages, key: string): string | undefined {
  const direct = resolveKey(bundle, key)
  if (typeof direct === "string") return direct
  if (typeof direct === "object" && direct !== null) return undefined
  const forms = ["one", "other"].map((suffix) => resolveKey(bundle, `${key}_${suffix}`))
  const textual = forms.filter((value): value is string => typeof value === "string")
  if (textual.length === 0) return undefined
  return textual.join(" ")
}

/** `t("a.b")` / `t('a.b')` / `t(\`a.b\`)` — só chaves literais, nunca variáveis. */
const INLINE_KEY = /\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]\s*[,)]/g

function collectInlineKeys(path: string): string[] {
  const source = readFileSync(path, "utf8")
  const keys: string[] = []
  for (const match of source.matchAll(INLINE_KEY)) keys.push(match[1])
  return [...new Set(keys)]
}

// Cobertura dos `t("...")` escritos no próprio componente: `pricing-keys.spec.ts`
// só cobre os `*Key` declarados em PRICING_PLANS/COMPARISON_TABLE. Um typo
// inline não pode passar — nem em pt-BR, nem em en-US.
const SOURCES = [
  { path: "src/components/shadcn/pricing/pricing-table.tsx", floor: 19 },
  { path: "src/modules/landing/pages/LandingPage.tsx", floor: 90 },
  { path: "src/modules/landing/components/ShowcaseTabs.tsx", floor: 15 },
] as const

describe("whenInlineKeysScanned_thenEveryKeyResolvesInBothRawBundles", () => {
  for (const source of SOURCES) {
    const keys = collectInlineKeys(source.path)

    it(`${source.path}: varredura encontra as chaves inline`, () => {
      expect(keys.length).toBeGreaterThanOrEqual(source.floor)
      for (const key of keys) expect(key).toMatch(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/)
    })

    it(`${source.path}: toda chave inline existe em pt-BR e en-US`, () => {
      for (const key of keys) {
        const pt = resolveTextual(ptBR as unknown as Messages, key)
        const en = resolveTextual(enUS as unknown as Messages, key)
        expect(typeof pt, `pt-BR ${key} ausente ou não textual`).toBe("string")
        expect(typeof en, `en-US ${key} ausente ou não textual`).toBe("string")
        expect((pt as string).trim().length, `pt-BR ${key} vazia`).toBeGreaterThan(0)
        expect((en as string).trim().length, `en-US ${key} vazia`).toBeGreaterThan(0)
        // Texto igual à chave = placeholder/fallback, não tradução.
        expect(pt, `pt-BR ${key} devolveu a própria chave`).not.toBe(key)
        expect(en, `en-US ${key} devolveu a própria chave`).not.toBe(key)
      }
    })
  }

  it("en-US não é cópia literal do pt-BR nas chaves inline de pricing", () => {
    const keys = collectInlineKeys("src/components/shadcn/pricing/pricing-table.tsx")
    const identical = keys.filter(
      (key) => resolveKey(ptBR as unknown as Messages, key) === resolveKey(enUS as unknown as Messages, key),
    )
    // Pílulas técnicas (ex.: "OFX", "/mês") podem coincidir; a maioria não pode.
    expect(identical.length).toBeLessThan(keys.length / 2)
  })
})
