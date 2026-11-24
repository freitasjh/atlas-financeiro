import { MockPage } from "./MockPage"
import { CheckoutView } from "@/components/shadcn/checkout"

export function CheckoutPage() {
  return (
    <MockPage titleKey="mockViews.checkout">
      <CheckoutView />
    </MockPage>
  )
}

export default CheckoutPage
