// Âncoras internas convivem com `createHashRouter`: `href="#hero"` viraria a
// rota `/hero` (404). A navegação in-page passa por aqui — `preventDefault` no
// handler e scroll/foco movidos por DOM, sem tocar no hash.

export interface RevealOptions {
  /** Move o foco para o alvo (skip link); o alvo precisa aceitar foco. */
  focus?: boolean
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/**
 * Rola até o elemento pelo `id`. Devolve `false` quando o alvo não existe, para
 * o chamador saber que nada aconteceu (nunca lança).
 */
export function revealInPageTarget(id: string, options: RevealOptions = {}): boolean {
  if (typeof document === "undefined") return false
  const target = document.getElementById(id)
  if (!target) return false

  target.scrollIntoView?.({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start",
  })

  if (options.focus) {
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1")
    target.focus({ preventScroll: true })
  }

  return true
}
