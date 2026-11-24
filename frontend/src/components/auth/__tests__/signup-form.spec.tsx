// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import ptBR from "@/i18n/messages/pt-BR"
import enUS from "@/i18n/messages/en-US"
import {
  SignupForm,
  cnpjDvOk,
  cpfDvOk,
  maskDocument,
  parseRetryAfterSeconds,
} from "@/components/auth/SignupForm"

const { invoke, toastSuccess } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({ supabase: { functions: { invoke } } }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

const VALID_CPF = "52998224725"
const BAD_DV_CPF = "52998224726"
const VALID_CNPJ = "11444777000161"
const PASSWORD = "senha-segura-1"

function httpError(status: number, retryAfter?: string) {
  return Object.assign(new Error(`edge-${status}`), {
    context: {
      status,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    },
  })
}

function response(status: number, retryAfter?: string) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
  }
}

function renderForm(plano: string | null = null) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <SignupForm plano={plano} />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

function setDocument(value: string) {
  const input = screen.getByLabelText(/cpf|cnpj/i) as HTMLInputElement
  fireEvent.change(input, { target: { value } })
}

async function fillPf(user: ReturnType<typeof userEvent.setup>, cpf = VALID_CPF, password = PASSWORD) {
  await user.type(screen.getByLabelText(/^e-mail$/i), "pessoa@exemplo.com")
  await user.type(screen.getByLabelText(/nome completo/i), "Maria Silva")
  setDocument(cpf)
  fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: password } })
}

async function submit() {
  fireEvent.click(screen.getByRole("button", { name: /criar conta|tentar novamente/i }))
}

beforeEach(() => {
  invoke.mockReset()
  toastSuccess.mockReset()
  invoke.mockResolvedValue({
    data: { ok: true, message: "auth.signup.success" },
    error: null,
    response: response(201),
  })
})

afterEach(() => cleanup())

describe("SIGN-14 — puros ( DV / máscara / Retry-After )", () => {
  it("cpfDvOk/cnpjDvOk espelham os DV do banco e recusam sequências", () => {
    expect(cpfDvOk(VALID_CPF)).toBe(true)
    expect(cpfDvOk(BAD_DV_CPF)).toBe(false)
    expect(cpfDvOk("11111111111")).toBe(false)
    expect(cpfDvOk("123")).toBe(false)
    expect(cnpjDvOk(VALID_CNPJ)).toBe(true)
    expect(cnpjDvOk("11444777000162")).toBe(false)
    expect(cnpjDvOk("00000000000000")).toBe(false)
  })

  it("maskDocument formata CPF/CNPJ e envio usa só dígitos", () => {
    expect(maskDocument(VALID_CPF, "pf")).toBe("529.982.247-25")
    expect(maskDocument(VALID_CNPJ, "pj")).toBe("11.444.777/0001-61")
    expect(maskDocument("529982", "pf")).toBe("529.982")
    expect(maskDocument("abc", "pf")).toBe("")
  })

  it("parseRetryAfterSeconds aceita inteiro positivo e descarta o resto", () => {
    expect(parseRetryAfterSeconds("2")).toBe(2)
    expect(parseRetryAfterSeconds("120")).toBe(120)
    expect(parseRetryAfterSeconds("0")).toBe(0)
    expect(parseRetryAfterSeconds("abc")).toBeNull()
    expect(parseRetryAfterSeconds("-3")).toBeNull()
    expect(parseRetryAfterSeconds(null)).toBeNull()
  })
})

describe("SIGN-14 — anti-enumeração (Bloqueio UX 1)", () => {
  it("sucesso envia kind/documento/razão e mostra estado role=status com toast", async () => {
    const user = userEvent.setup()
    renderForm("full")
    await fillPf(user)
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    expect(await screen.findByRole("status")).toBeTruthy()
    expect(invoke).toHaveBeenCalledTimes(1)
    const [functionName, options] = invoke.mock.calls[0] as [string, { body: Record<string, unknown> }]
    expect(functionName).toBe("signup-public")
    expect(options.body).toMatchObject({
      email: "pessoa@exemplo.com",
      kind: "pf",
      document: VALID_CPF,
      razaoSocial: "Maria Silva",
      plano: "full",
    })
    expect(options.body.document).not.toMatch(/[.\-/]/)
    expect(options.body).not.toHaveProperty("user_id")
    expect(options.body).not.toHaveProperty("tenant_id")
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("201 de conta nova, e-mail duplicado e colisão de documento são byte-idênticos na UI", async () => {
    const user = userEvent.setup()
    const seen: string[] = []
    for (const body of [
      { ok: true, message: "auth.signup.success" },
      { ok: true, message: "auth.signup.success", duplicated: "email" },
      { ok: true, message: "auth.signup.success", duplicated: "document" },
    ]) {
      cleanup()
      invoke.mockResolvedValue({ data: body, error: null, response: response(201) })
      renderForm()
      await fillPf(user)
      fireEvent.click(screen.getByRole("checkbox"))
      await submit()
      const status = await screen.findByRole("status")
      seen.push(status.textContent ?? "")
    }
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).not.toMatch(/já existe|já cadastrado|duplicad|request_id/i)
  })

  it("400 = um texto genérico, preserva valores e foca o form", async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({
      data: null,
      error: httpError(400),
      response: response(400),
    })
    renderForm()
    await fillPf(user)
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/não foi possível/i)
    expect(alert.textContent).not.toMatch(/já existe|já cadastrado|duplicad|request_id|GoTrue|Postgres|\d{3}\.\d{3}/i)
    expect((screen.getByLabelText(/^e-mail$/i) as HTMLInputElement).value).toBe("pessoa@exemplo.com")
    expect((screen.getByLabelText(/cpf/i) as HTMLInputElement).value).toBe("529.982.247-25")
    await waitFor(() => expect(document.activeElement?.tagName).toBe("FORM"))
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("DV errado gera erro de campo genérico sem dizer qual dígito e sem request", async () => {
    const user = userEvent.setup()
    renderForm()
    await fillPf(user, BAD_DV_CPF)
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/documento/i)
    expect(alert.textContent).not.toMatch(/dígito|dígitos|décimo|11|10/)
    expect(invoke).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/request_id|user_id|tenant_id/i)
  })
})

describe("SIGN-14 — erros acionáveis (Bloqueio UX 2)", () => {
  it("429 lê Retry-After para {{seconds}} em aria-live e trava o CTA até zero", async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({
      data: null,
      error: httpError(429, "1"),
      response: response(429, "1"),
    })
    renderForm()
    await fillPf(user)
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    const alert = await screen.findByRole("alert")
    expect(alert.getAttribute("aria-live")).toBe("assertive")
    expect(alert.textContent).toContain("1")
    const cta = screen.getByRole("button", { name: /criar conta/i }) as HTMLButtonElement
    expect(cta.disabled).toBe(true)
    await waitFor(() => expect(cta.disabled).toBe(false), { timeout: 3000 })
  })

  it("500 mostra retry e link de convite, sem detalhe do erro", async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ data: null, error: httpError(500), response: response(500) })
    renderForm()
    await fillPf(user)
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).not.toMatch(/cadastro-falhou|request_id|GoTrue|Postgres/i)
    expect(screen.getByRole("button", { name: /tentar novamente/i })).toBeTruthy()
    expect(screen.getByRole("link", { name: /pedir convite/i }).getAttribute("href")).toContain("/solicitar-convite")
  })

  it("falha de rede cai no mesmo texto de retry sem vazar a mensagem crua", async () => {
    const user = userEvent.setup()
    invoke.mockRejectedValue(new Error("fetch failed user_id=secreto"))
    renderForm()
    await fillPf(user)
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).not.toMatch(/fetch failed|user_id|secreto/i)
    expect(screen.getByRole("button", { name: /tentar novamente/i })).toBeTruthy()
  })
})

describe("SIGN-14 — senha, PF/PJ, aceite e a11y", () => {
  it("senha curta em bytes e senha acima de 72 bytes são recusadas sem request", async () => {
    const user = userEvent.setup()
    renderForm()
    await fillPf(user, VALID_CPF, "curta")
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()
    expect(await screen.findByText(/8 a 72 bytes/i)).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: "é".repeat(40) } })
    await submit()
    expect(await screen.findByText(/8 a 72 bytes/i)).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("senha multibyte dentro de 72 bytes é aceita; ao aceitar job, payload PJ com dígitos", async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValue({ data: { ok: true }, error: null, response: response(201) })
    renderForm()
    await user.type(screen.getByLabelText(/^e-mail$/i), "pj@exemplo.com")
    fireEvent.click(screen.getByRole("radio", { name: /pessoa jurídica/i }))
    fireEvent.change(screen.getByLabelText(/razão social/i), { target: { value: "Empresa Ltda" } })
    setDocument(VALID_CNPJ)
    fireEvent.change(screen.getByLabelText(/^senha$/i), { target: { value: "é".repeat(8) } })
    fireEvent.click(screen.getByRole("checkbox"))
    await submit()

    expect(await screen.findByRole("status")).toBeTruthy()
    const options = (invoke.mock.calls[0] as [string, { body: Record<string, unknown> }])[1]
    expect(options.body.kind).toBe("pj")
    expect(options.body.document).toBe(VALID_CNPJ)
    expect(options.body.razaoSocial).toBe("Empresa Ltda")
  })

  it("troca PF→PJ limpa documento e erro e anuncia via aria-live", async () => {
    const user = userEvent.setup()
    renderForm()
    setDocument(VALID_CPF)
    await user.click(screen.getByRole("radio", { name: /pessoa jurídica/i }))

    expect((screen.getByLabelText(/cnpj/i) as HTMLInputElement).value).toBe("")
    expect(screen.queryByLabelText(/cpf/i)).toBeNull()
    const live = screen.getByText(/tipo de cadastro alterado/i)
    expect(live.getAttribute("aria-live")).toBe("polite")
  })

  it("CTA habilitado sem aceite; aceite gera erro inline sem request", async () => {
    const user = userEvent.setup()
    renderForm()
    const cta = screen.getByRole("button", { name: /criar conta/i }) as HTMLButtonElement
    expect(cta.disabled).toBe(false)
    await fillPf(user)
    fireEvent.click(cta)
    expect(await screen.findByText(/aceite os termos/i)).toBeTruthy()
    expect(invoke).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("checkbox")))
  })

  it("marcações a11y: noValidate, autocomplete, aria-busy, fieldset/legend, eye e alvos 44px", async () => {
    const user = userEvent.setup()
    const { container } = renderForm()
    const form = container.querySelector("form") as HTMLFormElement
    expect(form.hasAttribute("novalidate")).toBe(true)
    expect(form.getAttribute("aria-busy")).toBe("false")
    expect(screen.getByLabelText(/^e-mail$/i).getAttribute("autocomplete")).toBe("email")
    const password = screen.getByLabelText(/^senha$/i) as HTMLInputElement
    expect(password.getAttribute("autocomplete")).toBe("new-password")
    expect(screen.queryByLabelText(/confirmar/i)).toBeNull()
    expect(container.querySelectorAll('input[type="number"]').length).toBe(0)

    const fieldset = container.querySelector("fieldset") as HTMLFieldSetElement
    expect(fieldset).toBeTruthy()
    expect(fieldset.querySelector("legend")).toBeTruthy()

    const doc = screen.getByLabelText(/cpf/i) as HTMLInputElement
    expect(doc.getAttribute("inputmode")).toBe("numeric")
    expect(doc.className).toContain("font-mono")

    const eye = screen.getByRole("button", { name: /mostrar senha/i })
    expect(eye.getAttribute("aria-pressed")).toBe("false")
    expect(eye.className).toContain("min-h-11")
    await user.click(eye)
    expect(password.type).toBe("text")
    expect(screen.getByRole("button", { name: /ocultar senha/i }).getAttribute("aria-pressed")).toBe("true")

    for (const name of [/entrar/i, /pedir convite/i]) {
      const link = screen.getByRole("link", { name }) as HTMLAnchorElement
      expect(link.className).toContain("min-h-11")
    }
  })

  it("aria-invalid/aria-describedby ligam erro ao campo", async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText(/^e-mail$/i), "invalido")
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: /criar conta/i }))
    await screen.findByText(/e-mail válido/i)
    const email = screen.getByLabelText(/^e-mail$/i) as HTMLInputElement
    expect(email.getAttribute("aria-invalid")).toBe("true")
    expect(email.getAttribute("aria-describedby")).toBe("signup-email-error")
  })
})

describe("SIGN-14 — i18n e higiene de escopo", () => {
  it("catálogos pt-BR/en-US têm as mesmas chaves auth.signup e placeholders", () => {
    expect(Object.keys(ptBR.auth.signup).sort()).toEqual(Object.keys(enUS.auth.signup).sort())
    for (const catalog of [ptBR, enUS]) {
      expect(catalog.auth.signup.rateLimited).toContain("{{seconds}}")
      expect(catalog.auth.signup.termsVersion).toBe("termos-2026-11-v1")
    }
    expect(ptBR.tenant.acceptTerms).toContain("{{version}}")
    expect(enUS.tenant.acceptTerms).toContain("{{version}}")
  })

  it("componente não contém escopo negativo nem fallback de senha curta", () => {
    const source = readFileSync(resolve(process.cwd(), "frontend/src/components/auth/SignupForm.tsx"), "utf8")
    expect(source).not.toMatch(/duplicateError|emailError|SignupWizardCard|type=["']number["']|min\(6\)|request_id|GoTrue|Postgres/i)
  })
})
