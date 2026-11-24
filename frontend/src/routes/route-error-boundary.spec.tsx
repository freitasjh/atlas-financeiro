// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { RouteErrorBoundary } from "@/routes/route-error-boundary"

function ThrowingChild(): never {
  throw new Error("Failed to fetch dynamically imported module")
}

describe("whenRouteChunkFails_thenErrorUiWithReloadIsVisible", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // React loga o erro capturado pelo boundary — silencia só nesse teste.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    consoleErrorSpy.mockRestore()
    cleanup()
  })

  it("não fica branca: mostra alert com botão Recarregar", () => {
    render(
      <RouteErrorBoundary>
        <ThrowingChild />
      </RouteErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(screen.getByRole("button", { name: /recarregar/i })).toBeTruthy()
  })

  it("sem erro, renderiza children normalmente", () => {
    render(
      <RouteErrorBoundary>
        <div data-testid="child" />
      </RouteErrorBoundary>,
    )
    expect(screen.getByTestId("child")).toBeTruthy()
  })
})
