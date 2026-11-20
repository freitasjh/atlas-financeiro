// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

const { signInWithPassword } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithPassword } },
}))

import i18n from "@/i18n"
import { LoginForm } from "@/components/shadcn/auth/login-form"

function renderLogin() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/login"]}>
        <LoginForm forgotPasswordHref="/login?modo=recuperar" />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

beforeEach(() => {
  signInWithPassword.mockReset()
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage("pt-BR")
})

// H3 passo 8 (i18n misto) — superfície de auth não pode manter pt-BR em en-US.
describe("whenLoginFormRenderedInEnUs_thenNoPortugueseCopyRemains", () => {
  it("cabeçalho, labels, botões e rodapé vêm de auth.*", async () => {
    await i18n.changeLanguage("en-US")
    renderLogin()

    expect(screen.getByRole("heading", { name: "Sign in to your account" })).toBeTruthy()
    expect(screen.getByText(/enter your email and password/i)).toBeTruthy()
    expect(screen.getByLabelText("Email")).toBeTruthy()
    expect(screen.getByLabelText("Password")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Forgot my password" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy()

    const text = document.body.textContent ?? ""
    for (const pt of [
      "Entrar na sua conta",
      "Informe seu e-mail e senha",
      "E-mail",
      "Senha",
      "Entrar",
      "Esqueci minha senha",
      "Mostrar",
      "Ocultar",
      "Ambiente seguro",
      "protegidos com criptografia",
    ]) {
      expect(text, `pt-BR remanescente: ${pt}`).not.toContain(pt)
    }
  })

  it("hint de Caps Lock traduz", async () => {
    await i18n.changeLanguage("en-US")
    renderLogin()

    const password = screen.getByLabelText("Password")
    const event = new window.KeyboardEvent("keydown", { key: "A", bubbles: true })
    Object.defineProperty(event, "getModifierState", { value: () => true })
    fireEvent(password, event)

    await waitFor(() => {
      expect(screen.getByText("Caps Lock is on")).toBeTruthy()
    })
    expect(document.body.textContent).not.toContain("Caps Lock ativado")
  })

  it("erro de validação zod sai no idioma ativo", async () => {
    await i18n.changeLanguage("en-US")
    renderLogin()

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nao-e-email" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await waitFor(() => {
      expect(screen.getByText("Enter a valid email.")).toBeTruthy()
    })
    expect(document.body.textContent).not.toContain("Informe um e-mail válido.")
  })

  it("mensagens de servidor traduzem (credencial inválida)", async () => {
    await i18n.changeLanguage("en-US")
    signInWithPassword.mockResolvedValue({
      error: { status: 400, message: "Invalid login credentials" },
    })
    renderLogin()

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "segredo123" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Invalid email or password.")
    })
  })
})

// H3 passo 9 — alvos de toque ≥44px no mobile (375x800), sem mexer no desktop.
describe("whenLoginFormAtMobile_thenTouchTargetsAre44", () => {
  it("inputs têm h-11 até sm e voltam a h-10 no desktop", () => {
    renderLogin()
    for (const label of ["E-mail", "Senha"]) {
      const input = screen.getByLabelText(label)
      expect(input.className).toMatch(/\bh-11\b/)
      expect(input.className).toMatch(/\bsm:h-10\b/)
    }
  })
})
