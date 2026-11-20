"use client"

import {
  IconCreditCard,
  IconDotsVertical,
  IconLogout,
  IconNotification,
  IconUserCircle,
} from "@tabler/icons-react"
import type { ComponentType } from "react"

import { Badge } from "@/components/shadcn/ui/badge"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/shadcn/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/shadcn/ui/dropdown-menu"
import { useNavigate } from "react-router-dom"

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/shadcn/ui/sidebar"
import { cn } from "@/lib/cn"

import { useAuthStore } from "@/store/auth-store"

export interface NavUserData {
  name: string
  email: string
  avatar: string
  /** Secundário em `font-mono tabular-nums` (UUID mascarado do operador). */
  secondaryMono?: boolean
}

export interface NavUserMenuItem {
  id?: string
  label: string
  icon?: ComponentType<{ className?: string }>
  badge?: string
  onSelect?: () => void
}

export interface NavUserProps {
  user: NavUserData
  /** Grupo de itens acima de `Sair`. Default: Conta/Faturamento/Notificações. */
  userMenuItems?: NavUserMenuItem[]
  /** Ação de `Sair`. Default: `signOut` do auth-store + `/login`. */
  onSignOut?: () => void
  /** Ponto verde de presença. Default: `true`. */
  showPresence?: boolean
  /** Rótulo do item de saída. Default: `Sair`. */
  signOutLabel?: string
}

const defaultMenuItems: NavUserMenuItem[] = [
  { id: "account", label: "Conta", icon: IconUserCircle },
  { id: "billing", label: "Faturamento", icon: IconCreditCard },
  { id: "notifications", label: "Notificações", icon: IconNotification, badge: "2" },
]

export function NavUser({
  user,
  userMenuItems = defaultMenuItems,
  onSignOut,
  showPresence = true,
  signOutLabel = "Sair",
}: NavUserProps) {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  const signOut = useAuthStore((state) => state.signOut)

  async function handleLogout() {
    if (onSignOut) {
      onSignOut()
      return
    }
    await signOut()
    navigate("/login", { replace: true })
  }

  const secondaryClassName = cn(
    "truncate text-xs text-muted-foreground",
    user.secondaryMono && "font-mono tabular-nums",
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="max-md:min-h-11 rounded-lg border border-border/40 bg-sidebar/50 transition-colors data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground hover:bg-sidebar-accent/80 hover:border-border/60"
            >
              <div className="relative">
                <Avatar className="h-8 w-8 rounded-lg ring-1 ring-border/60">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                    {user.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                {showPresence ? (
                  <span
                    aria-hidden="true"
                    className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-sidebar bg-emerald-500"
                  />
                ) : null}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className={secondaryClassName}>{user.email}</span>
              </div>
              <IconDotsVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="relative w-(--radix-dropdown-menu-trigger-width) min-w-56 overflow-hidden rounded-xl border border-border/70 p-1 shadow-[0_4px_16px_rgba(0,0,0,0.08),0_12px_32px_rgba(0,0,0,0.06)] dark:border-border/60 dark:shadow-none"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent dark:via-white/20"
            />
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg ring-1 ring-border/60">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                    {user.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className={secondaryClassName}>{user.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            {userMenuItems.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {userMenuItems.map((item) => {
                    const ItemIcon = item.icon
                    return (
                      <DropdownMenuItem
                        key={item.id ?? item.label}
                        onSelect={item.onSelect}
                      >
                        {ItemIcon ? <ItemIcon /> : null}
                        {item.label}
                        {item.badge ? (
                          <Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[10px]">
                            {item.badge}
                          </Badge>
                        ) : null}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuGroup>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <IconLogout />
              {signOutLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
