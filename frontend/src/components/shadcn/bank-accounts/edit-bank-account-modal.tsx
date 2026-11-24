import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Building2, Loader2, Save } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/shadcn/ui/dialog"
import { Button } from "@/components/shadcn/ui/button"
import { Input } from "@/components/shadcn/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/shadcn/ui/alert"
import {
  BANK_INSTITUTIONS,
  type BankAccount,
  type BankAccountType,
  type BankInstitutionCode,
} from "./bank-accounts-types"

// Galeria de exemplos: tipos locais de demonstração.
// O contrato real vive em src/modules/accounts/model/view-model.ts.
export interface ExampleEditBankAccountInput {
  name: string
  type: BankAccountType
  institution: BankInstitutionCode
  agency: string
  accountNumber: string
  accountDigit: string
}

interface EditBankAccountModalProps {
  open: boolean
  account: BankAccount | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: ExampleEditBankAccountInput) => void | Promise<void>
}

const TYPE_OPTIONS: BankAccountType[] = ["checking", "savings", "investment", "wallet", "physical_cash"]

const TYPE_LABEL_KEY: Record<BankAccountType, string> = {
  checking: "accounts.typeChecking",
  savings: "accounts.typeSavings",
  investment: "accounts.typeInvestment",
  wallet: "accounts.typeWallet",
  physical_cash: "accounts.typePhysicalCash",
}

const INSTITUTION_OPTIONS = Object.keys(BANK_INSTITUTIONS) as BankInstitutionCode[]

export function EditBankAccountModal({ open, account, onOpenChange, onSubmit }: EditBankAccountModalProps) {
  const { t } = useTranslation()
  const [nickname, setNickname] = useState("")
  const [accountType, setAccountType] = useState<BankAccountType>("checking")
  const [institution, setInstitution] = useState<BankInstitutionCode>("itau")
  const [agency, setAgency] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [accountDigit, setAccountDigit] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const nicknameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || !account) return
    setNickname(account.nickname)
    setAccountType(account.type)
    setInstitution(account.institution)
    setAgency(account.agency === "---" ? "" : account.agency)
    setAccountNumber(account.accountNumber === "---" ? "" : account.accountNumber)
    setAccountDigit(account.accountDigit === "---" ? "" : account.accountDigit)
    setFormError(null)
  }, [open, account])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (nickname.trim() === "") {
      setFormError(t("accounts.nameError"))
      nicknameRef.current?.focus()
      return
    }

    setFormError(null)
    setIsSubmitting(true)
    try {
      await onSubmit({
        name: nickname.trim(),
        type: accountType,
        institution,
        agency,
        accountNumber,
        accountDigit,
      })
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setFormError(
        message.includes("account-negative-balance")
          ? t("accounts.balanceError")
          : t("accounts.saveError"),
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain p-5 sm:max-w-[480px] sm:p-6">
        <DialogHeader className="space-y-1 text-left">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Building2 className="size-5" aria-hidden="true" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">{t("accounts.editTitle")}</DialogTitle>
              <DialogDescription className="text-xs">{t("accounts.editModalHint")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 pt-1" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-account-nickname" className="block text-xs font-semibold text-foreground">
              {t("accounts.nickname")}
            </label>
            <Input
              id="edit-account-nickname"
              ref={nicknameRef}
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              aria-invalid={formError !== null && nickname.trim() === ""}
              aria-describedby={formError !== null ? "edit-account-error" : undefined}
              className="h-11 border-border/80 bg-background text-xs"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-account-institution" className="block text-xs font-semibold text-foreground">
              {t("accounts.institution")}
            </label>
            <select
              id="edit-account-institution"
              value={institution}
              onChange={(e) => setInstitution(e.target.value as BankInstitutionCode)}
              className="h-11 w-full rounded-md border border-border/80 bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {INSTITUTION_OPTIONS.map((code) => (
                <option key={code} value={code}>
                  {BANK_INSTITUTIONS[code].name}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 block text-xs font-semibold text-foreground">
              {t("accounts.typeLabel")}
            </legend>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {TYPE_OPTIONS.map((type) => {
                const isSelected = accountType === type
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setAccountType(type)}
                    aria-pressed={isSelected}
                    className={`min-h-11 rounded-lg border px-2.5 py-2 text-center text-xs transition-all ${
                      isSelected
                        ? "border-primary bg-primary/10 font-bold text-primary shadow-2xs"
                        : "border-border/80 bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t(TYPE_LABEL_KEY[type])}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-4 flex flex-col gap-1.5">
              <label htmlFor="edit-account-agency" className="block text-xs font-semibold text-foreground">
                {t("accounts.agency")}
              </label>
              <Input
                id="edit-account-agency"
                type="text"
                value={agency}
                onChange={(e) => setAgency(e.target.value)}
                className="h-11 border-border/80 bg-background font-mono text-xs tabular-nums"
              />
            </div>
            <div className="col-span-6 flex flex-col gap-1.5">
              <label htmlFor="edit-account-number" className="block text-xs font-semibold text-foreground">
                {t("accounts.accountNumber")}
              </label>
              <Input
                id="edit-account-number"
                type="text"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                className="h-11 border-border/80 bg-background font-mono text-xs tabular-nums"
              />
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <label htmlFor="edit-account-digit" className="block text-xs font-semibold text-foreground">
                {t("accounts.accountDigit")}
              </label>
              <Input
                id="edit-account-digit"
                type="text"
                maxLength={2}
                value={accountDigit}
                onChange={(e) => setAccountDigit(e.target.value)}
                className="h-11 border-border/80 bg-background text-center font-mono text-xs tabular-nums"
              />
            </div>
          </div>

          {formError ? (
            <Alert variant="destructive" id="edit-account-error" role="alert">
              <AlertTitle>{t("common.error")}</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="flex items-center justify-between border-t border-border/60 pt-3">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} className="min-h-11">
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting} className="min-h-11 font-bold">
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="size-4" aria-hidden="true" />
              )}
              {t("accounts.saveAccount")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
