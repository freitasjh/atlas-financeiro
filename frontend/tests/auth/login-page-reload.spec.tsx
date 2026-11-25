// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

import { clearSession } from "../../src/session/session"
import { useAuthStore } from "../../src/store/auth-store"
import { LoginPage } from "../../src/pages/LoginPage"
import "../../src/i18n"

const fetchMock = vi.fn()

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>destino</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("AUTH-10 — reload sem sessão persistida", () => {
  beforeEach(() => {
    clearSession()
    useAuthStore.setState({
      status: "idle",
      user: null,
      error: null,
      initialized: false,
      reLoginRequired: false,
    })
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    cleanup()
    clearSession()
    vi.unstubAllGlobals()
  })

  it("whenReload_thenLoginRequiredAndNoticeShown", async () => {
    renderLoginPage()

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Sua sessão não foi mantida ao recarregar a página. Entre novamente para continuar.",
      )
    })
    expect(screen.getByRole("heading", { name: /entrar na sua conta/i })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
