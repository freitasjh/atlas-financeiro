// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import { revealInPageTarget } from "@/lib/in-page-anchor"

function stubMatchMedia(matches: boolean) {
  return vi.spyOn(window, "matchMedia").mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as MediaQueryList)
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
  document.body.removeAttribute("tabindex")
})

describe("revealInPageTarget", () => {
  it("whenTargetExists_thenScrollsAndReportsHandled", () => {
    const section = document.createElement("section")
    section.id = "hero"
    const scroll = vi.fn()
    section.scrollIntoView = scroll
    document.body.appendChild(section)

    expect(revealInPageTarget("hero")).toBe(true)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.calls[0]?.[0]).toMatchObject({ block: "start" })
  })

  it("whenTargetMissing_thenReturnsFalseWithoutThrowing", () => {
    expect(revealInPageTarget("nao-existe")).toBe(false)
  })

  it("whenFocusRequested_thenMovesFocusToTarget", () => {
    const main = document.createElement("main")
    main.id = "main"
    main.tabIndex = -1
    document.body.appendChild(main)

    expect(revealInPageTarget("main", { focus: true })).toBe(true)
    expect(document.activeElement).toBe(main)
  })

  it("whenReducedMotion_thenScrollsWithoutSmoothBehavior", () => {
    stubMatchMedia(true)
    const section = document.createElement("section")
    section.id = "hero"
    const scroll = vi.fn()
    section.scrollIntoView = scroll
    document.body.appendChild(section)

    expect(revealInPageTarget("hero")).toBe(true)
    expect(scroll.mock.calls[0]?.[0]).toMatchObject({ behavior: "auto", block: "start" })
  })

  it("whenMotionAllowed_thenScrollsSmooth", () => {
    stubMatchMedia(false)
    const section = document.createElement("section")
    section.id = "hero"
    const scroll = vi.fn()
    section.scrollIntoView = scroll
    document.body.appendChild(section)

    expect(revealInPageTarget("hero")).toBe(true)
    expect(scroll.mock.calls[0]?.[0]).toMatchObject({ behavior: "smooth" })
  })

  it("whenFocusTargetLacksTabindex_thenSetsMinusOneBeforeFocus", () => {
    const main = document.createElement("main")
    main.id = "main"
    document.body.appendChild(main)
    expect(main.hasAttribute("tabindex")).toBe(false)

    expect(revealInPageTarget("main", { focus: true })).toBe(true)
    expect(main.getAttribute("tabindex")).toBe("-1")
    expect(document.activeElement).toBe(main)
  })
})
