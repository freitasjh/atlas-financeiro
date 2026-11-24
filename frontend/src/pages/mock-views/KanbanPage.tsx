import { MockPage } from "./MockPage"
import { KanbanBoard } from "@/components/shadcn/kanban"

export function KanbanPage() {
  return (
    <MockPage titleKey="mockViews.kanban">
      <KanbanBoard />
    </MockPage>
  )
}

export default KanbanPage
