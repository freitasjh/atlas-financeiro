import { useRef, type KeyboardEvent, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/shadcn/ui/toggle-group"
import { cn } from "@/lib/cn"

/**
 * Controle segmentado único para alternância de modo (ex.: Extrato/Carteira).
 * Fonte única de estilo e comportamento: conta e cartão usam exatamente o
 * mesmo componente, superfície, estado ativo, roving tabindex e navegação por
 * setas (WCAG 2.1 AA / radiogroup).
 */
export const VIEW_MODE_PILL_CLASS = cn(
  "min-h-11 shrink-0 gap-1.5 px-3 text-xs font-medium sm:min-h-8",
  "text-muted-foreground hover:bg-transparent hover:text-foreground",
  "data-[state=on]:bg-secondary data-[state=on]:text-foreground",
  "dark:data-[state=on]:bg-background data-[state=on]:font-semibold",
  "data-[state=on]:shadow-2xs data-[state=on]:ring-1 data-[state=on]:ring-border/60",
  "focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
  "focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  "transition-colors duration-150 motion-reduce:transition-none",
)

export interface ViewModeToggleItem {
  value: string
  label: ReactNode
  ariaLabel: string
  shortLabel?: ReactNode
  icon?: LucideIcon
}

interface ViewModeToggleProps {
  value: string
  onValueChange: (value: string) => void
  ariaLabel: string
  items: ViewModeToggleItem[]
  className?: string
  "data-testid"?: string
}

export function ViewModeToggle({
  value,
  onValueChange,
  ariaLabel,
  items,
  className,
  "data-testid": dataTestId,
}: ViewModeToggleProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % items.length
        break
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + items.length) % items.length
        break
      case " ":
      case "Enter":
        event.preventDefault()
        onValueChange(items[index]?.value ?? value)
        return
      default:
        return
    }
    event.preventDefault()
    const nextValue = items[nextIndex]?.value
    if (nextValue) onValueChange(nextValue)
    itemRefs.current[nextIndex]?.focus()
  }

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next)
      }}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      spacing={1}
      className={cn(
        "flex w-fit max-w-full shrink-0 items-center self-start rounded-lg border border-border/80 bg-muted/40 p-0.5 sm:self-end",
        className,
      )}
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <ToggleGroupItem
            key={item.value}
            ref={(node) => {
              itemRefs.current[index] = node
            }}
            value={item.value}
            aria-label={item.ariaLabel}
            tabIndex={item.value === value ? 0 : -1}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={VIEW_MODE_PILL_CLASS}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {item.shortLabel ? <span className="sm:hidden">{item.shortLabel}</span> : null}
            <span className={cn(item.shortLabel && "hidden sm:inline")}>{item.label}</span>
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
