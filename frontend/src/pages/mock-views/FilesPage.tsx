import { MockPage } from "./MockPage"
import { FileManagerView } from "@/components/shadcn/file-manager"

export function FilesPage() {
  return (
    <MockPage titleKey="mockViews.files">
      <FileManagerView />
    </MockPage>
  )
}

export default FilesPage
