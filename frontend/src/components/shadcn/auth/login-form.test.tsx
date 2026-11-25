// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"

import {
  authorizationHeader,
  clearSession,
  CLIENTE_APP_IDENTITY,
  currentSession,
  JWT_ALGORITHM,
} from "@/session/session"
import { signInSchema } from "./login-form"

const fetchMock = vi.fn()

function encode(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function accessToken(): string {
  return `${encode({ alg: JWT_ALGORITHM, typ: "JWT" })}.${encode({
    iss: CLIENTE_APP_IDENTITY.issuer,
    aud: CLIENTE_APP_IDENTITY.audience,
    context: CLIENTE_APP_IDENTITY.context,
    sub: "user-1",
    role: "admin",
  })}.assinatura`
}

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response
}

function loginResponse() {
  return response(200, {
    version: "v1",
    data: { accessToken: accessToken(), refreshToken: "refresh-opaco", expiresIn: 900 },
  })
}

async function submitLogin(redirectTo?: string) {
  const user = userEvent.setup()
  render(<LoginForm redirectTo={redirectTo} />)
  await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
  await user.type(document.getElementById("password") as HTMLElement, "senha12345678")
  await user.click(screen.getByRole("button", { name: /entrar/i }))
}

import { LoginForm } from "./login-form"
import "@/i18n"

describe("signInSchema", () => {
  it("aceita e-mail válido e senha com 12+ caracteres", () => {
    const result = signInSchema.safeParse({
      email: "voce@empresa.com.br",
      password: "senha12345678",
    })
    expect(result.success).toBe(true)
  })

  it("rejeita e-mail inválido", () => {
    const result = signInSchema.safeParse({
      email: "email-invalido",
      password: "senha12345678",
    })
    expect(result.success).toBe(false)
  })

  it("rejeita senha com menos de 12 caracteres antes do fetch", () => {
    const result = signInSchema.safeParse({
      email: "voce@empresa.com.br",
      password: "senha12345",
    })
    expect(result.success).toBe(false)
  })
})

describe("LoginForm — transporte via fetch e sessão em memória", () => {
  beforeEach(() => {
    clearSession()
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    window.location.hash = ""
  })

  afterEach(() => {
    cleanup()
    clearSession()
    vi.unstubAllGlobals()
  })

  it("whenLoginSucceeds_thenTokensLiveOnlyInMemory", async () => {
    fetchMock.mockResolvedValue(loginResponse())
    const setItem = vi.spyOn(Storage.prototype, "setItem")

    await submitLogin()
    await waitFor(() => expect(currentSession()).not.toBeNull())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/auth/login")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      email: "voce@empresa.com.br",
      password: "senha12345678",
    })
    expect(currentSession()).toEqual({ access: accessToken(), refresh: "refresh-opaco" })
    expect(authorizationHeader()).toBe(`Bearer ${accessToken()}`)
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it("whenUnauthorized_thenMemoryCleared", async () => {
    fetchMock.mockResolvedValue(response(401))
    await submitLogin()

    await waitFor(() => {
      expect(screen.getByText("E-mail ou senha inválidos.")).toBeTruthy()
    })
    expect(currentSession()).toBeNull()
  })

  it("whenRateLimited_thenTooManyAttemptsMessage", async () => {
    fetchMock.mockResolvedValue(response(429, {}, { "retry-after": "60" }))
    await submitLogin()

    await waitFor(() => {
      expect(screen.getByText("Muitas tentativas. Aguarde alguns minutos.")).toBeTruthy()
    })
    expect(currentSession()).toBeNull()
  })

  it("whenNetworkFails_thenNetworkErrorMessage", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch"))
    await submitLogin()

    await waitFor(() => {
      expect(screen.getByText("Não foi possível conectar. Tente novamente.")).toBeTruthy()
    })
  })

  it("whenShortPassword_thenNoFetchIsMade", async () => {
    const user = userEvent.setup()
    render(<LoginForm />)
    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(document.getElementById("password") as HTMLElement, "senha12345")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(screen.getByText("A senha deve ter pelo menos 12 caracteres.")).toBeTruthy()
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("whenLoginSucceeds_thenNavigatesToRedirectTo", async () => {
    fetchMock.mockResolvedValue(loginResponse())
    await submitLogin("#/contas")
    await waitFor(() => expect(window.location.hash).toBe("#/contas"))
  })

  it("whenLoginSucceedsWithoutRedirectTo_thenNavigatesToRoot", async () => {
    fetchMock.mockResolvedValue(loginResponse())
    await submitLogin()
    await waitFor(() => expect(window.location.hash).toBe("#/"))
  })

  it("exibe alerta genérico e limpa senha em erro de credenciais", async () => {
    fetchMock.mockResolvedValue(response(400, { version: "v1", field: "password", message: "rejeitado" }))
    const user = userEvent.setup()
    render(<LoginForm />)
    const passwordInput = document.getElementById("password") as HTMLInputElement
    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(passwordInput, "senha12345678")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => {
      expect(screen.getByText("E-mail ou senha inválidos.")).toBeTruthy()
    })
    await waitFor(() => expect(passwordInput.value).toBe(""))
  })

  it("renderiza estado de carregamento", async () => {
    let resolveFn: (v: unknown) => void
    fetchMock.mockImplementation(
      () => new Promise((resolve) => { resolveFn = resolve }),
    )
    const user = userEvent.setup()
    render(<LoginForm />)
    await user.type(document.getElementById("email") as HTMLElement, "voce@empresa.com.br")
    await user.type(document.getElementById("password") as HTMLElement, "senha12345678")
    await user.click(screen.getByRole("button", { name: /entrar/i }))

    await waitFor(() => expect(screen.getByText("Entrando...")).toBeTruthy())
    resolveFn!(loginResponse())
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
