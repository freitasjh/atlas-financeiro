import { MockPage } from "./MockPage"
import { TransactionsView } from "@/components/shadcn/transactions"

export function TransactionsPage() {
  return (
    <MockPage titleKey="mockViews.transactions">
      <TransactionsView />
    </MockPage>
  )
}

export default TransactionsPage
