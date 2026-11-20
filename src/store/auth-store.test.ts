// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { getSession, onAuthStateChange, clearAllSessionCookies } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
  clearAllSessionCookies: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession, onAuthStateChange } },
}))

vi.mock("@/lib/supabase-cookie-storage", () => ({
  clearAllSessionCookies,
}))

import { useAuthStore, SESSION_INIT_TIMEOUT_MS } from "@/store/auth-store"

function resetStore() {
  useAuthStore.setState({ status: "idle", user: null, error: null, initialized: false })
}

describe("whenGetSessionReturnsAuthError_thenCookiesClearedAndUnauthenticated", () => {
  beforeEach(() => {
    getSession.mockReset()
    clearAllSessionCookies.mockClear()
    onAuthStateChange.mockClear()
    resetStore()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("limpa cookies sb-* e marca unauthenticated em erro 400 de refresh", async () => {
    getSession.mockResolvedValue({
      data: null,
      error: { message: "Invalid Refresh Token", status: 400 },
    })

    await useAuthStore.getState().init()

    expect(clearAllSessionCookies).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().status).toBe("unauthenticated")
    expect(useAuthStore.getState().user).toBeNull()
    expect(useAuthStore.getState().initialized).toBe(true)
  })

  it("mantém cookies e estado em sessão válida", async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "a@b.com" } } },
    })

    await useAuthStore.getState().init()

    expect(clearAllSessionCookies).not.toHaveBeenCalled()
    expect(useAuthStore.getState().status).toBe("authenticated")
    expect(useAuthStore.getState().user).toEqual({ id: "u1", email: "a@b.com" })
  })

  it("sem sessão não limpa cookies nem entra em erro", async () => {
    getSession.mockResolvedValue({ data: { session: null } })

    await useAuthStore.getState().init()

    expect(clearAllSessionCookies).not.toHaveBeenCalled()
    expect(useAuthStore.getState().status).toBe("unauthenticated")
  })
})

describe("whenGetSessionFails_thenErrorStateIsRetryable", () => {
  beforeEach(() => {
    getSession.mockReset()
    clearAllSessionCookies.mockClear()
    onAuthStateChange.mockClear()
    resetStore()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("exceção de rede vai para status error (não branca infinita)", async () => {
    getSession.mockRejectedValue(new Error("network failure"))

    await useAuthStore.getState().init()

    expect(useAuthStore.getState().status).toBe("error")
    expect(useAuthStore.getState().initialized).toBe(true)
    // Falha transitória: cookies válidos são PRESERVADOS (sem re-login forçado).
    expect(clearAllSessionCookies).not.toHaveBeenCalled()
    // Erro técnico cru nunca vaza pro UI — mensagem amigável.
    expect(useAuthStore.getState().error).toBe("Falha ao carregar sessão")
  })

  it("timeout do boot mapeia para mensagem amigável (não erro cru)", async () => {
    vi.useFakeTimers()
    getSession.mockImplementation(() => new Promise(() => {}))

    const pending = useAuthStore.getState().init()
    await vi.advanceTimersByTimeAsync(SESSION_INIT_TIMEOUT_MS + 1)
    await pending

    expect(useAuthStore.getState().error).toBe(
      "A verificação da sessão demorou mais que o esperado.",
    )
    expect(clearAllSessionCookies).not.toHaveBeenCalled()
  })

  it("getSession pendurado cai em error após timeout", async () => {
    vi.useFakeTimers()
    getSession.mockImplementation(() => new Promise(() => {}))

    const pending = useAuthStore.getState().init()
    await vi.advanceTimersByTimeAsync(SESSION_INIT_TIMEOUT_MS + 1)
    await pending

    expect(useAuthStore.getState().status).toBe("error")
    expect(useAuthStore.getState().initialized).toBe(true)
  })

  it("retryInit reinicializa e recupera sessão após erro", async () => {
    getSession.mockRejectedValueOnce(new Error("boom"))
    await useAuthStore.getState().init()
    expect(useAuthStore.getState().status).toBe("error")

    getSession.mockResolvedValue({
      data: { session: { user: { id: "u2", email: null } } },
    })
    await useAuthStore.getState().retryInit()

    expect(useAuthStore.getState().status).toBe("authenticated")
    expect(useAuthStore.getState().user).toEqual({ id: "u2", email: null })
  })

  it("retryInit desinscreve subscription anterior (sem listeners duplicados)", async () => {
    const unsubscribe1 = vi.fn()
    const unsubscribe2 = vi.fn()
    let call = 0
    onAuthStateChange.mockImplementation(() => {
      call += 1
      return { data: { subscription: { unsubscribe: call === 1 ? unsubscribe1 : unsubscribe2 } } }
    })

    await useAuthStore.getState().init()
    expect(onAuthStateChange).toHaveBeenCalledTimes(1)

    getSession.mockResolvedValue({ data: { session: null } })
    await useAuthStore.getState().retryInit()

    expect(onAuthStateChange).toHaveBeenCalledTimes(2)
    // Listener antigo removido antes de registrar o novo.
    expect(unsubscribe1).toHaveBeenCalledTimes(1)
    expect(unsubscribe1.mock.invocationCallOrder[0]).toBeLessThan(
      onAuthStateChange.mock.invocationCallOrder[1],
    )
    expect(unsubscribe2).not.toHaveBeenCalled()
  })
})
