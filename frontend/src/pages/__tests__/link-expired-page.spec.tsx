// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import { LinkExpiredPage } from "@/pages/LinkExpiredPage"

afterEach(() => cleanup())

function renderAt(search: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/link-expirado${search}`]}>
        <LinkExpiredPage />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe("LinkExpiredPage", () => {
  it("whenMotivoIsExpirado_thenShowsExpiredCopy", () => {
    const { container } = renderAt("?motivo=expirado")
    expect(container.textContent).toContain("Este link expirou")
    expect(container.textContent).toContain("valem por 1 hora")
  })

  it("whenMotivoIsConsumido_thenShowsConsumedCopy", () => {
    const { container } = renderAt("?motivo=consumido")
    expect(container.textContent).toContain("Este link já foi usado")
  })

  it("whenMotivoIsInvalid_thenShowsInvalidCopy", () => {
    const { container } = renderAt("?motivo=invalido")
    expect(container.textContent).toContain("Este link não é válido")
  })

  it("whenMotivoIsSemSessao_thenShowsNoSessionCopy", () => {
    const { container } = renderAt("?motivo=sem-sessao")
    expect(container.textContent).toContain("Você precisa de um link válido")
  })

  it("whenMotivoIsMissingOrUnknown_thenDefaultsToInvalid", () => {
    expect(renderAt("").container.textContent).toContain("Este link não é válido")
    cleanup()
    expect(renderAt("?motivo=qualquer").container.textContent).toContain("Este link não é válido")
  })

  it("whenRendered_thenHasExactlyOneTabStopAndNoForbiddenActions", () => {
    const { container } = renderAt("?motivo=expirado")
    const tabbable = container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0].getAttribute("href")).toBe("/login")
    expect(container.textContent).not.toContain("Reenviar link")
    expect(container.textContent).not.toContain("mailto:")
    expect(container.textContent).not.toContain("error_description")
    expect(container.textContent).not.toContain("tente novamente em alguns minutos")
    expect(container.textContent).toContain("Se você já definiu sua senha")
  })
})
