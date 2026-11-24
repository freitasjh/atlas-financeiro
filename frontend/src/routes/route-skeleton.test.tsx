// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import i18n from "@/i18n"
import { RouteSkeleton } from "./route-skeleton"

describe("RouteSkeleton (i18n)", () => {
  afterEach(cleanup)

  it("whenDefault_thenLabelFromCommonLoading", () => {
    render(<RouteSkeleton />)
    const status = screen.getByRole("status")
    expect(status.textContent).toContain(i18n.t("common.loading"))
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it("whenCustomLabel_thenLabelRenderedWithEllipsis", () => {
    render(<RouteSkeleton label="Verificando sessão" />)
    expect(screen.getByRole("status").textContent).toContain("Verificando sessão…")
  })
})
