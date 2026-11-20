import * as React from "react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
} from "@/components/shadcn/ui/sidebar"
import { SidebarNavItem, type NavMainItem } from "@/components/shadcn/navigation/nav-main"

export function NavSecondary({
  items,
  ...props
}: {
  items: NavMainItem[]
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarNavItem
              key={item.url}
              title={item.title}
              url={item.url}
              icon={item.icon}
              badge={item.badge}
              end={item.end}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
