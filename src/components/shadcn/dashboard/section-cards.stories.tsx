import type { Meta, StoryObj } from "@storybook/react-vite"

import { SectionCards } from "./section-cards"
import type { DashboardKpiValues } from "@/lib/dashboard/types"

const kpis: DashboardKpiValues = {
  liquidityCents: 12509000n,
  realizedExpenseCents: 340000n,
  realizedIncomeCents: 800000n,
  openInvoicesCents: 50000n,
  projectedBalanceCents: 12700000n,
  previousExpenseCents: 310000n,
  previousIncomeCents: 750000n,
}

const meta = {
  title: "Shadcn/Dashboard/SectionCards",
  component: SectionCards,
  parameters: { layout: "padded" },
  args: { kpis, onRetry: () => undefined },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="bg-background p-6 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SectionCards>

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
export const Loading: Story = { args: { kpis: null, loading: true } }
export const Error: Story = { args: { error: true } }
export const Empty: Story = { args: { kpis: null } }
export const Success: Story = {
  args: { kpis },
  play: ({ canvasElement }) => {
    if (!canvasElement.textContent?.includes("R$ 125.090,00")) {
      throw new globalThis.Error("K1 não foi renderizado a partir de cêntimos reais")
    }
  },
}
