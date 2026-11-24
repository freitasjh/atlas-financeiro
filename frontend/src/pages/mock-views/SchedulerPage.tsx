import { MockPage } from "./MockPage"
import { Scheduler } from "@/components/shadcn/scheduler"

export function SchedulerPage() {
  return (
    <MockPage titleKey="mockViews.scheduler">
      <Scheduler />
    </MockPage>
  )
}

export default SchedulerPage
