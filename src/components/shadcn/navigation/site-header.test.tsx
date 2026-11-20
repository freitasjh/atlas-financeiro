// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { vi } from "vitest"

vi.mock("@/modules/accounts/service/accounts.service", () => ({
  listAccounts: vi.fn().mockResolvedValue([]),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
}))

import i18n from "@/i18n"
import { SidebarProvider } from "@/components/shadcn/ui/sidebar"
import { SiteHeader } from "./site-header"
import { GlobalBalancePopover } from "./global-balance-popover"
import { useAccountsStore } from "@/modules/accounts/store/accounts.store"

function renderHeader(title = "Visão geral") {
  useAccountsStore.setState({ accounts: [], status: "ready", error: null })
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <SiteHeader title={title} />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

function renderPopover(props?: Partial<React.ComponentProps<typeof GlobalBalancePopover>>) {
  return render(
    <MemoryRouter>
      <GlobalBalancePopover
        accounts={[
          { id: "acc-1", nickname: "Itaú • Operacional Matriz", balanceCents: 18452040 },
          { id: "acc-2", nickname: "Nubank PJ • Cobranças", balanceCents: 6241080 },
        ]}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe("SiteHeader breadcrumb (i18n)", () => {
  afterEach(async () => {
    await i18n.changeLanguage("pt-BR")
    cleanup()
  })

  it("whenPtBr_thenBreadcrumbRootIsPlataforma", () => {
    renderHeader()
    expect(screen.getByText(i18n.t("nav.platform"))).toBeTruthy()
    expect(i18n.t("nav.platform", { lng: "pt-BR" })).toBe("Plataforma")
  })

  it("whenEnUs_thenBreadcrumbRootIsPlatform", async () => {
    await i18n.changeLanguage("en-US")
    renderHeader()
    expect(screen.getByText("Platform")).toBeTruthy()
  })

  it("whenTitleGiven_thenBreadcrumbPageShowsTitle", () => {
    renderHeader("Lançamentos")
    expect(screen.getByText("Lançamentos")).toBeTruthy()
  })
})

describe("SiteHeader global balance (topbar-saldo-global)", () => {
  afterEach(async () => {
    await i18n.changeLanguage("pt-BR")
    cleanup()
  })

  it("whenRendered_thenNoNewEntryAction", () => {
    renderHeader()
    expect(screen.queryByText(/novo lan[cç]amento/i)).toBeNull()
  })

  it("whenRendered_thenTriggerShowsTotalWithTabularNums", () => {
    renderHeader()
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    const value = trigger.querySelector(".tabular-nums")
    expect(value).toBeTruthy()
    expect(value?.classList.contains("font-mono")).toBe(true)
  })

  it("whenTriggerClicked_thenAriaExpandedTogglesAndContentOpens", async () => {
    renderHeader()
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true")
    })
    expect(await screen.findByRole("dialog")).toBeTruthy()
  })

  it("whenEscapePressed_thenPopoverClosesAndFocusReturnsToTrigger", async () => {
    renderHeader()
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger)
    })
  })

  it("whenMobile375_thenTriggerTruncatesWithoutOverflow", () => {
    const { container } = renderHeader()
    const header = container.querySelector("header")
    expect(header).toBeTruthy()
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    // Contenção flex: pai min-w-0 + valor com truncate e teto em vw
    expect(trigger.className).toMatch(/min-w-0/)
    const value = trigger.querySelector(".tabular-nums")
    expect(value?.className).toMatch(/truncate/)
    expect(value?.className).toMatch(/max-w-\[38vw\]/)
  })

  it("whenDropdownOpen_thenRowsAreReadonlyWithoutActions", async () => {
    renderPopover()
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    const dialog = await screen.findByRole("dialog")
    // Nenhuma linha clicável: sem botões/links de navegação dentro do popover
    expect(dialog.querySelectorAll("button, a[href]").length).toBe(0)
    expect(dialog.querySelector("[data-readonly-row]")).toBeTruthy()
    expect(dialog.className).toMatch(/cursor-default/)
  })

  it("whenHeaderDefault_thenEmptyStateWithoutActions", async () => {
    renderHeader()
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog.querySelectorAll("button, a[href]").length).toBe(0)
    expect(await screen.findByText(/nenhuma conta/i)).toBeTruthy()
  })
})

describe("GlobalBalancePopover states", () => {
  afterEach(cleanup)

  it("whenLoading_thenRendersSkeletons", () => {
    renderPopover({ loading: true })
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    expect(document.body.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0)
  })

  it("whenError_thenRendersMessageAndRetry", async () => {
    let retried = 0
    renderPopover({ error: "Falha de rede", onRetry: () => { retried += 1 } })
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    expect(await screen.findByText("Falha de rede")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /tentar novamente/i }))
    expect(retried).toBe(1)
  })

  it("whenEmpty_thenRendersEmptyState", async () => {
    renderPopover({ accounts: [] })
    fireEvent.click(screen.getByRole("button", { name: /saldo total/i }))
    expect(await screen.findByText(/nenhuma conta/i)).toBeTruthy()
  })

  it("whenTwoAccounts_thenTriggerShowsSummedTotalCents", () => {
    renderPopover({
      accounts: [
        { id: "acc-1", nickname: "Itaú • Operacional Matriz", balanceCents: 18452040 },
        { id: "acc-2", nickname: "Nubank PJ • Cobranças", balanceCents: 6241080 },
      ],
    })
    const trigger = screen.getByRole("button", { name: /saldo total/i })
    const value = trigger.querySelector(".tabular-nums")
    // 18452040 + 6241080 = 24693120 cents → R$ 246.931,20
    expect(value?.textContent).toContain("246.931,20")
  })
})

describe("SiteHeader slot props (control plane)", () => {
  afterEach(cleanup)

  function renderHeaderWith(props: Partial<React.ComponentProps<typeof SiteHeader>>) {
    useAccountsStore.setState({ accounts: [], status: "ready", error: null })
    return render(
      <MemoryRouter>
        <SidebarProvider>
          <SiteHeader title="Tenants" {...props} />
        </SidebarProvider>
      </MemoryRouter>,
    )
  }

  it("whenShowGlobalBalanceFalse_thenNoBalanceTrigger", () => {
    renderHeaderWith({ showGlobalBalance: false })
    expect(screen.queryByRole("button", { name: /saldo total/i })).toBeNull()
  })

  it("whenBreadcrumbRootHrefNull_thenRootIsNotALink", () => {
    renderHeaderWith({ breadcrumbRoot: "Área interna", breadcrumbRootHref: null })
    const root = screen.getByText("Área interna")
    expect(root.closest("a")).toBeNull()
    expect(root.className).toContain("text-muted-foreground")
  })

  it("whenBreadcrumbRootDefault_thenRootLinksToPlatform", () => {
    renderHeaderWith({})
    const root = screen.getByText(i18n.t("nav.platform"))
    expect(root.closest("a")?.getAttribute("href")).toBe("#/")
  })

  it("whenShowNotificationsFalse_thenBellIsAbsent", () => {
    renderHeaderWith({ showNotifications: false })
    expect(screen.queryByRole("button", { name: /notificações/i })).toBeNull()
  })

  it("whenShowModeToggleFalse_thenThemeToggleIsAbsent", () => {
    renderHeaderWith({ showModeToggle: false })
    expect(screen.queryByRole("button", { name: /alternar tema/i })).toBeNull()
  })

  it("whenActionsGiven_thenTheyRenderInTheRightCluster", () => {
    renderHeaderWith({
      actions: <span data-testid="aal-chip">aal2</span>,
    })
    expect(screen.getByTestId("aal-chip")).toBeTruthy()
  })
})
