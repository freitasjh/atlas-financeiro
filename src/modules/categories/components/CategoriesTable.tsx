"use client"

import { useId, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Lock,
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

import { cn } from "@/lib/cn"
import { Badge } from "@/components/shadcn/ui/badge"
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
import type { CategoryView } from "../model/category.adapter"

export interface CategoriesTableProps {
  rows: CategoryView[]
  totalCount?: number
  onEdit: (category: CategoryView) => void
  onRequestDelete: (category: CategoryView) => void
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

const columnHelper = createColumnHelper<typeof features, CategoryView>()

export function CategoriesTable({
  rows,
  totalCount,
  onEdit,
  onRequestDelete,
  className,
}: CategoriesTableProps) {
  const { t } = useTranslation()
  const rowsPerPageId = useId()

  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({
    color: true,
    name: true,
    type: true,
    origin: true,
    usageCount: true,
    actions: true,
  })
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 })

  const cycleUsageSort = () => {
    setSorting((prev) => {
      const current = prev.find((s) => s.id === "usageCount")
      if (!current) {
        return [{ id: "usageCount", desc: true }]
      }
      if (current.desc) {
        return [{ id: "usageCount", desc: false }]
      }
      return []
    })
  }

  const usageSort = sorting.find((s) => s.id === "usageCount")
  const usageAriaSort = !usageSort ? "none" : usageSort.desc ? "descending" : "ascending"

  const columns = useMemo(() => {
    return columnHelper.columns([
      columnHelper.accessor("color", {
        id: "color",
        header: () => (
          <span className="sr-only">{t("categories.colColor")}</span>
        ),
        cell: ({ row }) => {
          const color = row.original.color
          return (
            <span
              role="img"
              aria-label={color ?? t("categories.colorNone")}
              style={color ? { backgroundColor: color } : undefined}
              className={cn(
                "block size-3.5 sm:size-4 rounded-full ring-1 ring-border/50 shadow-2xs",
                !color && "border border-dashed border-border/80 bg-transparent ring-0"
              )}
            />
          )
        },
        enableHiding: true,
      }),

      columnHelper.accessor("name", {
        id: "name",
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("categories.colName")}
          </span>
        ),
        cell: ({ row }) => {
          const item = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
                {item.name}
              </span>
              {item.isSystem && (
                <Badge variant="secondary" className="gap-1 text-[10px] font-medium py-0 px-1.5">
                  <Lock className="size-3" aria-hidden="true" />
                  {t("categories.systemBadge")}
                </Badge>
              )}
            </div>
          )
        },
        enableHiding: false,
      }),

      columnHelper.accessor("type", {
        id: "type",
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("categories.colType")}
          </span>
        ),
        cell: ({ row }) => {
          const isIncome = row.original.type === "income"
          return (
            <Badge
              variant="secondary"
              className={cn(
                "gap-1 text-xs font-medium py-0.5 px-2",
                isIncome
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              )}
            >
              {isIncome ? (
                <ArrowUpRight className="size-3" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="size-3" aria-hidden="true" />
              )}
              {isIncome ? t("categories.typeIncome") : t("categories.typeExpense")}
            </Badge>
          )
        },
        enableHiding: true,
      }),

      columnHelper.accessor("isSystem", {
        id: "origin",
        header: () => (
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("categories.colOrigin")}
          </span>
        ),
        cell: ({ row }) => {
          return (
            <span className="text-xs text-muted-foreground">
              {row.original.isSystem ? t("categories.originSystem") : t("categories.originCustom")}
            </span>
          )
        },
        enableHiding: true,
      }),

      columnHelper.accessor("usageCount", {
        id: "usageCount",
        header: () => (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={cycleUsageSort}
              aria-label={t("categories.usageSort")}
              className="ml-auto flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t("categories.colUsage")}
              {usageSort === undefined ? (
                <ArrowUpDown className="size-3.5" aria-hidden="true" />
              ) : usageSort.desc ? (
                <ArrowDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ArrowUp className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        ),
        cell: ({ row }) => {
          return (
            <div className="text-right font-mono text-xs sm:text-sm font-semibold tabular-nums text-foreground">
              {row.original.usageCount}
            </div>
          )
        },
        enableHiding: true,
      }),

      columnHelper.display({
        id: "actions",
        header: () => <span className="sr-only">{t("categories.colActions")}</span>,
        cell: ({ row }) => {
          const item = row.original
          const blocked = item.isSystem || item.usageCount > 0
          const blockReason = item.isSystem
            ? t("categories.systemProtectedReason")
            : t("categories.deleteDisabledReason")

          return (
            <div className="flex justify-end pr-1" onClick={(e) => e.stopPropagation()}>
              {item.isSystem ? (
                <span
                  aria-disabled="true"
                  title={t("categories.systemProtectedReason")}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground/50"
                >
                  <Lock className="size-4" aria-hidden="true" />
                  <span className="sr-only">{t("categories.systemProtectedReason")}</span>
                </span>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("categories.actionsOpen", { name: item.name })}
                      className="min-h-11 min-w-11 hover:bg-muted/60"
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => onEdit(item)}>
                        <Pencil className="size-3.5" aria-hidden="true" />
                        {t("categories.edit")}
                      </DropdownMenuItem>
                      {blocked ? (
                        <DropdownMenuItem
                          aria-disabled="true"
                          title={blockReason}
                          onSelect={(e) => {
                            e.preventDefault()
                            onRequestDelete(item)
                          }}
                          className="text-muted-foreground opacity-70 focus:opacity-100"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          {t("categories.remove")}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onSelect={() => onRequestDelete(item)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                          {t("categories.remove")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )
        },
        enableHiding: false,
      }),
    ])
  }, [t, usageSort, onEdit, onRequestDelete])

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
          {t("categories.title", "Categorias")}
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
                  color: t("categories.colColor", "Cor"),
                  type: t("categories.colType", "Tipo"),
                  origin: t("categories.colOrigin", "Origem"),
                  usageCount: t("categories.colUsage", "Em uso"),
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
                  const isUsage = header.column.id === "usageCount"
                  if (isUsage) {
                    return (
                      <TableHead
                        key={header.id}
                        aria-sort={usageAriaSort}
                        className="text-right"
                      >
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={cycleUsageSort}
                            aria-label={t("categories.usageSort")}
                            className="ml-auto flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            <span>{t("categories.colUsage")}</span>
                            {usageSort === undefined ? (
                              <ArrowUpDown className="size-3.5" aria-hidden="true" />
                            ) : usageSort.desc ? (
                              <ArrowDown className="size-3.5" aria-hidden="true" />
                            ) : (
                              <ArrowUp className="size-3.5" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </TableHead>
                    )
                  }

                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        header.column.id === "color" && "w-[52px]",
                        header.column.id === "actions" && "w-[52px] text-right"
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
              return (
                <TableRow
                  key={row.id}
                  onClick={() => {
                    if (!item.isSystem) onEdit(item)
                  }}
                  aria-label={item.isSystem ? undefined : t("categories.rowOpenEdit", { name: item.name })}
                  className={cn(
                    item.isSystem
                      ? undefined
                      : "cursor-pointer transition-colors hover:bg-muted/50"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        cell.column.id === "color" && "pr-0",
                        cell.column.id === "usageCount" && "text-right font-mono text-sm font-semibold tabular-nums",
                        cell.column.id === "actions" && "text-right"
                      )}
                    >
                      <FlexRender cell={cell} />
                    </TableCell>
                  ))}
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
            {t("categories.footerShowing", {
              shown: table.getRowModel().rows.length,
              total: effectiveTotal,
            })}
          </span>
          <span className="hidden sm:inline ml-2 text-[11px]">
            • <span>{t("categories.footerHint")}</span>
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
