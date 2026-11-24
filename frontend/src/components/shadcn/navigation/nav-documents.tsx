import { useTranslation } from "react-i18next"
import {
  IconDots,
  IconFolder,
  IconShare3,
  IconTrash,
  type Icon,
} from "@tabler/icons-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/shadcn/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/shadcn/ui/sidebar"
import { SidebarNavItem } from "@/components/shadcn/navigation/nav-main"

export function NavDocuments({
  items,
}: {
  items: {
    name: string
    url: string
    icon: Icon
  }[]
}) {
  const { isMobile } = useSidebar()
  const { t } = useTranslation()

  const itemAction = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          showOnHover
          className="rounded-sm data-[state=open]:bg-accent"
        >
          <IconDots />
          <span className="sr-only">{t("sidebar.more")}</span>
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-24 rounded-lg"
        side={isMobile ? "bottom" : "right"}
        align={isMobile ? "end" : "start"}
      >
        <DropdownMenuItem>
          <IconFolder />
          <span>{t("sidebar.open")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <IconShare3 />
          <span>{t("sidebar.share")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <IconTrash />
          <span>{t("sidebar.remove")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{t("sidebar.documents")}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarNavItem
            key={item.name}
            title={item.name}
            url={item.url}
            icon={item.icon}
            action={itemAction}
          />
        ))}
        <SidebarMenuItem>
          <SidebarMenuButton className="text-sidebar-foreground/70">
            <IconDots className="text-sidebar-foreground/70" />
            <span>{t("sidebar.more")}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}
