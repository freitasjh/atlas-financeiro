// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import { RequestInvitePage } from "@/pages/RequestInvitePage"

afterEach(() => cleanup())

describe("RequestInvitePage", () => {
  it("whenRendered_thenExplainsInviteOnlyWithoutForm", () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/solicitar-convite"]}>
          <RequestInvitePage />
        </MemoryRouter>
      </I18nextProvider>,
    )
    expect(screen.getByRole("heading", { name: /acesso por convite/i })).toBeTruthy()
    expect(container.textContent).toContain("O Atlas é por convite")
    expect(container.querySelector("form")).toBeNull()
    expect(container.querySelector("input")).toBeNull()
    expect(container.textContent).not.toMatch(/prazo|em até|dias úteis/i)
  })

  it("whenRendered_thenOffersLoginAndBackToSiteWithTouchTargets", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/solicitar-convite"]}>
          <RequestInvitePage />
        </MemoryRouter>
      </I18nextProvider>,
    )
    const login = screen.getByRole("link", { name: /ir para o login/i })
    const back = screen.getByRole("link", { name: /voltar ao site/i })
    expect(login.getAttribute("href")).toBe("/login")
    expect(back.getAttribute("href")).toBe("/landing")
    expect(login.className).toMatch(/h-11/)
    expect(back.className).toMatch(/h-11/)
  })
})
