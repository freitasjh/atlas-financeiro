// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import { AuthShell } from "@/components/shadcn/auth/auth-shell"

function renderShell() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AuthShell>
          <p>conteúdo</p>
        </AuthShell>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

afterEach(() => cleanup())

// H3 passo 9 — moldura pública de auth (login + solicitar convite).
describe("whenAuthShellAtMobile_thenThemeAndLogoAreTouchTargets", () => {
  it("botão de tema tem 44px no mobile (36 no desktop)", () => {
    const { container } = renderShell()
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-pressed]',
    )
    expect(toggle).not.toBeNull()
    expect(toggle?.className).toMatch(/\bmax-sm:min-h-11\b/)
    expect(toggle?.className).toMatch(/\bmax-sm:min-w-11\b/)
  })

  it("marca/link para a landing tem área clicável de 44px no mobile", () => {
    const { container } = renderShell()
    const logo = container.querySelector<HTMLAnchorElement>('a[href="#/landing"]')
    expect(logo).not.toBeNull()
    expect(logo?.className).toMatch(/\bmax-sm:min-h-11\b/)
  })
})

// ARIA do alternador não pode vazar pt-BR em en-US.
describe("whenModeToggleInEnUs_thenLabelTranslated", () => {
  it("aria-label e title seguem o idioma ativo", async () => {
    await i18n.changeLanguage("en-US")
    const { container } = renderShell()
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    expect(toggle?.getAttribute("aria-label")).toBe(i18n.t("shell.toggleTheme"))
    expect(toggle?.getAttribute("aria-label")).not.toMatch(/Ativar tema/)
    await i18n.changeLanguage("pt-BR")
  })
})
