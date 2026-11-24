// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"

import { signInSchema } from "./login-form"

const { signInWithPassword } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithPassword,
    },
  },
}))

import { LoginForm } from "./login-form"
import "@/i18n"

describe("signInSchema", () => {
  it("aceita e-mail válido e senha com 6+ caracteres", () => {
    const result = signInSchema.safeParse({
      email: "voce@empresa.com.br",
      password: "senha1234",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita e-mail inválido", () => {
    const result = signInSchema.safeParse({
      email: "email-invalido",
      password: "senha1234",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita senha com menos de 6 caracteres", () => {
    const result = signInSchema.safeParse({
      email: "voce@empresa.com.br",
      password: "curta",
    })
    expect(result.success).toBe(false)
  })
})

describe("LoginForm", () => {
  beforeEach(() => {
    signInWithPassword.mockReset()
  })
  afterEach(() => {
    cleanup()
  })

  it("chama signInWithPassword com credenciais no sucesso", async () => {
    signInWithPassword.mockResolvedValue({ error: null })
    const user = userEvent.setup()
    render(<LoginForm />)

    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(document.getElementById("password") as HTMLElement, "senha1234")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "voce@empresa.com.br",
        password: "senha1234",
      })
    })
  })

  it("whenLoginSucceeds_thenNavigatesToRedirectTo", async () => {
    signInWithPassword.mockResolvedValue({ error: null })
    window.location.hash = ""
    const user = userEvent.setup()
    render(<LoginForm redirectTo="#/contas" />)

    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(document.getElementById("password") as HTMLElement, "senha1234")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(window.location.hash).toBe("#/contas")
    })
  })

  it("whenLoginSucceedsWithoutRedirectTo_thenNavigatesToRoot", async () => {
    signInWithPassword.mockResolvedValue({ error: null })
    window.location.hash = ""
    const user = userEvent.setup()
    render(<LoginForm />)

    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(document.getElementById("password") as HTMLElement, "senha1234")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(window.location.hash).toBe("#/")
    })
  })

  it("exibe alerta genérico e limpa senha em erro de credenciais", async () => {
    signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials", status: 400 },
    })
    const user = userEvent.setup()
    render(<LoginForm />)

    const passwordInput = document.getElementById("password") as HTMLInputElement
    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(passwordInput, "senha1234")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(screen.getByText("E-mail ou senha inválidos.")).toBeTruthy()
    })
    await waitFor(() => {
      expect(passwordInput.value).toBe("")
    })
  })

  it("renderiza estado de carregamento", async () => {
    let resolveFn: (v: unknown) => void
    signInWithPassword.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve
        })
    )
    const user = userEvent.setup()
    render(<LoginForm />)

    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(document.getElementById("password") as HTMLElement, "senha1234")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(screen.getByText("Entrando...")).toBeTruthy()
    })
    // cleanup
    resolveFn!({ error: null })
  })

  it("whenForgotPasswordHrefPassed_thenRendersRecoveryLink", () => {
    render(
      <MemoryRouter>
        <LoginForm forgotPasswordHref="/login?modo=recuperar" />
      </MemoryRouter>,
    )
    const link = screen.getByRole("link", { name: /esqueci minha senha/i })
    expect(link.getAttribute("href")).toBe("/login?modo=recuperar")
  })
})
