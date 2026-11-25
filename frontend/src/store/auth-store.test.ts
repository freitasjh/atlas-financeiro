// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import {
  authorizationHeader,
  clearSession,
  CLIENTE_APP_IDENTITY,
  currentSession,
  JWT_ALGORITHM,
  setSession,
} from "@/session/session"
import { useAuthStore, SESSION_INIT_TIMEOUT_MS } from "@/store/auth-store"

function encode(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function accessToken(role = "admin"): string {
  return `${encode({ alg: JWT_ALGORITHM, typ: "JWT" })}.${encode({
    iss: CLIENTE_APP_IDENTITY.issuer,
    aud: CLIENTE_APP_IDENTITY.audience,
    context: CLIENTE_APP_IDENTITY.context,
    sub: "user-1",
    role,
  })}.assinatura`
}

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

function resetStore() {
  useAuthStore.setState({
    status: "idle",
    user: null,
    error: null,
    initialized: false,
    reLoginRequired: false,
  })
}

const fetchMock = vi.fn()

describe("AUTH-10 — wrapper em memória ligado ao contrato v1", () => {
  beforeEach(() => {
    resetStore()
    clearSession()
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearSession()
  })

  it("whenReload_thenLoginRequiredAndNoticeShown", async () => {
    await useAuthStore.getState().init()

    expect(currentSession()).toBeNull()
    expect(useAuthStore.getState().status).toBe("unauthenticated")
    expect(useAuthStore.getState().reLoginRequired).toBe(true)
    // Sem memória: nenhuma chamada de rede — a checagem depends do token local.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("whenUnauthorized_thenMemoryCleared", async () => {
    setSession(accessToken(), "refresh-opaco")
    fetchMock.mockResolvedValue(response(401))

    await useAuthStore.getState().init()

    expect(currentSession()).toBeNull()
    expect(authorizationHeader()).toBeNull()
    expect(useAuthStore.getState().status).toBe("unauthenticated")
    expect(useAuthStore.getState().reLoginRequired).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("whenCheckSucceeds_thenUserComesFromAccessClaims", async () => {
    setSession(accessToken("admin"), "refresh-opaco")
    fetchMock.mockResolvedValue(
      response(200, { authorized: true, context: "cliente", role: "admin" }),
    )

    await useAuthStore.getState().init()

    expect(useAuthStore.getState().status).toBe("authenticated")
    expect(useAuthStore.getState().user).toEqual({ id: "user-1", email: null, role: "admin" })
    expect(useAuthStore.getState().reLoginRequired).toBe(false)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/auth/check")
    expect(init.headers).toEqual({ Authorization: "Bearer " + accessToken("admin") })
  })

  it("whenForbidden_thenNoRefreshAndSessionSurvives", async () => {
    const token = accessToken()
    setSession(token, "refresh-opaco")
    fetchMock.mockResolvedValue(response(403))

    await useAuthStore.getState().init()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(currentSession()?.access).toBe(token)
    expect(useAuthStore.getState().status).toBe("authenticated")
  })

  it("whenNetworkFails_thenErrorStateIsRetryable", async () => {
    setSession(accessToken(), "refresh-opaco")
    fetchMock.mockRejectedValue(new Error("network failure"))

    await useAuthStore.getState().init()

    expect(useAuthStore.getState().status).toBe("error")
    expect(useAuthStore.getState().initialized).toBe(true)
    expect(useAuthStore.getState().error).toBe("Falha ao carregar sessão")
    expect(currentSession()?.refresh).toBe("refresh-opaco")
    expect(useAuthStore.getState().reLoginRequired).toBe(false)
  })

  it("whenCheckHangs_thenTimeoutMapsToFriendlyMessage", async () => {
    vi.useFakeTimers()
    setSession(accessToken(), "refresh-opaco")
    fetchMock.mockImplementation(() => new Promise(() => {}))

    const pending = useAuthStore.getState().init()
    await vi.advanceTimersByTimeAsync(SESSION_INIT_TIMEOUT_MS + 1)
    await pending

    expect(useAuthStore.getState().status).toBe("error")
    expect(useAuthStore.getState().error).toBe(
      "A verificação da sessão demorou mais que o esperado.",
    )
    expect(currentSession()).not.toBeNull()
  })

  it("whenRetryInit_thenRecoversAfterFailure", async () => {
    setSession(accessToken(), "refresh-opaco")
    fetchMock.mockRejectedValueOnce(new Error("boom"))
    await useAuthStore.getState().init()
    expect(useAuthStore.getState().status).toBe("error")

    fetchMock.mockResolvedValue(
      response(200, { authorized: true, context: "cliente", role: "user" }),
    )
    await useAuthStore.getState().retryInit()

    expect(useAuthStore.getState().status).toBe("authenticated")
    expect(useAuthStore.getState().user?.role).toBe("user")
  })

  it("whenSignOut_thenOnlyLocalMemoryIsClearedWithoutFetch", async () => {
    setSession(accessToken(), "refresh-opaco")
    const before = fetchMock.mock.calls.length

    await useAuthStore.getState().signOut()

    expect(currentSession()).toBeNull()
    expect(fetchMock.mock.calls.length).toBe(before)
    expect(useAuthStore.getState().status).toBe("unauthenticated")
  })

  it("whenStorageInspected_thenZeroWrites", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    const cookieBefore = document.cookie
    setSession(accessToken(), "refresh-opaco")
    fetchMock.mockResolvedValue(response(200, { authorized: true, context: "cliente", role: "admin" }))

    await useAuthStore.getState().init()
    await useAuthStore.getState().signOut()

    expect(setItem).not.toHaveBeenCalled()
    expect(document.cookie).toBe(cookieBefore)
    setItem.mockRestore()
  })
})
