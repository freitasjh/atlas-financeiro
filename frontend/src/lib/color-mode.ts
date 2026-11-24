/**
 * Preferência de tema do harness (`harness-color-mode`).
 *
 * Fonte única do critério — valor salvo, senão `prefers-color-scheme` — usada
 * pelo `ModeToggle` do shell de tenant e pelo carregamento do chunk interno.
 * Sem isso o modo escuro não sobrevive a F5 dentro de `/internal` (re-H3 F4 P3).
 */

export const COLOR_MODE_STORAGE_KEY = "harness-color-mode"

export type ColorMode = "light" | "dark"

/** Valor salvo, ou `null` quando ausente/inválido/armazenamento bloqueado. */
export function readStoredColorMode(): ColorMode | null {
  try {
    const saved = localStorage.getItem(COLOR_MODE_STORAGE_KEY)
    if (saved === "dark" || saved === "light") return saved
    return null
  } catch {
    return null
  }
}

/** Modo efetivo: preferência salva, senão `prefers-color-scheme`, senão claro. */
export function readColorMode(): ColorMode {
  const stored = readStoredColorMode()
  if (stored !== null) return stored
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

export function applyColorMode(
  mode: ColorMode,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle("dark", mode === "dark")
}

export function persistColorMode(mode: ColorMode): void {
  try {
    localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode)
  } catch {
    /* armazenamento indisponível: segue sem persistência */
  }
}

/** Aplica o modo efetivo no `documentElement` e devolve o modo aplicado. */
export function applyStoredColorMode(): ColorMode {
  const mode = readColorMode()
  applyColorMode(mode)
  return mode
}
