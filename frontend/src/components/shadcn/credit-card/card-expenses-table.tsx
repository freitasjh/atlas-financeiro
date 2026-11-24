import { useState, useMemo, useId } from "react"
import { useTranslation } from "react-i18next"
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table"
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  Calendar,
  Car,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Columns,
  CreditCard,
  Download,
  Eye,
  HeartPulse,
  Laptop,
  Plus,
  Receipt,
  Search,
  Server,
  ShoppingBag,
  Tag,
  Utensils,
} from "lucide-react"

import { cn } from "@/lib/cn"
import { formatCentsBRL } from "@/lib/utils"
import { Badge } from "@/components/shadcn/ui/badge"
import { Button } from "@/components/shadcn/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/shadcn/ui/dropdown-menu"
import { Input } from "@/components/shadcn/ui/input"
import { Label } from "@/components/shadcn/ui/label"
import { PillToggle } from "@/components/shadcn/ui/pill-toggle"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/shadcn/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/shadcn/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/ui/table"
import type { CardExpenseItem } from "./statement-types"

export type ExpenseFilter = "all" | "pending" | "installments"

export interface ExpenseRow {
  id: string
  description: string
  date: string
  amountCents: number
  installmentLabel: string | null
  categoryName: string | null
  pending: boolean
  isTransfer: boolean
  cardLast4?: string | null
  time?: string
  location?: string
}

export interface CardExpensesTableProps {
  /** Lista de despesas do cartão (aceita ExpenseRow[] ou CardExpenseItem[]) */
  expenses: (ExpenseRow | CardExpenseItem)[]
  /** Filtro rápido selecionado */
  filter?: ExpenseFilter
  /** Termo de busca */
  search?: string
  /** Callback acionado na troca do filtro */
  onFilterChange?: (filter: ExpenseFilter) => void
  /** Callback acionado na alteração da busca */
  onSearchChange?: (value: string) => void
  /** Callback para exportação em CSV */
  onExport?: () => void
  /** Callback para abertura externa de detalhe */
  onOpenDetail?: (expense: ExpenseRow) => void
  /** Callback para adicionar nova compra */
  onNewPurchase?: () => void
  /** Últimos 4 dígitos do cartão padrão */
  cardLast4?: string
  /** Classe CSS customizada */
  className?: string
}

const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
})

const columnHelper = createColumnHelper<typeof features, ExpenseRow>()

function getCategoryIcon(cat?: string | null) {
  switch (cat) {
    case "Infraestrutura":
      return <Server className="size-4 text-blue-500" />
    case "E-commerce":
      return <ShoppingBag className="size-4 text-amber-500" />
    case "Transporte":
      return <Car className="size-4 text-emerald-500" />
    case "Alimentação":
      return <Utensils className="size-4 text-orange-500" />
    case "Software":
      return <Laptop className="size-4 text-purple-500" />
    case "Saúde":
      return <HeartPulse className="size-4 text-rose-500" />
    case "Pagamento":
      return <Receipt className="size-4 text-primary" />
    default:
      return <Tag className="size-4 text-muted-foreground" />
  }
}

function normalizeExpense(item: ExpenseRow | CardExpenseItem, defaultLast4?: string): ExpenseRow {
  if ("amountCents" in item) {
    return {
      ...item,
      cardLast4: item.cardLast4 ?? defaultLast4 ?? null,
    }
  }

  const expenseItem = item as CardExpenseItem
  return {
    id: expenseItem.id,
    description: expenseItem.merchantName,
    date: expenseItem.date,
    time: expenseItem.time,
    amountCents: Math.round(Math.abs(expenseItem.amount) * 100),
    installmentLabel: expenseItem.installments
      ? `${expenseItem.installments.current}/${expenseItem.installments.total}`
      : null,
    categoryName: expenseItem.category,
    pending: expenseItem.status === "pending",
    isTransfer: expenseItem.amount > 0,
    cardLast4: defaultLast4 ?? null,
    location: expenseItem.location,
  }
}

export function CardExpensesTable({
  expenses: rawExpenses,
  filter: controlledFilter,
  search: controlledSearch,
  onFilterChange: propOnFilterChange,
  onSearchChange: propOnSearchChange,
  onExport,
  onOpenDetail,
  onNewPurchase,
  cardLast4,
  className,
}: CardExpensesTableProps) {
  const { t, i18n } = useTranslation()
  const searchInputId = useId()

  const [uncontrolledFilter, setUncontrolledFilter] = useState<ExpenseFilter>("all")
  const [uncontrolledSearch, setUncontrolledSearch] = useState("")
  const [sorting, setSorting] = useState<SortingState>([{ id: "date", desc: true }])
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({
    cardLast4: true,
  })
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })

  const [selectedExpense, setSelectedExpense] = useState<ExpenseRow | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const activeFilter = controlledFilter ?? uncontrolledFilter
  const activeSearch = controlledSearch ?? uncontrolledSearch

  const handleFilterChange = (newFilter: ExpenseFilter) => {
    propOnFilterChange?.(newFilter)
    if (controlledFilter === undefined) setUncontrolledFilter(newFilter)
  }

  const handleSearchChange = (newSearch: string) => {
    propOnSearchChange?.(newSearch)
    if (controlledSearch === undefined) setUncontrolledSearch(newSearch)
  }

  // Normalização e filtragem rápida
  const normalizedData = useMemo<ExpenseRow[]>(() => {
    const list = rawExpenses.map((e) => normalizeExpense(e, cardLast4))
    const query = activeSearch.trim().toLowerCase()

    return list.filter((row) => {
      if (activeFilter === "pending" && (row.pending === false || row.isTransfer)) return false
      if (activeFilter === "installments" && row.installmentLabel === null) return false
      if (query !== "") {
        const descMatch = row.description.toLowerCase().includes(query)
        const catMatch = row.categoryName ? row.categoryName.toLowerCase().includes(query) : false
        if (!descMatch && !catMatch) return false
      }
      return true
    })
  }, [rawExpenses, activeFilter, activeSearch, cardLast4])

  const handleRowClick = (expense: ExpenseRow) => {
    if (onOpenDetail) {
      onOpenDetail(expense)
    } else {
      setSelectedExpense(expense)
      setDrawerOpen(true)
    }
  }

  // Definição das colunas TanStack
  const columns = useMemo(() => {
    return columnHelper.columns([
      columnHelper.accessor("description", {
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider">
            {t("cards.installmentDescription")}
          </span>
        ),
        cell: ({ row }) => {
          const item = row.original
          return (
            <div className="flex min-w-0 items-center gap-2.5 py-0.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
                {getCategoryIcon(item.isTransfer ? "Pagamento" : item.categoryName)}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
                  {item.description}
                </span>
                {item.isTransfer && (
                  <Badge variant="secondary" className="text-[10px] w-fit px-1.5 py-0 mt-0.5">
                    {t("cards.transactions.invoicePayment")}
                  </Badge>
                )}
              </div>
            </div>
          )
        },
        enableHiding: false,
      }),

      columnHelper.accessor("categoryName", {
        id: "categoryName",
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider">
            {t("categories.title", "Categoria")}
          </span>
        ),
        cell: ({ row }) => {
          const cat = row.original.categoryName
          return (
            <div className="flex items-center">
              {row.original.isTransfer ? (
                <Badge variant="secondary" className="text-xs font-normal">
                  {t("cards.transactions.invoicePayment")}
                </Badge>
              ) : cat ? (
                <Badge
                  variant="outline"
                  className="rounded-md border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-normal text-muted-foreground"
                >
                  {cat}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("cards.purchase.noCategory")}
                </span>
              )}
            </div>
          )
        },
      }),

      columnHelper.accessor("installmentLabel", {
        id: "installmentLabel",
        header: () => (
          <div className="text-center text-xs font-semibold uppercase tracking-wider">
            {t("cards.installments.header", "Parcelas")}
          </div>
        ),
        cell: ({ row }) => {
          const label = row.original.installmentLabel
          return (
            <div className="flex items-center justify-center">
              {label ? (
                <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/50 px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-foreground">
                  {label}
                </span>
              ) : (
                <span className="text-xs font-mono text-muted-foreground/50">—</span>
              )}
            </div>
          )
        },
      }),

      columnHelper.accessor("cardLast4", {
        id: "cardLast4",
        header: () => (
          <div className="hidden lg:block text-xs font-semibold uppercase tracking-wider">
            {t("cards.header.card", "Cartão")}
          </div>
        ),
        cell: ({ row }) => {
          const last4 = row.original.cardLast4
          return (
            <div className="hidden lg:flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <CreditCard className="size-3.5 text-muted-foreground/70" />
              <span>•••• {last4 || "••••"}</span>
            </div>
          )
        },
      }),

      columnHelper.accessor("date", {
        header: ({ column }) => {
          const isSorted = column.getIsSorted()
          return (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => column.toggleSorting(isSorted === "asc")}
              className="-ml-3 h-8 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              aria-label={t("cards.table.sortDate", "Ordenar por data")}
            >
              <span className="inline-flex items-center gap-1">
                {t("cards.purchaseDate")}
                {isSorted === "desc" ? (
                  <ArrowDownWideNarrow className="size-3.5" aria-hidden="true" />
                ) : isSorted === "asc" ? (
                  <ArrowUpDown className="size-3.5 rotate-180" aria-hidden="true" />
                ) : (
                  <ArrowUpDown className="size-3 text-muted-foreground/50" aria-hidden="true" />
                )}
              </span>
            </Button>
          )
        },
        cell: ({ row }) => {
          const dateStr = row.original.date
          const formatted = new Intl.DateTimeFormat(i18n.language, {
            day: "2-digit",
            month: "2-digit",
          }).format(new Date(`${dateStr}T12:00:00`))
          return (
            <span className="whitespace-nowrap font-mono text-xs text-muted-foreground tabular-nums">
              {formatted}
            </span>
          )
        },
      }),

      columnHelper.accessor("amountCents", {
        header: ({ column }) => {
          const isSorted = column.getIsSorted()
          return (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => column.toggleSorting(isSorted === "asc")}
                className="-mr-3 h-8 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                aria-label={t("cards.table.sortAmount", "Ordenar por valor")}
              >
                <span className="inline-flex items-center gap-1">
                  {t("cards.detail.amount")}
                  {isSorted ? (
                    <ArrowDownWideNarrow className="size-3.5" aria-hidden="true" />
                  ) : null}
                </span>
              </Button>
            </div>
          )
        },
        cell: ({ row }) => {
          const item = row.original
          const isPositive = item.isTransfer
          const formatted = formatCentsBRL(item.amountCents)
          return (
            <div className="text-right whitespace-nowrap">
              <span
                className={cn(
                  "font-mono text-xs sm:text-sm font-bold tracking-tight tabular-nums",
                  isPositive
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-foreground"
                )}
              >
                {isPositive ? `+ ${formatted}` : formatted}
              </span>
            </div>
          )
        },
      }),

      columnHelper.display({
        id: "actions",
        header: () => null,
        cell: ({ row }) => (
          <div className="flex justify-end pr-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                handleRowClick(row.original)
              }}
              aria-label={t("cards.table.viewExpenseDetail", "Ver detalhes da despesa")}
            >
              <Eye className="size-3.5" />
            </Button>
          </div>
        ),
      }),
    ])
  }, [t, i18n.language])

  const table = useTable({
    features,
    data: normalizedData,
    columns,
    state: {
      sorting,
      columnVisibility,
      pagination,
    },
    getRowId: (row) => row.id,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
  })

  const searching = activeSearch.trim() !== "" || activeFilter !== "all"

  return (
    <div
      className={cn(
        "min-w-0 max-w-full rounded-2xl border border-border/80 bg-card text-card-foreground shadow-xs overflow-hidden",
        className
      )}
    >
      {/* Cabeçalho da Seção */}
      <div className="flex flex-col gap-3 border-b border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-foreground">
            {t("cards.transactions.title")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("cards.transactions.searchPlaceholder")}
          </p>
        </div>

        <div className="flex items-center gap-1.5 self-start sm:self-auto">
          {onExport && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onExport}
              className="min-h-11 gap-1.5 px-3 text-xs font-semibold sm:h-8 sm:min-h-8"
            >
              <Download className="size-3.5" aria-hidden="true" />
              <span>{t("cards.table.export")}</span>
            </Button>
          )}

          {onNewPurchase && (
            <Button
              type="button"
              size="sm"
              onClick={onNewPurchase}
              className="min-h-11 gap-1.5 px-3 text-xs font-semibold sm:h-8 sm:min-h-8"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span>{t("cards.transactions.newPurchase")}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Toolbar: Busca + Filtro PillToggle (tamanho SM) + Colunas */}
      <search
        aria-label={t("cards.table.searchLabel")}
        className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="relative w-full lg:max-w-xs">
          <Label htmlFor={searchInputId} className="sr-only">
            {t("cards.table.searchLabel")}
          </Label>
          <Search
            className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchInputId}
            type="search"
            value={activeSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t("cards.transactions.searchPlaceholder")}
            aria-label={t("cards.table.searchLabel")}
            className="h-10 w-full border-border/80 bg-background pl-9 text-base sm:h-9 sm:text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 overflow-x-auto pb-1 scrollbar-none lg:w-auto lg:pb-0">
          <PillToggle
            size="sm"
            value={activeFilter}
            onChange={(val) => handleFilterChange(val as ExpenseFilter)}
            aria-label={t("cards.transactions.title")}
            options={[
              { value: "all", label: t("cards.table.all") },
              { value: "pending", label: t("cards.table.pending") },
              { value: "installments", label: t("cards.table.installments") },
            ]}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 sm:h-8 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <Columns className="size-3.5" />
                <span className="hidden sm:inline">{t("cards.table.columns", "Colunas")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize text-xs"
                    checked={column.getIsVisible()}
                    onCheckedChange={(val) => column.toggleVisibility(!!val)}
                  >
                    {column.id === "categoryName"
                      ? t("categories.title", "Categoria")
                      : column.id === "installmentLabel"
                      ? t("cards.installments.header", "Parcelas")
                      : column.id === "cardLast4"
                      ? t("cards.header.card", "Cartão")
                      : column.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </search>

      {/* Tabela ou Estado Vazio */}
      {table.getRowModel().rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center m-4">
          <p className="text-sm font-bold text-foreground">
            {searching ? t("cards.transactions.noResults") : t("cards.transactions.empty")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {searching ? null : t("cards.transactions.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="w-full max-w-full overflow-x-auto">
          <Table>
            <TableHeader className="border-b border-border/60 bg-muted/30">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      className="h-9 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/85"
                    >
                      {header.isPlaceholder ? null : (
                        <FlexRender header={header} />
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody className="divide-y divide-border/40">
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() => handleRowClick(row.original)}
                  className="cursor-pointer transition-colors hover:bg-muted/50"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        "px-3 py-2.5",
                        cell.column.id === "amountCents" && "text-right"
                      )}
                    >
                      <FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Paginação e Contador Inferior (Padrão data-table.tsx) */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/60 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
        <div>
          <span>
            {t("cards.table.footer", {
              shown: table.getRowModel().rows.length,
              total: normalizedData.length,
            })}
          </span>
          <span className="hidden sm:inline ml-2 text-[11px]">
            • <span>{t("cards.table.detailHint")}</span>
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="rows-per-page" className="hidden sm:inline text-xs font-medium text-muted-foreground">
              {t("common.rowsPerPage", "Linhas:")}
            </Label>
            <Select
              value={`${table.state.pagination.pageSize}`}
              onValueChange={(value) => table.setPageSize(Number(value))}
            >
              <SelectTrigger size="sm" className="h-7 w-16 text-xs" id="rows-per-page">
                <SelectValue placeholder={table.state.pagination.pageSize} />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 20, 50].map((size) => (
                  <SelectItem key={size} value={`${size}`} className="text-xs">
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="text-xs font-medium text-muted-foreground">
            {table.state.pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
          </div>

          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7 p-0"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
              aria-label={t("common.firstPage", "Primeira página")}
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7 p-0"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              aria-label={t("common.previousPage", "Página anterior")}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7 p-0"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-label={t("common.nextPage", "Próxima página")}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7 p-0"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
              aria-label={t("common.lastPage", "Última página")}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Sheet / Drawer Lateral de Detalhes da Despesa */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="sm:max-w-md p-0 flex flex-col">
          {selectedExpense && (
            <>
              <SheetHeader className="p-5 border-b border-border/80 sticky top-0 bg-background/95 backdrop-blur-md z-10">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs font-semibold gap-1.5">
                    {getCategoryIcon(selectedExpense.categoryName)}
                    {selectedExpense.categoryName || t("cards.purchase.noCategory")}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground font-mono">
                    ID: {selectedExpense.id}
                  </span>
                </div>

                <SheetTitle className="text-lg font-bold tracking-tight text-foreground text-left mt-2">
                  {selectedExpense.description}
                </SheetTitle>
                <SheetDescription className="text-xs text-left">
                  {selectedExpense.cardLast4
                    ? t("cards.detail.processedOnCard", { last4: selectedExpense.cardLast4 })
                    : t("cards.detail.processedOnCardUnknown")}
                </SheetDescription>
              </SheetHeader>

              <div className="p-5 flex-1 space-y-5 overflow-y-auto">
                <div className="rounded-xl border border-border/80 bg-muted/30 p-4 text-center">
                  <span className="text-xs text-muted-foreground block">
                    {t("cards.detail.amount")}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-2xl font-extrabold block mt-0.5",
                      selectedExpense.isTransfer
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-foreground"
                    )}
                  >
                    {selectedExpense.isTransfer ? "+ " : ""}
                    {formatCentsBRL(selectedExpense.amountCents)}
                  </span>
                  {selectedExpense.installmentLabel && (
                    <Badge variant="secondary" className="mt-2 text-[10px] font-semibold">
                      {t("cards.installments.badge", {
                        label: selectedExpense.installmentLabel,
                      })}
                    </Badge>
                  )}
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    {t("cards.detail.metadataTitle", "Dados do Lançamento")}
                  </h4>

                  <div className="rounded-xl border border-border/70 p-3.5 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <Calendar className="size-3.5 text-primary" />
                        {t("cards.purchaseDate")}:
                      </span>
                      <span className="font-semibold text-foreground">
                        {new Intl.DateTimeFormat(i18n.language, {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        }).format(new Date(`${selectedExpense.date}T12:00:00`))}
                      </span>
                    </div>

                    {selectedExpense.time && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <Clock className="size-3.5 text-primary" />
                          {t("cards.detail.time", "Horário")}:
                        </span>
                        <span className="font-semibold text-foreground font-mono">
                          {selectedExpense.time}
                        </span>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <CreditCard className="size-3.5 text-primary" />
                        {t("cards.header.card", "Cartão")}:
                      </span>
                      <span className="font-semibold text-foreground font-mono">
                        •••• {selectedExpense.cardLast4 || cardLast4 || "••••"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        {t("cards.table.status", "Status")}:
                      </span>
                      <Badge
                        variant={selectedExpense.pending ? "outline" : "secondary"}
                        className={cn(
                          "text-[10px]",
                          selectedExpense.pending && "border-amber-500/40 text-amber-600 dark:text-amber-400 bg-amber-500/10"
                        )}
                      >
                        {selectedExpense.pending
                          ? t("cards.table.pending")
                          : selectedExpense.isTransfer
                          ? t("cards.transactions.invoicePayment")
                          : t("cards.table.confirmed", "Confirmado")}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
