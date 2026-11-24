"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/shadcn/ui/button"
import {
  applyColorMode,
  persistColorMode,
  readColorMode,
  type ColorMode,
} from "@/lib/color-mode"

export function ModeToggle() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<ColorMode>(() => readColorMode())

  useEffect(() => {
    applyColorMode(mode)
  }, [mode])

  function toggle(): void {
    const next: ColorMode = mode === "dark" ? "light" : "dark"
    setMode(next)
    applyColorMode(next)
    persistColorMode(next)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-pressed={mode === "dark"}
      aria-label={t("shell.toggleTheme")}
      title={t("shell.theme")}
      className="max-sm:min-h-11 max-sm:min-w-11"
    >
      {mode === "dark" ? <Sun /> : <Moon />}
    </Button>
  )
}
