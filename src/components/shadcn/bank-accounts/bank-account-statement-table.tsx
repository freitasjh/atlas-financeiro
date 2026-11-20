import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  Download,
  Paperclip,
  Check,
} from "lucide-react"
import { Input } from "@/components/shadcn/ui/input"
import { Button } from "@/components/shadcn/ui/button"
import { Badge } from "@/components/shadcn/ui/badge"
import { Label } from "@/components/shadcn/ui/label"
import { PillToggle } from "@/components/shadcn/ui/pill-toggle"
import type {
  BankStatementTransaction,
  BankAccount,
  ReconciliationStatus,
} from "./bank-accounts-types"
import { toast } from "sonner"

type TypeFilter = "all" | "in" | "out"
type StatusFilter = "all" | ReconciliationStatus


interface BankAccountStatementTableProps {
  account: BankAccount | null
  transactions: BankStatementTransaction[]
  onReconcileTransaction?: (txId: string) => void
  onExportStatement?: (format: "csv" | "pdf" | "ofx") => void
}

export function BankAccountStatementTable({
  account,
  transactions,
  onReconcileTransaction,
  onExportStatement,
}: BankAccountStatementTableProps) {
  const { t } = useTranslation()
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all")

  // Filtragem de transações
  const filtered = transactions.filter((tx) => {
    if (account && tx.accountId !== account.id) {
      return false
    }

    if (statusFilter !== "all" && tx.reconciliationStatus !== statusFilter) {
      return false
    }

    if (typeFilter === "in" && (tx.type !== "credit" && tx.type !== "transfer_in")) {
      return false
    }
    if (typeFilter === "out" && (tx.type !== "debit" && tx.type !== "transfer_out")) {
      return false
    }

    const term = searchTerm.toLowerCase().trim()
    if (!term) return true

    return (
      tx.description.toLowerCase().includes(term) ||
      tx.category.toLowerCase().includes(term) ||
      (tx.counterparty && tx.counterparty.toLowerCase().includes(term)) ||
      (tx.documentNumber && tx.documentNumber.toLowerCase().includes(term))
    )
  })

  const formatBRL = (val: number) => {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
    }).format(val)
  }

  const reconciliationBadge = (status: ReconciliationStatus) => {
    switch (status) {
      case "reconciled":
        return (
          <Badge
            variant="outline"
            className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold gap-1"
          >
            <CheckCircle2 className="h-3 w-3" />
            {t("accounts.statement.badgeReconciled")}
          </Badge>
        )
      case "pending":
        return (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-semibold gap-1"
          >
            <Clock className="h-3 w-3" />
            {t("accounts.statement.badgePending")}
          </Badge>
        )
      case "divergent":
        return (
          <Badge
            variant="outline"
            className="border-destructive/40 bg-destructive/10 text-destructive text-[10px] font-semibold gap-1"
          >
            <AlertTriangle className="h-3 w-3" />
            {t("accounts.statement.badgeDivergent")}
          </Badge>
        )
    }
  }

  const transactionIcon = (type: BankStatementTransaction["type"]) => {
    switch (type) {
      case "credit":
        return (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 shrink-0">
            <ArrowDownLeft className="h-4 w-4" />
          </div>
        )
      case "debit":
        return (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-muted-foreground shrink-0">
            <ArrowUpRight className="h-4 w-4" />
          </div>
        )
      case "transfer_in":
      case "transfer_out":
        return (
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
            <ArrowLeftRight className="h-4 w-4" />
          </div>
        )
    }
  }

  const handleReconcile = (txId: string) => {
    // A19: sem handler não há conciliação — nunca anunciar sucesso falso.
    if (!onReconcileTransaction) return
    onReconcileTransaction(txId)
    toast.success(t("accounts.statement.badgeReconciled"))
  }

  return (
    <div className="min-w-0 max-w-full rounded-2xl border border-border/80 bg-card text-card-foreground shadow-xs overflow-hidden">
      {/* Cabeçalho do Extrato */}
      <div className="p-4 sm:p-5 border-b border-border/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-muted/20">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground">
            {account
              ? t("accounts.statement.titleOne", { name: account.nickname })
              : t("accounts.statement.titleAll")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("accounts.statement.subtitle")}</p>
        </div>

        {/* Botões de Exportação */}
        <div className="flex items-center gap-1.5 self-start sm:self-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onExportStatement?.("csv")}
            className="min-h-11 px-3 text-xs font-semibold gap-1 sm:h-8 sm:min-h-8"
          >
            <Download className="h-3 w-3" />
            <span>CSV</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onExportStatement?.("ofx")}
            className="min-h-11 px-3 text-xs font-semibold gap-1 sm:h-8 sm:min-h-8"
          >
            <Download className="h-3 w-3" />
            <span>OFX</span>
          </Button>
        </div>
      </div>

      {/* Barra de Filtros e Busca */}
      <search
        aria-label={t("accounts.statement.searchAria")}
        className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="relative w-full lg:max-w-xs">
          <Label htmlFor="statement-search" className="sr-only">
            {t("accounts.statement.searchAria")}
          </Label>
          <Search className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground" />
          <Input
            id="statement-search"
            type="search"
            placeholder={t("accounts.statementSearch")}
            aria-label={t("accounts.statement.searchAria")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-10 bg-background pl-9 text-base border-border/80 sm:h-9 sm:text-sm"
          />
        </div>

        <div className="flex w-full items-center gap-2 overflow-x-auto pb-1 scrollbar-none lg:w-auto lg:pb-0">
          <PillToggle
            size="lg"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as TypeFilter)}
            aria-label={t("accounts.statement.typeFilterAria")}
            options={[
              { value: "all", label: t("accounts.statement.all") },
              { value: "in", label: t("accounts.statement.inflow") },
              { value: "out", label: t("accounts.statement.outflow") },
            ]}
          />

          <PillToggle
            size="lg"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
            aria-label={t("accounts.statement.statusFilterAria")}
            options={[
              { value: "all", label: t("accounts.statement.statusAll") },
              { value: "reconciled", label: t("accounts.statement.reconciled") },
              { value: "pending", label: t("accounts.statement.pending") },
            ]}
          />
        </div>
      </search>

      {/* Tabela de Lançamentos */}
      <div className="w-full max-w-full overflow-x-auto">
        <table className="w-full min-w-[680px] table-fixed text-left text-xs">
          <thead className="border-b border-border/70 bg-muted/30 text-muted-foreground font-semibold">
            <tr>
              <th className="w-[104px] py-3 px-4">{t("accounts.statement.colDate")}</th>
              <th className="w-[36%] max-w-[380px] py-3 px-4">{t("accounts.statement.colDescription")}</th>
              <th className="w-[15%] py-3 px-4 hidden md:table-cell">{t("accounts.statement.colCounterparty")}</th>
              <th className="w-[12%] py-3 px-4 hidden sm:table-cell">{t("accounts.statement.colDocument")}</th>
              <th className="w-[132px] py-3 px-4 text-right">{t("accounts.statement.colAmount")}</th>
              <th className="w-[112px] py-3 px-4 text-center">{t("accounts.statement.colStatus")}</th>
              <th className="w-[104px] py-3 px-4 text-right">{t("accounts.statement.colAction")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-muted-foreground">
                  {t("accounts.statement.empty")}
                </td>
              </tr>
            ) : (
              filtered.map((tx) => {
                const isCredit = tx.type === "credit" || tx.type === "transfer_in"
                return (
                  <tr key={tx.id} className="hover:bg-muted/30 transition-colors">
                    {/* Data */}
                    <td className="py-3 px-4 font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                      {tx.date}
                    </td>

                    {/* Descrição & Categoria */}
                    <td className="w-[36%] max-w-[380px] py-3 px-4">
                      <div className="flex min-w-0 max-w-full items-center gap-2.5">
                        {transactionIcon(tx.type)}
                        <div className="min-w-0 max-w-full">
                          <p className="font-bold text-foreground truncate">
                            {tx.description}
                          </p>
                          <span className="text-[10px] text-muted-foreground block truncate">
                            {tx.category}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Contraparte */}
                    <td className="py-3 px-4 hidden md:table-cell text-muted-foreground truncate">
                      {tx.counterparty || "---"}
                    </td>

                    {/* Documento */}
                    <td className="py-3 px-4 hidden sm:table-cell font-mono tabular-nums text-[11px] text-muted-foreground">
                      <div className="flex min-w-0 items-center gap-1">
                        {tx.hasAttachment && (
                          <span title={t("accounts.statement.attachmentTitle")}>
                            <Paperclip className="h-3 w-3 text-primary shrink-0" />
                          </span>
                        )}
                        <span className="truncate">{tx.documentNumber || "---"}</span>
                      </div>
                    </td>

                    {/* Valor */}
                    <td className="py-3 px-4 font-mono font-extrabold text-right tabular-nums whitespace-nowrap">
                      <span
                        className={
                          isCredit
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-foreground"
                        }
                      >
                        {isCredit ? `+ ${formatBRL(tx.amount)}` : formatBRL(tx.amount)}
                      </span>
                    </td>

                    {/* Status de Conciliação */}
                    <td className="py-3 px-4 text-center whitespace-nowrap">
                      {reconciliationBadge(tx.reconciliationStatus)}
                    </td>

                    {/* Ação */}
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      {tx.reconciliationStatus === "pending" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleReconcile(tx.id)}
                          className="min-h-11 min-w-11 px-2 text-[11px] font-semibold gap-1 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 border-emerald-500/30 sm:h-8 sm:min-h-8 sm:min-w-8"
                        >
                          <Check className="h-3 w-3" />
                          <span>{t("accounts.statement.reconcile")}</span>
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {t("accounts.statement.ok")}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
