// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"

import { SidebarProvider } from "@/components/shadcn/ui/sidebar"

const { signOutMock, navigateMock } = vi.hoisted(() => ({
  signOutMock: vi.fn(async () => {}),
  navigateMock: vi.fn(),
}))

vi.mock("@/store/auth-store", () => ({
  useAuthStore: (selector?: (s: unknown) => unknown) => {
    const state = { signOut: signOutMock }
    return typeof selector === "function" ? selector(state) : state
  },
}))

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigateMock }
})

import { NavUser } from "./nav-user"

describe("NavUser logout", () => {
  beforeEach(() => {
    signOutMock.mockReset().mockResolvedValue(undefined)
    navigateMock.mockReset()
  })
  afterEach(() => cleanup())

  it("chama signOut e redireciona para /login ao clicar em Sair", async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <SidebarProvider>
          <NavUser user={{ name: "Ana", email: "ana@x.com", avatar: "" }} />
        </SidebarProvider>
      </MemoryRouter>,
    )

    await user.click(screen.getByRole("button"))
    await user.click(await screen.findByRole("menuitem", { name: /sair/i }))

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true })
    })
  })
})
