"use client"

import { useId, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  MoreHorizontal,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
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

import { cn, formatCentsBRL } from "@/lib/utils"
import { Button } from "@/components/shadcn/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/shadcn/ui/dropdown-menu"
import { Label } from "@/components/shadcn/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/shadcn/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/ui/table"
import type { BudgetView } from "../model/budget.adapter"
import { BudgetProgress } from "./BudgetProgress"

export interface BudgetsTableProps {
  rows: BudgetView[]
  totalCount?: number
  onEdit: (budget: BudgetView) => void
  onRequestDelete: (budget: BudgetView) => void
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

const columnHelper = createColumnHelper<typeof features, BudgetView>()

export function BudgetsTable({
  rows,
  totalCount,
  onEdit,
  onRequestDelete,
  className,
}: BudgetsTableProps) {
  const { t, i18n } = useTranslation()
  const rowsPerPageId = useId()

  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({
    categoryName: true,
    spentCents: true,
    limitCents: true,
    remainingCents: true,
    progress: true,
    actions: true,
  })
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })

  const columns = useMemo(() => {
    return columnHelper.columns([
      columnHelper.accessor("categoryName", {
        id: "categoryName",
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("budgets.category")}
          </span>
        ),
        cell: ({ row }) => {
          const item = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
                {item.categoryName ?? item.categoryId}
              </span>
            </div>
          )
        },
        enableHiding: false,
      }),

      columnHelper.accessor("spentCents", {
        id: "spentCents",
        header: ({ column }) => {
          const isSorted = column.getIsSorted()
          return (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => column.toggleSorting(isSorted === "asc")}
                aria-label={t("budgets.colSpent")}
                className="-mr-2 flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{t("budgets.colSpent")}</span>
                {isSorted === "desc" ? (
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                ) : isSorted === "asc" ? (
                  <ArrowUp className="size-3.5" aria-hidden="true" />
                ) : (
                  <ArrowUpDown className="size-3 text-muted-foreground/50" aria-hidden="true" />
                )}
              </button>
            </div>
          )
        },
        cell: ({ row }) => {
          return (
            <div className="text-right font-mono text-sm font-semibold tabular-nums text-foreground">
              {formatCentsBRL(row.original.spentCents, i18n.language)}
            </div>
          )
        },
        enableHiding: true,
      }),

      columnHelper.accessor("limitCents", {
        id: "limitCents",
        header: ({ column }) => {
          const isSorted = column.getIsSorted()
          return (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => column.toggleSorting(isSorted === "asc")}
                aria-label={t("budgets.colLimit")}
                className="-mr-2 flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{t("budgets.colLimit")}</span>
                {isSorted === "desc" ? (
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                ) : isSorted === "asc" ? (
                  <ArrowUp className="size-3.5" aria-hidden="true" />
                ) : (
                  <ArrowUpDown className="size-3 text-muted-foreground/50" aria-hidden="true" />
                )}
              </button>
            </div>
          )
        },
        cell: ({ row }) => {
          return (
            <div className="text-right font-mono text-sm font-semibold tabular-nums text-muted-foreground">
              {formatCentsBRL(row.original.limitCents, i18n.language)}
            </div>
          )
        },
        enableHiding: true,
      }),

      columnHelper.accessor((row) => row.limitCents - row.spentCents, {
        id: "remainingCents",
        header: () => (
          <div className="hidden lg:block text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("budgets.colRemaining", "Saldo")}
          </div>
        ),
        cell: ({ row }) => {
          const remaining = row.original.limitCents - row.original.spentCents
          const isNegative = remaining < 0
          return (
            <div
              className={cn(
                "hidden lg:block text-right font-mono text-xs font-semibold tabular-nums",
                isNegative
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-emerald-600 dark:text-emerald-400"
              )}
            >
              {isNegative ? "- " : "+ "}
              {formatCentsBRL(Math.abs(remaining), i18n.language)}
            </div>
          )
        },
        enableHiding: true,
      }),

      columnHelper.display({
        id: "progress",
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("budgets.colUsage")}
          </span>
        ),
        cell: ({ row }) => {
          return (
            <div className="min-w-44 py-1">
              <BudgetProgress
                spentCents={row.original.spentCents}
                limitCents={row.original.limitCents}
              />
            </div>
          )
        },
        enableHiding: false,
      }),

      columnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">{t("budgets.colActions")}</span>,
        cell: ({ row }) => {
          const item = row.original
          const categoryTitle = item.categoryName ?? item.categoryId
          return (
            <div className="flex justify-end pr-1" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("budgets.actionsOpen", { name: categoryTitle })}
                    className="min-h-11 min-w-11 hover:bg-muted/60"
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => onEdit(item)}>
                      <Pencil className="size-3.5" aria-hidden="true" />
                      {t("budgets.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onRequestDelete(item)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      {t("budgets.remove")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
        enableHiding: false,
      }),
    ])
  }, [t, i18n.language, onEdit, onRequestDelete])

  const table = useTable({
    data: rows,
    columns,
    features,
    state: {
      sorting,
      columnVisibility,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
  })

  const paginationState = table.state.pagination ?? pagination
  const totalRows = rows.length
  const effectiveTotal = totalCount ?? totalRows
  const pageIndex = paginationState.pageIndex
  const pageSize = paginationState.pageSize
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize))

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs", className)}>
      {/* Barra superior de controle de colunas do DataTable */}
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2">
        <div className="text-xs font-medium text-muted-foreground">
          {t("budgets.title", "Orçamentos")}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <SlidersHorizontal className="size-3" />
              <span>{t("common.columns", "Colunas")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-xs">{t("common.toggleColumns", "Exibir colunas")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => {
                const labelMap: Record<string, string> = {
                  categoryName: t("budgets.category", "Categoria"),
                  spentCents: t("budgets.colSpent", "Gasto"),
                  limitCents: t("budgets.colLimit", "Teto"),
                  remainingCents: t("budgets.colRemaining", "Saldo"),
                  progress: t("budgets.colUsage", "Uso"),
                }
                return (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) => column.toggleVisibility(Boolean(value))}
                    className="capitalize text-xs"
                  >
                    {labelMap[column.id] ?? column.id}
                  </DropdownMenuCheckboxItem>
                )
              })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isSpent = header.column.id === "spentCents"
                  const isLimit = header.column.id === "limitCents"
                  const isProgress = header.column.id === "progress"
                  const isActions = header.column.id === "actions"
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        (isSpent || isLimit) && "text-right",
                        isProgress && "min-w-44",
                        isActions && "w-[52px] text-right"
                      )}
                    >
                      {header.isPlaceholder ? null : (
                        <FlexRender header={header} />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => {
              const item = row.original
              const categoryTitle = item.categoryName ?? item.categoryId
              return (
                <TableRow
                  key={row.id}
                  tabIndex={0}
                  onClick={() => onEdit(item)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onEdit(item)
                    }
                  }}
                  aria-label={t("budgets.rowOpenEdit", { name: categoryTitle })}
                  className="cursor-pointer transition-colors hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {row.getVisibleCells().map((cell) => {
                    const isSpent = cell.column.id === "spentCents"
                    const isLimit = cell.column.id === "limitCents"
                    const isActions = cell.column.id === "actions"
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          (isSpent || isLimit || isActions) && "text-right"
                        )}
                      >
                        <FlexRender cell={cell} />
                      </TableCell>
                    )
                  })}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* Paginação e Rodapé Integrado */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/60 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
        <div>
          <span>
            {t("budgets.footerShowing", {
              shown: table.getRowModel().rows.length,
              total: effectiveTotal,
            })}
          </span>
          <span className="hidden sm:inline ml-2 text-[11px]">
            • <span>{t("budgets.footerHint")}</span>
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={rowsPerPageId} className="hidden sm:inline text-xs font-medium text-muted-foreground">
              {t("common.rowsPerPage", "Linhas:")}
            </Label>
            <Select
              value={String(pageSize)}
              onValueChange={(val) => {
                const newSize = Number(val)
                table.setPageSize(newSize)
                setPagination((prev) => ({ ...prev, pageSize: newSize, pageIndex: 0 }))
              }}
            >
              <SelectTrigger id={rowsPerPageId} className="h-7 w-[68px] text-xs">
                <SelectValue placeholder={String(pageSize)} />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-[11px] font-mono text-muted-foreground mr-1">
              {pageIndex + 1}/{pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => table.setPageIndex(0)}
              disabled={pageIndex === 0}
              aria-label={t("common.pagination.first", "Primeira página")}
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => table.previousPage()}
              disabled={pageIndex === 0}
              aria-label={t("common.pagination.previous", "Página anterior")}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => table.nextPage()}
              disabled={pageIndex >= pageCount - 1}
              aria-label={t("common.pagination.next", "Próxima página")}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => table.setPageIndex(pageCount - 1)}
              disabled={pageIndex >= pageCount - 1}
              aria-label={t("common.pagination.last", "Última página")}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
