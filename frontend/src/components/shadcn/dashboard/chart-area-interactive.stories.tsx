import type { Meta, StoryObj } from "@storybook/react-vite"

import { ChartAreaInteractive } from "./chart-area-interactive"
import type { MonthlySeriesPoint } from "@/lib/dashboard/series"
import type { TopCategory } from "@/lib/dashboard/top-categories"

const series: MonthlySeriesPoint[] = [
  { month: "2025-12", income_cents: 12000n, expense_cents: 3000n },
  { month: "2026-01", income_cents: 9000n, expense_cents: 4200n },
  { month: "2026-02", income_cents: 15000n, expense_cents: 5100n },
  { month: "2026-03", income_cents: 11000n, expense_cents: 2800n },
  { month: "2026-04", income_cents: 14000n, expense_cents: 6300n },
  { month: "2026-05", income_cents: 17000n, expense_cents: 4900n },
  { month: "2026-06", income_cents: 12500n, expense_cents: 3300n },
  { month: "2026-07", income_cents: 15500n, expense_cents: 7100n },
  { month: "2026-08", income_cents: 13200n, expense_cents: 4000n },
  { month: "2026-09", income_cents: 18000n, expense_cents: 5500n },
  { month: "2026-10", income_cents: 16000n, expense_cents: 6200n },
  { month: "2026-11", income_cents: 800000n, expense_cents: 340000n },
]

const topCategories: TopCategory[] = [
  { category_id: "cat-a", total_cents: 180000n },
  { category_id: "cat-b", total_cents: 95000n },
  { category_id: null, total_cents: 40000n },
]

const meta = {
  title: "Shadcn/Dashboard/ChartAreaInteractive",
  component: ChartAreaInteractive,
  parameters: { layout: "padded" },
  args: { series, topCategories, hasAnyData: true, onRetry: () => undefined },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="bg-background p-6 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChartAreaInteractive>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Active: Story = { parameters: { pseudo: { active: true } } }
export const Hover: Story = { parameters: { pseudo: { hover: true } } }
export const Focus: Story = {
  args: { error: true },
  play: ({ canvasElement }) => canvasElement.querySelector("button")?.focus(),
}
export const Disabled: Story = {
  decorators: [
    (Story) => (
      <div aria-disabled="true" className="pointer-events-none opacity-60">
        <Story />
      </div>
    ),
  ],
}
export const Loading: Story = { args: { loading: true, series: [], topCategories: [] } }
export const Error: Story = { args: { error: true } }
export const Empty: Story = {
  args: { hasAnyData: false, series: [], topCategories: [] },
}
export const Success: Story = {
  play: ({ canvasElement }) => {
    if (canvasElement.querySelectorAll('[role="img"]').length !== 2) {
      throw new globalThis.Error("G1/G2 não expuseram role=img com aria-label")
    }
  },
}
