"use client"

import * as React from "react"
import { Check, X, Sparkles, HelpCircle, ShieldCheck } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/shadcn/ui/button"
import { Switch } from "@/components/shadcn/ui/switch"
import { cn } from "@/lib/cn"
import { formatCentsBRL } from "@/lib/utils"
import {
  planCtaHref,
  registerCtaHref,
  resolvePlanSlug,
} from "@/modules/landing/model/catalog"
import {
  type BillingPeriod,
  PRICING_PLANS,
  COMPARISON_TABLE,
  type PricingPlan,
} from "./pricing-types"

interface PricingTableProps {
  className?: string
  onSelectPlan?: (planId: string, billing: BillingPeriod) => void
  showComparison?: boolean
}

export function PricingTable({
  className,
  onSelectPlan,
  showComparison = true,
}: PricingTableProps) {
  const { t, i18n } = useTranslation()
  const [billing, setBilling] = React.useState<BillingPeriod>("annually")
  const [isComparisonOpen, setIsComparisonOpen] = React.useState(false)

  const isAnnual = billing === "annually"

  /**
   * Render fail-soft: usa a chave i18n quando ela existe; caso contrário
   * mantém o literal do template (evolução aditiva, sem fork).
   */
  const tr = (key: string | undefined, fallback: string | undefined): string => {
    if (key && i18n.exists(key)) return t(key)
    return fallback ?? ""
  }

  const renderCellContent = (value: string | boolean | undefined) => {
    if (typeof value === "boolean") {
      return value ? (
        <Check className="h-4 w-4 text-emerald-500 mx-auto stroke-[2.5]" />
      ) : (
        <X className="h-4 w-4 text-muted-foreground/40 mx-auto" />
      )
    }
    if (typeof value === "string") {
      const text = value.startsWith("pricing.") ? tr(value, value) : value
      return (
        <span className="font-mono text-muted-foreground font-semibold">
          {text}
        </span>
      )
    }
    return <span className="text-muted-foreground/30">—</span>
  }

  return (
    <section className={cn("relative mx-auto w-full max-w-7xl py-12 px-4 sm:px-6 lg:px-8", className)}>
      {/* Cabeçalho da Seção */}
      <div className="flex flex-col items-center text-center max-w-3xl mx-auto mb-10">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs font-semibold text-foreground tracking-wide mb-3 shadow-2xs">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span>{t("pricing.eyebrow")}</span>
        </div>

        <h2 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
          {t("pricing.heading")}
        </h2>

        <p className="mt-3 text-sm text-muted-foreground sm:text-base leading-relaxed max-w-2xl">
          {t("pricing.lead")}
        </p>

        {/* Toggle de Faturamento (Mensal vs Anual) */}
        <div className="mt-8 flex items-center justify-center gap-3">
          <span
            className={cn(
              "text-xs font-semibold transition-colors cursor-pointer",
              !isAnnual ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setBilling("monthly")}
          >
            {t("pricing.billingMonthly")}
          </span>

          <Switch
            checked={isAnnual}
            onCheckedChange={(checked) => setBilling(checked ? "annually" : "monthly")}
            aria-label={t("pricing.billingToggleAria")}
          />

          <span
            className={cn(
              "flex items-center gap-2 text-xs font-semibold transition-colors cursor-pointer",
              isAnnual ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setBilling("annually")}
          >
            <span>{t("pricing.billingAnnually")}</span>
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 dark:bg-emerald-500/20 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
              {t("pricing.save20")}
            </span>
          </span>
        </div>
      </div>

      {/* Cards de Preço */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6 items-stretch">
        {PRICING_PLANS.map((plan: PricingPlan) => {
          const price = isAnnual ? plan.priceAnnually : plan.priceMonthly
          const formattedPrice = formatCentsBRL(price)

          return (
            <div
              key={plan.id}
              className={cn(
                "relative flex flex-col justify-between rounded-2xl border bg-card p-6 transition-all duration-200",
                plan.isPopular
                  ? "border-primary shadow-[0_8px_32px_rgba(0,0,0,0.08)] ring-2 ring-primary/20 z-10 scale-[1.02] lg:-translate-y-2"
                  : "border-border/80 shadow-xs hover:border-foreground/30 hover:shadow-md"
              )}
            >
              {/* Rim light superior */}
              <div
                className={cn(
                  "pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-2xl",
                  plan.isPopular
                    ? "bg-gradient-to-r from-transparent via-primary to-transparent"
                    : "bg-gradient-to-r from-transparent via-foreground/15 to-transparent"
                )}
              />

              {/* Badge de Destaque */}
              {plan.badge && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-bold tracking-wide uppercase text-primary-foreground shadow-sm">
                    <Sparkles className="h-3 w-3" />
                    {tr(plan.badgeKey, plan.badge)}
                  </span>
                </div>
              )}

              <div>
                {/* Nome do Plano e Descrição */}
                <div className="flex items-center justify-between">
                  <h3 className="text-xl font-bold tracking-tight text-foreground">
                    {plan.name}
                  </h3>
                  {plan.limitLabel && (
                    <span className="rounded-md border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {tr(plan.limitLabelKey, plan.limitLabel)}
                    </span>
                  )}
                </div>

                <p className="mt-2 text-xs text-muted-foreground leading-relaxed min-h-[36px]">
                  {tr(plan.descriptionKey, plan.description)}
                </p>

                {/* Preço */}
                <div className="mt-6 flex items-baseline gap-1 border-y border-border/50 py-4">
                  <span className="font-mono text-3xl sm:text-4xl font-extrabold tracking-tight text-foreground tabular-nums">
                    {formattedPrice}
                  </span>
                  <span className="text-xs text-muted-foreground font-medium">
                    {t("pricing.perMonth")} {isAnnual && price > 0 && <span className="text-[10px] block text-emerald-700 dark:text-emerald-400 font-semibold">{t("pricing.billedAnnually")}</span>}
                  </span>
                </div>

                {/* Lista de Features */}
                <div className="mt-6 space-y-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    {t("pricing.includedHeading")}
                  </p>

                  <ul className="space-y-2.5 text-xs">
                    {plan.features.map((feature, fIdx) => (
                      <li
                        key={fIdx}
                        className={cn(
                          "flex items-start gap-2.5 leading-tight",
                          feature.included
                            ? feature.highlight
                              ? "font-semibold text-foreground"
                              : "text-foreground/90"
                            : "text-muted-foreground line-through"
                        )}
                      >
                        {feature.included ? (
                          <Check
                            className={cn(
                              "h-3.5 w-3.5 shrink-0 mt-0.5",
                              feature.highlight
                                ? "text-primary stroke-[2.5]"
                                : "text-emerald-500"
                            )}
                          />
                        ) : (
                          <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 mt-0.5" />
                        )}
                        <span>{tr(feature.textKey, feature.text)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Ações — cadastro (principal) + convite (alternativa), empilhados */}
              <div className="mt-8 pt-4 border-t border-border/40">
                <div className="flex flex-col gap-2">
                  <Button
                    asChild
                    variant={plan.isPopular ? "default" : "outline"}
                    className={cn(
                      "w-full h-11 text-xs font-semibold shadow-xs",
                      plan.isPopular && "shadow-md hover:shadow-lg"
                    )}
                  >
                    {/* Link real (hash router). `onSelectPlan` segue disponível
                        para telemetria/estado; API do componente inalterada. */}
                    <a
                      href={`#${registerCtaHref(plan.id)}`}
                      data-testid="landing-cta"
                      onClick={() => onSelectPlan?.(plan.id, billing)}
                    >
                      {t("landing.heroCta")}
                    </a>
                  </Button>

                  <Button asChild variant="outline" className="w-full h-11 text-xs font-semibold">
                    <a
                      href={`#${planCtaHref(resolvePlanSlug(plan.id))}`}
                      data-testid="landing-invite-cta"
                    >
                      {t("landing.inviteCta")}
                    </a>
                  </Button>
                </div>

                <p className="mt-2 text-center text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-emerald-500" />
                  {t("pricing.noCommitment")}
                </p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Botão para Expandir Tabela Comparativa Detalhada */}
      {showComparison && (
        <div className="mt-16 text-center">
          <Button
            type="button"
            variant="ghost"
            data-testid="pricing-compare-toggle"
            onClick={() => setIsComparisonOpen(!isComparisonOpen)}
            className="text-xs font-semibold text-foreground hover:bg-muted/50 gap-2 border border-border/60"
          >
            <span>{isComparisonOpen ? t("pricing.hideComparison") : t("pricing.showComparison")}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {isComparisonOpen ? "▲" : "▼"}
            </span>
          </Button>
        </div>
      )}

      {/* Tabela Comparativa Detalhada (Feature Comparison Matrix) */}
      {showComparison && isComparisonOpen && (
        <div className="mt-8 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border/80 bg-muted/30">
                  <th className="p-4 text-xs font-bold text-foreground uppercase tracking-wider w-2/6">
                    {t("pricing.compareHeader")}
                  </th>
                  <th className="p-4 text-center text-xs font-bold text-foreground uppercase tracking-wider w-1/6">
                    Free
                  </th>
                  <th className="p-4 text-center text-xs font-bold text-foreground uppercase tracking-wider w-1/6">
                    Standard
                  </th>
                  <th className="p-4 text-center text-xs font-bold text-primary uppercase tracking-wider w-1/6 bg-primary/5">
                    {t("pricing.proPopular")}
                  </th>
                  <th className="p-4 text-center text-xs font-bold text-foreground uppercase tracking-wider w-1/6">
                    Full
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 text-xs">
                {COMPARISON_TABLE.map((cat, catIdx) => (
                  <React.Fragment key={catIdx}>
                    <tr className="bg-muted/20">
                      <td
                        colSpan={5}
                        className="py-2.5 px-4 font-bold text-[11px] uppercase tracking-wider text-muted-foreground"
                      >
                        {tr(cat.categoryKey, cat.category)}
                      </td>
                    </tr>
                    {cat.features.map((feat, featIdx) => (
                      <tr
                        key={featIdx}
                        className="hover:bg-muted/10 transition-colors"
                      >
                        <td className="p-4 font-medium text-foreground">
                          {tr(feat.nameKey, feat.name)}
                        </td>

                        {/* Free */}
                        <td className="p-4 text-center">
                          {renderCellContent(feat.free ?? feat.starter)}
                        </td>

                        {/* Standard */}
                        <td className="p-4 text-center">
                          {renderCellContent(feat.standard ?? feat.starter)}
                        </td>

                        {/* Pro */}
                        <td className="p-4 text-center bg-primary/5 font-semibold text-foreground">
                          {renderCellContent(feat.pro ?? feat.professional)}
                        </td>

                        {/* Full */}
                        <td className="p-4 text-center font-medium">
                          {renderCellContent(feat.full ?? feat.enterprise)}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Nota de rodapé da tabela de preços */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-500" /> {t("pricing.footerNoFee")}
        </span>
        <span className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-500" /> {t("pricing.footerCancel")}
        </span>
        <span className="flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-500" /> {t("pricing.footerControl")}
        </span>
        <span className="flex items-center gap-1.5">
          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" /> {t("pricing.footerSupport")}
        </span>
      </div>
    </section>
  )
}
