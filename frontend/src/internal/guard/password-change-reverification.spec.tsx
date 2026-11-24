// @vitest-environment happy-dom
/**
 * Regressão do loop de primeiro acesso: trocar a senha em /definir-senha e
 * voltar para /internal precisa gerar uma **segunda** chamada à Edge
 * verify-operator. O veredito antigo (`first-access`) não pode ser reaproveitado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

const { getSession, updateUser, toastSuccess, verify } = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  toastSuccess: vi.fn(),
  verify: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession, updateUser } },
}))

vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

import i18n from "@/i18n"
import { SetPasswordPage } from "@/pages/SetPasswordPage"
import { RequireInternalOperator } from "./RequireInternalOperator"
import { configureOperatorRuntime, useInternalOperator } from "./use-internal-operator"

const OPERATOR_WIRE = {
  status: 200,
  body: { is_operator: true, aal: "aal2", user_id: "u-1" },
  failure: null,
}

function renderFlow() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/definir-senha?origem=convite&retorno=/internal"]}>
        <Routes>
          <Route path="/definir-senha" element={<SetPasswordPage />} />
          <Route
            path="/internal"
            element={
              <RequireInternalOperator>
                <div data-testid="internal-child" />
              </RequireInternalOperator>
            }
          />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({
    data: { session: { user: { id: "u-1", email: "a@b.com" } } },
    error: null,
  })
  updateUser.mockReset().mockResolvedValue({ data: { user: { id: "u-1" } }, error: null })
  toastSuccess.mockReset()
  verify.mockReset().mockResolvedValue(OPERATOR_WIRE)

  useInternalOperator.getState().reset()
  useInternalOperator.setState({ state: "first-access", checkedAt: 1_000 })
  configureOperatorRuntime({
    sessionKey: async () => ({ userId: "u-1", aalKey: "aal1" }),
    verify,
  })
})

afterEach(() => {
  configureOperatorRuntime(null)
  useInternalOperator.getState().reset()
  cleanup()
})

describe("passwordChange → guard reentry", () => {
  it("whenSenhaTrocada_thenGuardReverificaERenderizaChildren", async () => {
    const user = userEvent.setup()
    renderFlow()

    const input = await screen.findByLabelText(/nova senha/i)
    await user.type(input, "senha-segura-1")
    await user.click(screen.getByRole("button", { name: /salvar senha/i }))

    // Sem o reset, o guard via `first-access` obsoleto e voltava para esta tela.
    expect(await screen.findByTestId("internal-child")).toBeTruthy()
    expect(verify).toHaveBeenCalledTimes(1)
    expect(useInternalOperator.getState().state).toBe("operator")
    expect(screen.queryByLabelText(/nova senha/i)).toBeNull()
  })
})
