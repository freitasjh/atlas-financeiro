import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/shadcn/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/shadcn/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/shadcn/ui/alert"

interface DeleteAccountDialogProps {
  open: boolean
  accountName: string
  error: string | null
  isDeleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

// O nome é retido pelo dono da tela durante a animação de saída; quando ele é
// vazio o texto cai na variante sem nome (nunca `Excluir ""?`).
export function DeleteAccountDialog({
  open,
  accountName,
  error,
  isDeleting,
  onOpenChange,
  onConfirm,
}: DeleteAccountDialogProps) {
  const { t } = useTranslation()
  const name = accountName.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("accounts.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {name ? t("accounts.deleteHint", { name }) : t("accounts.deleteHintFallback")}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("common.error")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting}
            aria-busy={isDeleting}
            className="min-h-11"
          >
            {isDeleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("accounts.remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
