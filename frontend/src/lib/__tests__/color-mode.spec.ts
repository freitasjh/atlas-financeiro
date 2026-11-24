// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { applyStoredColorMode, COLOR_MODE_STORAGE_KEY, readColorMode } from "../color-mode"

const root = document.documentElement

/**
 * happy-dom 21 não expõe `localStorage` (o global do Node exige
 * `--localstorage-file`). O stub cobre o mesmo contrato usado no browser.
 */
function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
  })
  return store
}

beforeEach(() => {
  stubStorage()
  root.classList.remove("dark")
})

afterEach(() => {
  vi.unstubAllGlobals()
  root.classList.remove("dark")
})

describe("whenStoredColorModeExists_thenItIsApplied", () => {
  it("dark salvo aplica a classe no documentElement", () => {
    stubStorage({ [COLOR_MODE_STORAGE_KEY]: "dark" })

    applyStoredColorMode()

    expect(root.classList.contains("dark")).toBe(true)
  })

  it("light salvo remove a classe", () => {
    root.classList.add("dark")
    stubStorage({ [COLOR_MODE_STORAGE_KEY]: "light" })

    applyStoredColorMode()

    expect(root.classList.contains("dark")).toBe(false)
  })

  it("valor desconhecido cai no prefers-color-scheme", () => {
    stubStorage({ [COLOR_MODE_STORAGE_KEY]: "sepia" })
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia

    try {
      expect(readColorMode()).toBe("dark")
      applyStoredColorMode()
      expect(root.classList.contains("dark")).toBe(true)
    } finally {
      window.matchMedia = original
    }
  })
})
