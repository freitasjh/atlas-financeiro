// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nextProvider } from "react-i18next"
import i18n from "@/i18n"
import type { BankStatementTransaction } from "../bank-accounts-types"
import { BankAccountStatementTable } from "../bank-account-statement-table"

afterEach(() => {
  cleanup()
})

const TRANSACTIONS: BankStatementTransaction[] = [
  {
    id: "t1",
    accountId: "acc-1",
    date: "13/11/2026",
    description: "Entrada conciliada",
    category: "Categoria A",
    amount: 100,
    type: "credit",
    reconciliationStatus: "reconciled",
  },
  {
    id: "t2",
    accountId: "acc-1",
    date: "13/11/2026",
    description: "Saída conciliada",
    category: "Categoria B",
    amount: 50,
    type: "debit",
    reconciliationStatus: "reconciled",
  },
  {
    id: "t3",
    accountId: "acc-1",
    date: "12/11/2026",
    description: "Entrada pendente",
    category: "Categoria C",
    amount: 75,
    type: "transfer_in",
    reconciliationStatus: "pending",
  },
  {
    id: "t4",
    accountId: "acc-1",
    date: "12/11/2026",
    description: "Saída pendente",
    category: "Categoria D",
    amount: 25,
    type: "transfer_out",
    reconciliationStatus: "pending",
  },
]

async function renderTable(lng: "pt-BR" | "en-US" = "pt-BR") {
  await i18n.changeLanguage(lng)
  return render(
    <I18nextProvider i18n={i18n}>
      <BankAccountStatementTable account={null} transactions={TRANSACTIONS} />
    </I18nextProvider>,
  )
}

function isVisible(description: string) {
  return screen.queryByText(description) !== null
}

describe("whenFiltrosDoExtratoSaoUsados_thenFiltramCorretamente", () => {
  it("whenSelecionaTipo_thenFiltra", async () => {
    const user = userEvent.setup()
    await renderTable()

    expect(isVisible("Entrada conciliada")).toBe(true)
    expect(isVisible("Saída conciliada")).toBe(true)

    await user.click(screen.getByRole("radio", { name: "Entradas" }))

    expect(isVisible("Entrada conciliada")).toBe(true)
    expect(isVisible("Entrada pendente")).toBe(true)
    expect(isVisible("Saída conciliada")).toBe(false)
    expect(isVisible("Saída pendente")).toBe(false)

    await user.click(screen.getByRole("radio", { name: "Saídas" }))

    expect(isVisible("Saída conciliada")).toBe(true)
    expect(isVisible("Saída pendente")).toBe(true)
    expect(isVisible("Entrada conciliada")).toBe(false)
    expect(isVisible("Entrada pendente")).toBe(false)
  })

  it("whenSelecionaStatus_thenFiltra", async () => {
    const user = userEvent.setup()
    await renderTable()

    await user.click(screen.getByRole("radio", { name: "Conciliados" }))

    expect(isVisible("Entrada conciliada")).toBe(true)
    expect(isVisible("Saída conciliada")).toBe(true)
    expect(isVisible("Entrada pendente")).toBe(false)
    expect(isVisible("Saída pendente")).toBe(false)

    await user.click(screen.getByRole("radio", { name: "Pendentes" }))

    expect(isVisible("Entrada pendente")).toBe(true)
    expect(isVisible("Saída pendente")).toBe(true)
    expect(isVisible("Entrada conciliada")).toBe(false)
    expect(isVisible("Saída conciliada")).toBe(false)
  })

  it("whenCombinaTipoEStatus_thenAplicaAND", async () => {
    const user = userEvent.setup()
    await renderTable()

    await user.click(screen.getByRole("radio", { name: "Entradas" }))
    await user.click(screen.getByRole("radio", { name: "Conciliados" }))

    expect(isVisible("Entrada conciliada")).toBe(true)
    expect(isVisible("Entrada pendente")).toBe(false)
    expect(isVisible("Saída conciliada")).toBe(false)
    expect(isVisible("Saída pendente")).toBe(false)
  })

  it("whenClicaItemAtivo_thenNaoZera", async () => {
    const user = userEvent.setup()
    await renderTable()

    const entradas = screen.getByRole("radio", { name: "Entradas" })
    await user.click(entradas)
    expect(entradas.getAttribute("aria-checked")).toBe("true")

    await user.click(entradas)

    expect(entradas.getAttribute("aria-checked")).toBe("true")
    expect(isVisible("Entrada conciliada")).toBe(true)
    expect(isVisible("Entrada pendente")).toBe(true)
    expect(isVisible("Saída conciliada")).toBe(false)
  })

  it("whenRenderiza_thenTemSearchEAria", async () => {
    const { container } = await renderTable()

    const search = container.querySelector("search")
    expect(search).not.toBeNull()
    expect(search?.getAttribute("aria-label")).toBe(
      i18n.t("accounts.statement.searchAria"),
    )

    const searchbox = screen.getByRole("searchbox", {
      name: i18n.t("accounts.statement.searchAria"),
    })
    expect(searchbox.getAttribute("type")).toBe("search")
    expect(searchbox.getAttribute("placeholder")).toBe(
      i18n.t("accounts.statementSearch"),
    )

    const groups = container.querySelectorAll('[role="radiogroup"]')
    expect(groups).toHaveLength(2)
    expect(groups[0]?.getAttribute("aria-label")).toBe(
      i18n.t("accounts.statement.typeFilterAria"),
    )
    expect(groups[1]?.getAttribute("aria-label")).toBe(
      i18n.t("accounts.statement.statusFilterAria"),
    )

    const srOnlyLabel = container.querySelector('label[for="statement-search"]')
    expect(srOnlyLabel?.className).toContain("sr-only")
    expect(srOnlyLabel?.textContent).toBe(i18n.t("accounts.statement.searchAria"))
  })

  it("whenRenderiza_thenUsaChavesI18n", async () => {
    await renderTable("en-US")

    expect(screen.getByRole("radio", { name: "All" })).toBeTruthy()
    expect(screen.getByRole("radio", { name: "Inflows" })).toBeTruthy()
    expect(screen.getByRole("radio", { name: "Outflows" })).toBeTruthy()
    expect(screen.getByRole("radio", { name: "Status: All" })).toBeTruthy()
    expect(screen.getByRole("radio", { name: "Reconciled" })).toBeTruthy()
    expect(screen.getByRole("radio", { name: "Pending" })).toBeTruthy()
    expect(
      screen.getByPlaceholderText(i18n.t("accounts.statementSearch")),
    ).toBeTruthy()
    expect(screen.queryByRole("radio", { name: "Entradas" })).toBeNull()
  })

  it("whenRenderiza_thenPillsUsamPillToggleComFocoETouchTarget", async () => {
    const { container } = await renderTable()

    const item = screen.getByRole("radio", { name: "Entradas" })
    const classes = item.className

    // PillToggle: variante ativa pinta o item selecionado (não usa data-[state]).
    expect(item.getAttribute("aria-checked")).toBe("false")
    expect(classes).toContain("min-h-11")
    expect(classes).toContain("sm:min-h-9")
    expect(classes).toContain("shrink-0")
    expect(classes).toContain("focus-visible:ring-2")
    expect(classes).toContain("focus-visible:ring-ring")
    expect(classes).toContain("motion-reduce:transition-none")
    expect(classes).not.toContain("text-emerald-600")
    expect(classes).not.toContain("text-amber-600")
    expect(classes).not.toContain("bg-accent")

    const active = screen.getByRole("radio", { name: "Todos" })
    expect(active.getAttribute("aria-checked")).toBe("true")
    expect(active.className).toContain("bg-background")
    expect(active.className).toContain("ring-1")

    const groups = container.querySelectorAll('[role="radiogroup"]')
    expect(groups).toHaveLength(2)
    groups.forEach((group) => {
      expect(group.parentElement?.className).toContain("overflow-x-auto")
      expect(group.parentElement?.className).toContain("scrollbar-none")
    })
  })
})
