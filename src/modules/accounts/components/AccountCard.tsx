import { useTranslation } from 'react-i18next'
import {
  MoreVertical,
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  Building2,
  Lock,
  ArrowRight,
  Upload,
  ArrowLeftRight,
  ExternalLink,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/shadcn/ui/badge'
import { Button } from '@/components/shadcn/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/shadcn/ui/dropdown-menu'
import { formatCentsBRL } from '@/lib/utils'
import { institutionInfo, type AccountType, type AccountViewItem } from '../model/view-model'

const TYPE_LABEL_KEY: Record<AccountType, string> = {
  checking: 'accounts.card.typeChecking',
  savings: 'accounts.card.typeSavings',
  investment: 'accounts.card.typeInvestment',
  wallet: 'accounts.card.typeWallet',
  physical_cash: 'accounts.card.typePhysicalCash',
}

export function bankLineText(
  t: (key: string, options?: Record<string, unknown>) => string,
  account: AccountViewItem,
): string {
  if (account.agency === '---') {
    return t('accounts.bankLineNoAgency', { account: account.accountNumber, digit: account.accountDigit })
  }
  return t('accounts.bankLine', {
    agency: account.agency,
    account: account.accountNumber,
    digit: account.accountDigit,
  })
}

interface AccountCardProps {
  account: AccountViewItem
  isSelected: boolean
  onSelect: (account: AccountViewItem) => void
  onTransferFrom?: (account: AccountViewItem) => void
  onImportOFX?: (account: AccountViewItem) => void
  onEdit?: (account: AccountViewItem) => void
  onDelete?: (account: AccountViewItem) => void
}

export function AccountCard({ account, isSelected, onSelect, onTransferFrom, onImportOFX, onEdit, onDelete }: AccountCardProps) {
  const { t } = useTranslation()
  const institution = institutionInfo(account.institution)

  const connectionBadge = () => {
    switch (account.connectionStatus) {
      case 'connected':
        return (
          <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {t('accounts.connectionBadge.connected')}
          </Badge>
        )
      case 'syncing':
        return (
          <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary text-[10px] font-semibold gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {t('accounts.connectionBadge.syncing')}
          </Badge>
        )
      case 'error':
        return (
          <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive text-[10px] font-semibold gap-1">
            <AlertCircle className="h-3 w-3" />
            {t('accounts.connectionBadge.error')}
          </Badge>
        )
      case 'manual':
        return (
          <Badge variant="secondary" className="text-[10px] text-muted-foreground font-semibold">
            {t('accounts.connectionBadge.manual')}
          </Badge>
        )
    }
  }

  return (
    <div
      className={`group relative flex flex-col justify-between rounded-2xl border p-4 transition-all cursor-pointer ${
        isSelected
          ? 'border-primary bg-card ring-2 ring-primary/20 shadow-sm'
          : 'border-border/80 bg-card hover:border-border hover:shadow-xs'
      }`}
    >
      {/* C-A16: alvo real de seleção — botão, focável e com anel visível */}
      <button
        type="button"
        onClick={() => onSelect(account)}
        aria-label={t('accounts.card.selectAria', { name: account.nickname })}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <div className="pointer-events-none relative z-10">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-bold text-xs tracking-wider border shadow-2xs ${institution.lightBg}`}>
              {institution.iconInitials}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                  {account.nickname}
                </h3>
                {account.isDefault && (
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-semibold bg-primary/10 text-primary border-transparent">
                    {t('accounts.card.default')}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground truncate">{institution.name || account.nickname}</p>
            </div>
          </div>

          <div className="pointer-events-auto relative z-10">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('accounts.card.actionsAria', { name: account.nickname })}
                  className="min-h-11 min-w-11 p-0 text-muted-foreground hover:text-foreground sm:h-8 sm:min-h-8 sm:min-w-8"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 text-xs">
                <DropdownMenuItem onClick={() => onSelect(account)} className="gap-2">
                  <ExternalLink className="h-3.5 w-3.5 text-primary" />
                  <span>{t('accounts.card.viewStatement')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onTransferFrom?.(account)} className="gap-2">
                  <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{t('accounts.card.transferFrom')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onImportOFX?.(account)} className="gap-2">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{t('accounts.card.importOfx')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onEdit?.(account)} className="gap-2">
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>{t('accounts.card.edit')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDelete?.(account)} className="gap-2 text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{t('accounts.card.delete')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" />
                  <span>{t('accounts.card.configureConnection')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono tabular-nums pb-2 border-b border-border/60">
          <span>{t(TYPE_LABEL_KEY[account.type])}</span>
          <span>{bankLineText(t, account)}</span>
        </div>
      </div>

      <div className="pointer-events-none relative z-10 pt-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-muted-foreground font-medium">{t('accounts.card.available')}</span>
          <span className="font-mono text-lg font-extrabold text-foreground tabular-nums">
            {formatCentsBRL(account.currentBalanceCents)}
          </span>
        </div>

        {account.blockedBalanceCents > 0 && (
          <div className="flex items-center justify-between text-[10px] text-amber-600 dark:text-amber-400 font-mono tabular-nums">
            <span className="flex items-center gap-1">
              <Lock className="h-3 w-3" /> {t('accounts.card.blocked')}
            </span>
            <span>{formatCentsBRL(account.blockedBalanceCents)}</span>
          </div>
        )}

        <div className="flex items-center justify-between pt-1 border-t border-border/50">
          {connectionBadge()}
          <span className="text-[10px] text-muted-foreground">{t(`accounts.sync.${account.connectionStatus}`)}</span>
        </div>
      </div>

      {isSelected && (
        <div className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs">
          <ArrowRight className="h-3 w-3" />
        </div>
      )}
    </div>
  )
}
