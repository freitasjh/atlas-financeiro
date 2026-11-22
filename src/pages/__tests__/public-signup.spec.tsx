// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import { PublicSignupPage } from "@/pages/PublicSignupPage"

const { invoke, toastSuccess } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke } } }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

function renderAt(path: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <PublicSignupPage />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

async function fillAndSubmit() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText(/^e-mail$/i), "nova@exemplo.com")
  await user.type(screen.getByLabelText(/nome completo/i), "Nova Pessoa")
  fireEvent.change(screen.getByLabelText(/cpf/i), { target: { value: "52998224725" } })
  fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: "senha-segura-1" } })
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: /criar conta/i }))
}

beforeEach(() => {
  invoke.mockReset()
  toastSuccess.mockReset()
  invoke.mockResolvedValue({ data: { ok: true }, error: null, response: { status: 201 } })
})

afterEach(() => cleanup())

describe("SIGN-14 — PublicSignupPage", () => {
  it("monta AuthShell + formulário com split 50/50 no desktop e card adaptável", () => {
    const { container } = renderAt("/register")
    const shell = container.querySelector("div.grid") as HTMLDivElement
    expect(shell.className).toContain("lg:grid-cols-2")
    expect(shell.className).not.toContain("md:grid-cols-2")
    const card = container.querySelector("main > div") as HTMLDivElement
    expect(card.className).toContain("w-full")
    expect(card.className).toContain("max-w-sm")
    expect(card.className).toContain("lg:max-w-md")
    const inner = card.firstElementChild as HTMLDivElement
    expect(inner.className).toContain("p-6")
    expect(screen.getByRole("heading", { name: /crie sua conta/i })).toBeTruthy()
    expect(container.querySelector("form")).toBeTruthy()
  })

  it("preserva ?plano= no payload e nos links secundários", async () => {
    renderAt("/register?plano=full")
    expect(screen.getByRole("link", { name: /pedir convite/i }).getAttribute("href")).toContain("plano=full")
    expect(screen.getByRole("link", { name: /entrar/i }).getAttribute("href")).toContain("plano=full")
    await fillAndSubmit()
    expect(await screen.findByRole("status")).toBeTruthy()
    const options = (invoke.mock.calls[0] as [string, { body: Record<string, unknown> }])[1]
    expect(options.body.plano).toBe("full")
  })

  it("não promete plano pago quando ?plano=pro", () => {
    const { container } = renderAt("/signup?plano=pro")
    expect(container.textContent).not.toMatch(/\bpro\b|profissional|checkout|assinar|pagamento|plano pago/i)
    expect(screen.getByRole("link", { name: /pedir convite/i })).toBeTruthy()
  })

  it("375px: controles h-11/min-h-11 e min-w-0 sem largura fixa", () => {
    const { container } = renderAt("/register")
    for (const control of container.querySelectorAll(
      'form input:not([type="radio"]):not([type="checkbox"]), form button',
    )) {
      expect((control as HTMLElement).className).toMatch(/h-11|min-h-11/)
    }
    for (const radio of container.querySelectorAll('form input[type="radio"]')) {
      expect((radio.parentElement as HTMLElement).className).toContain("min-h-11")
    }
    const doc = screen.getByLabelText(/cpf/i) as HTMLInputElement
    expect(doc.className).toContain("min-w-0")
    expect(screen.getByRole("button", { name: /criar conta/i }).className).toContain("w-full")
    expect(container.querySelector("[style*='width']")).toBeNull()
  })

  it("/register e /signup renderizam a mesma superfície sem redirect", () => {
    // IDs de gradiente do logo vêm de useId; normaliza antes de comparar.
    const normalize = (html: string) => html.replace(/_r_\d+_/g, "_r_N_")
    const a = renderAt("/register")
    const registerHtml = normalize(a.container.innerHTML)
    cleanup()
    const b = renderAt("/signup")
    expect(normalize(b.container.innerHTML)).toBe(registerHtml)
    expect(b.container.textContent).not.toMatch(/acesso por convite/i)
  })
})
