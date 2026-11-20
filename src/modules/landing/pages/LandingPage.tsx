"use client"

import {
  ArrowRight,
  Check,
  ShieldCheck,
  CreditCard,
  PiggyBank,
  Receipt,
  FileSpreadsheet,
  ChevronRight,
  Star,
  Zap,
  Minus,
  Sparkles,
  Menu,
  X,
} from "lucide-react"

import { Button } from "@/components/shadcn/ui/button"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/shadcn/ui/accordion"
import { ModeToggle } from "@/components/shadcn/navigation/mode-toggle"
import { PricingTable } from "@/components/shadcn/pricing/pricing-table"
import { ShowcaseTabs } from "@/modules/landing/components/ShowcaseTabs"
import { revealInPageTarget } from "@/lib/in-page-anchor"
import { useTranslation } from "react-i18next"
import { flushSync } from "react-dom"
import { useEffect, useRef, useState } from "react"
import type { MouseEvent } from "react"

const COMPARE_ROWS = [
  "landing.compareRow1",
  "landing.compareRow2",
  "landing.compareRow3",
  "landing.compareRow4",
] as const

const featureKeys = [
  "planProFeature1",
  "planFullFeature1",
] as const

/** Âncoras internas compartilhadas pela navbar desktop e pelo disclosure mobile. */
const NAV_LINKS = [
  { id: "hero", labelKey: "landing.navHero" },
  { id: "demo", labelKey: "landing.navDemo" },
  { id: "prova", labelKey: "landing.navProof" },
  { id: "recursos", labelKey: "landing.navFeatures" },
  { id: "como-funciona", labelKey: "landing.navSteps" },
  { id: "planos", labelKey: "landing.navPlans" },
  { id: "faq", labelKey: "landing.navFaqShort" },
] as const

/** Corte único do header: `lg` (1024). Abaixo disso só o disclosure. */
const DESKTOP_NAV_MEDIA_QUERY = "(min-width: 1024px)"

export function LandingPage() {
  const { t } = useTranslation()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const mobileNavButtonRef = useRef<HTMLButtonElement | null>(null)

  const handleNavigate = (path: string) => {
    const target = path.startsWith("#") ? path : `#${path}`
    window.location.hash = target
  }

  // Seções internas não podem usar `href="#id"`: no hash router isso vira a
  // rota `/id` (404). O clique é interceptado e vira scroll, sem tocar no hash.
  const handleSectionLink = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    revealInPageTarget(id)
  }

  // O disclosure existe só abaixo de `lg`; ao entrar em `≥lg` ele é descartado.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia(DESKTOP_NAV_MEDIA_QUERY)
    const closeOnDesktop = () => {
      if (query.matches) setMobileNavOpen(false)
    }
    closeOnDesktop()
    query.addEventListener("change", closeOnDesktop)
    return () => query.removeEventListener("change", closeOnDesktop)
  }, [])

  const closeMobileNav = () => setMobileNavOpen(false)

  const handleMobileSectionLink =
    (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      // O painel é `sticky`-in-flow: ele empurra o layout enquanto aberto.
      // Fechar ANTES de medir evita rolar para uma posição que deixa de existir.
      flushSync(() => setMobileNavOpen(false))
      revealInPageTarget(id)
    }

  // `Escape` fecha o disclosure e devolve o foco ao botão que o abriu — vale
  // com o foco em qualquer ponto da página (o painel não prende foco).
  useEffect(() => {
    if (!mobileNavOpen) return
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return
      setMobileNavOpen(false)
      mobileNavButtonRef.current?.focus()
    }
    document.addEventListener("keydown", handleEscape)
    return () => document.removeEventListener("keydown", handleEscape)
  }, [mobileNavOpen])

  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-primary/20 selection:text-primary">
      <button
        type="button"
        onClick={() => revealInPageTarget("main", { focus: true })}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:min-h-11 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:text-primary-foreground"
      >
        {t("a11y.skipToContent")}
      </button>
      {/* ============================================================ */}
      {/* 1. NAVBAR SUPERIOR                                           */}
      {/* ============================================================ */}
      <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          {/* Logo e Badge */}
          <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none">
            <a
              href="#/landing"
              className="flex min-w-0 items-center gap-2.5 font-bold tracking-tight text-foreground transition-opacity hover:opacity-90"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs font-mono font-bold text-base">
                A
              </div>
              <span className="truncate text-base font-extrabold tracking-tight sm:text-lg">
                Atlas Financeiro
              </span>
            </a>
            <span className="hidden sm:inline-flex items-center rounded-full border border-border/80 bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-foreground/90">
              v2.0
            </span>
          </div>

          {/* Links de Navegação Desktop */}
          <nav
            data-testid="nav-desktop"
            className="hidden lg:flex items-center gap-4 xl:gap-6 text-xs font-semibold text-foreground/90"
          >
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href="#/landing"
                data-scroll-target={link.id}
                onClick={handleSectionLink(link.id)}
                className="transition-colors hover:text-foreground"
              >
                {t(link.labelKey)}
              </a>
            ))}
          </nav>

          {/* Ações e Alternador de Tema (≥sm) */}
          <div
            data-testid="header-actions"
            className="hidden items-center gap-2 sm:flex sm:gap-3"
          >
            <ModeToggle />

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleNavigate("#/login")}
              className="h-11 text-xs font-semibold hover:bg-muted"
            >
              {t("landing.heroLogin")}
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={() => handleNavigate("/solicitar-convite")}
              className="h-11 text-xs font-semibold shadow-xs gap-1.5"
            >
              <span>{t("landing.inviteCta")}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Disclosure <lg: único controle do header estreito */}
          <Button
            ref={mobileNavButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            data-testid="landing-mobile-nav-toggle"
            aria-controls="landing-mobile-nav"
            aria-expanded={mobileNavOpen}
            aria-label={
              mobileNavOpen ? t("landing.navMenuClose") : t("landing.navMenuOpen")
            }
            onClick={() => setMobileNavOpen((open) => !open)}
            className="h-11 w-11 shrink-0 lg:hidden"
          >
            {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>

        {/* Painel do disclosure — sem backdrop, sem focus trap, sem scroll lock */}
        {mobileNavOpen && (
          <div
            id="landing-mobile-nav"
            className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-border/60 bg-background p-4 lg:hidden"
          >
            <nav
              aria-label={t("landing.navMobileLabel")}
              className="flex flex-col gap-1"
            >
              {NAV_LINKS.map((link) => (
                <a
                  key={link.id}
                  href="#/landing"
                  data-scroll-target={link.id}
                  onClick={handleMobileSectionLink(link.id)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 text-sm font-semibold text-foreground/90 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="truncate">{t(link.labelKey)}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </a>
              ))}
            </nav>

            <div role="presentation" className="my-3 h-px bg-border/60" />

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  closeMobileNav()
                  handleNavigate("#/login")
                }}
                className="h-11 w-full justify-center text-sm font-semibold"
              >
                {t("landing.heroLogin")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  closeMobileNav()
                  handleNavigate("/solicitar-convite")
                }}
                className="h-11 w-full justify-center gap-1.5 text-sm font-semibold"
              >
                <span>{t("landing.inviteCta")}</span>
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>

            <div role="presentation" className="my-3 h-px bg-border/60" />

            <div className="flex min-h-11 items-center justify-between px-1">
              <span className="text-xs font-semibold text-foreground/90">
                {t("shell.theme")}
              </span>
              <ModeToggle />
            </div>
          </div>
        )}
      </header>

      <main id="main" tabIndex={-1} className="focus:outline-none">
      {/* ============================================================ */}
      {/* 2. HERO SECTION                                              */}
      {/* ============================================================ */}
      <section id="hero" className="relative scroll-mt-16 overflow-hidden pt-12 pb-20 sm:scroll-mt-20 sm:pt-16 sm:pb-28">
        {/* Glow de fundo sutil sem saturação escura */}
        <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-full max-w-[700px] -translate-x-1/2 rounded-full bg-primary/5 blur-3xl" />

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          {/* Micro-badge de anúncio */}
          <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/40 px-3.5 py-1 text-xs font-medium text-foreground shadow-2xs mb-6 hover:bg-muted/60 transition-colors cursor-pointer">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold text-primary">{t("landing.heroEyebrow")}:</span>
            <span>{t("landing.heroAnnounce")}</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </div>

          {/* Headline Imponente */}
          <h1 className="mx-auto max-w-4xl text-4xl font-extrabold tracking-tight text-foreground sm:text-5xl lg:text-6xl leading-[1.15]">
            {t("landing.heroTitle")}
          </h1>

          {/* Subheadline */}
          <p className="mx-auto mt-6 max-w-2xl text-sm sm:text-base text-muted-foreground leading-relaxed">
            {t("landing.heroSubtitleLong")}
          </p>

          {/* Botões de Ação */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="#/solicitar-convite"
              data-testid="landing-cta"
              onClick={(e) => {
                e.preventDefault()
                handleNavigate("/solicitar-convite")
              }}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-md transition-all hover:bg-primary/90"
            >
              <span>{t("landing.inviteCta")}</span>
              <ArrowRight className="h-4 w-4" />
            </a>

            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => handleNavigate("#/login")}
              className="h-11 px-6 text-sm font-semibold border-border/80 hover:bg-muted/50"
            >
              {t("landing.inviteLogin")}
            </Button>
          </div>

          {/* Micro Trust Pills */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-6 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Check className="h-4 w-4 text-emerald-500 stroke-[2.5]" />
              {t("landing.invitePill1")}
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="h-4 w-4 text-emerald-500 stroke-[2.5]" />
              {t("landing.heroPillOfx")}
            </span>
            <span className="flex items-center gap-1.5">
              <Check className="h-4 w-4 text-emerald-500 stroke-[2.5]" />
              {t("landing.heroPillIsolation")}
            </span>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* SHOWCASE INTERATIVO AO VIVO NO HERO (id="demo")             */}
      {/* ============================================================ */}
      <section id="demo" className="scroll-mt-16 pb-16 pt-2 sm:scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="relative mx-auto max-w-6xl">
            {/* Rim light superior */}
            <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

            {/* ShowcaseTabs: Tabs de Finanças Pessoais (Faturas, Extrato, Orçamentos, Regras) */}
            <ShowcaseTabs />
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 3. FORMATOS E BANCOS COMPATÍVEIS (id="prova")               */}
      {/* ============================================================ */}
      <section id="prova" className="scroll-mt-16 border-y border-border/60 bg-muted/20 py-10 sm:scroll-mt-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {t("landing.proofTitle")}
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-8 sm:gap-14 opacity-75 filter saturate-0 transition-all hover:opacity-100 hover:saturate-100">
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              // NUBANK
            </span>
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              • ITAÚ
            </span>
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              [+] BRADESCO
            </span>
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              ~ SANTANDER
            </span>
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              &gt; BANCO DO BRASIL
            </span>
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              • INTER
            </span>
            <span className="font-mono text-base font-bold tracking-tight text-foreground">
              // C6 BANK
            </span>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3 max-w-3xl mx-auto pt-6 border-t border-border/50 text-left">
            <div className="rounded-xl border border-border/60 bg-card p-4">
              <p className="text-xs text-muted-foreground">{t("landing.proofStat1Label")}</p>
              <p className="text-2xl font-extrabold text-foreground mt-1 tabular-nums">5 min</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{t("landing.proofStat1Hint")}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-4">
              <p className="text-xs text-muted-foreground">{t("landing.proofStat2Label")}</p>
              <p className="text-2xl font-extrabold text-foreground mt-1 tabular-nums">R$ 0</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{t("landing.proofStat2Hint")}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-card p-4">
              <p className="text-xs text-muted-foreground">{t("landing.proofStat3Label")}</p>
              <p className="text-2xl font-extrabold text-foreground mt-1 tabular-nums">100%</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{t("landing.proofStat3Hint")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 4. BENTO GRID DE RECURSOS (id="recursos")                    */}
      {/* ============================================================ */}
      <section id="recursos" className="scroll-mt-16 py-20 sm:scroll-mt-20 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <span className="text-xs font-bold uppercase tracking-wider text-primary">
              {t("landing.recursosEyebrow")}
            </span>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              {t("landing.recursosHeading")}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base leading-relaxed">
              {t("landing.recursosLead")}
            </p>
          </div>

          {/* Bento Grid Editorial Assimétrico */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            {/* Card 1: 8 Colunas (Destaque - Faturas & Cartões por Ciclo) */}
            <div className="relative md:col-span-8 flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 sm:p-8 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 mb-4">
                  <CreditCard className="h-5 w-5" />
                </div>
                <h3 className="text-xl font-bold tracking-tight text-foreground">
                  {t("landing.bentoCardsTitle")}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground sm:text-sm leading-relaxed max-w-xl">
                  {t("landing.bentoCardsDesc")}
                </p>
              </div>

              {/* Prévia visual técnica */}
              <div className="mt-6 rounded-xl border border-border/60 bg-muted/30 p-4">
                <div className="flex items-center justify-between text-xs font-mono text-muted-foreground pb-2 border-b border-border/50">
                  <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-bold">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    {t("landing.bentoCardsMockCycle")}
                  </span>
                  <span>{t("landing.bentoCardsMockCommitted")}</span>
                </div>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg bg-background p-2.5 border border-border/60 shadow-2xs">
                    <p className="text-[10px] text-muted-foreground">{t("landing.bentoCardsMockCurrent")}</p>
                    <p className="font-semibold text-foreground text-sm mt-0.5">R$ 3.400,00</p>
                  </div>
                  <div className="rounded-lg bg-background p-2.5 border border-border/60 shadow-2xs">
                    <p className="text-[10px] text-muted-foreground">{t("landing.bentoCardsMockAvailable")}</p>
                    <p className="font-semibold text-emerald-700 dark:text-emerald-400 text-sm mt-0.5">R$ 1.600,00</p>
                  </div>
                  <div className="rounded-lg bg-background p-2.5 border border-border/60 shadow-2xs">
                    <p className="text-[10px] text-muted-foreground">{t("landing.bentoCardsMockNext")}</p>
                    <p className="font-semibold text-foreground text-sm mt-0.5">R$ 1.250,00</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: 4 Colunas (Tetos Mensais por Categoria) */}
            <div className="relative md:col-span-4 flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 sm:p-8 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400 mb-4">
                  <PiggyBank className="h-5 w-5" />
                </div>
                <h3 className="text-xl font-bold tracking-tight text-foreground">
                  {t("landing.bentoBudgetTitle")}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground sm:text-sm leading-relaxed">
                  {t("landing.bentoBudgetDesc")}
                </p>
              </div>

              <div className="mt-6 rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
                <div className="rounded-lg bg-background p-2.5 border border-border/70 shadow-2xs">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-foreground">{t("landing.bentoBudgetCategory")}</span>
                    <span className="font-mono text-muted-foreground">R$ 452 / R$ 800</span>
                  </div>
                  <div
                    className="w-full bg-muted h-2 rounded-full mt-2 overflow-hidden"
                    role="progressbar"
                    aria-label={t("landing.bentoBudgetBarLabel")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={56}
                  >
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: "56%" }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Card 3: 4 Colunas (Lançamentos e Extratos) */}
            <div className="relative md:col-span-4 flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 sm:p-8 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 mb-4">
                  <Receipt className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-bold tracking-tight text-foreground">
                  {t("landing.bentoStatementTitle")}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  {t("landing.bentoStatementDesc")}
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-border/50 flex items-center justify-between font-mono text-xs">
                <span className="text-muted-foreground">{t("landing.bentoStatementFlowLabel")}</span>
                <span className="font-bold text-foreground">{t("landing.bentoStatementFlowValue")}</span>
              </div>
            </div>

            {/* Card 4: 4 Colunas (Importação Inteligente OFX/CSV) */}
            <div className="relative md:col-span-4 flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 sm:p-8 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400 mb-4">
                  <Sparkles className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-bold tracking-tight text-foreground">
                  {t("landing.bentoImportTitle")}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  {t("landing.bentoImportDesc")}
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-border/50 flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                <span>{t("landing.bentoImportAntiDup")}</span>
              </div>
            </div>

            {/* Card 5: 4 Colunas (Exportação e Relatórios) */}
            <div className="relative md:col-span-4 flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 sm:p-8 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary mb-4">
                  <FileSpreadsheet className="h-5 w-5" />
                </div>
                <h3 className="text-lg font-bold tracking-tight text-foreground">
                  {t("landing.bentoExportTitle")}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  {t("landing.bentoExportDesc")}
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-border/50 flex items-center justify-between text-xs text-muted-foreground font-mono">
                <span>{t("landing.bentoExportFormats")}</span>
                <span data-testid="landing-export-soon" className="rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {t("landing.exportSoon")}
                </span>
                <span>CSV • XLSX • PDF</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 5. COMO FUNCIONA & DEPOIMENTOS (id="como-funciona")          */}
      {/* ============================================================ */}
      <section id="como-funciona" className="scroll-mt-16 border-t border-border/60 py-20 sm:scroll-mt-20 sm:py-28">
        <div id="depoimentos" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto mb-16">
            <span className="text-xs font-bold uppercase tracking-wider text-primary">
              {t("landing.stepsEyebrow")}
            </span>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              {t("landing.stepsTitle")}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground sm:text-base">
              {t("landing.stepsLead")}
            </p>
          </div>

          {/* 3 Passos */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-20">
            <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-2xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-sm mb-4">
                1
              </div>
              <h3 className="font-bold text-foreground text-base">{t("landing.inviteStep1Title")}</h3>
              <p className="mt-2 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                {t("landing.inviteStep1Desc")}
              </p>
            </div>

            <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-2xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-sm mb-4">
                2
              </div>
              <h3 className="font-bold text-foreground text-base">{t("landing.inviteStep2Title")}</h3>
              <p className="mt-2 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                {t("landing.inviteStep2Desc")}
              </p>
            </div>

            <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-2xs">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-sm mb-4">
                3
              </div>
              <h3 className="font-bold text-foreground text-base">{t("landing.inviteStep3Title")}</h3>
              <p className="mt-2 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                {t("landing.inviteStep3Desc")}
              </p>
            </div>
          </div>

          {/* Depoimentos */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Depoimento 1 */}
            <div className="relative flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex items-center gap-1 text-amber-500 mb-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-amber-500" />
                  ))}
                </div>
                <p className="text-xs sm:text-sm text-foreground/90 leading-relaxed italic">
                  &ldquo;{t("landing.testimonial1Quote")}&rdquo;
                </p>
              </div>

              <div className="mt-6 pt-4 border-t border-border/50 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-bold flex items-center justify-center text-xs">
                  LM
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground">Lucas Mendes</p>
                  <p className="text-[11px] text-muted-foreground">{t("landing.testimonial1Role")}</p>
                </div>
              </div>
            </div>

            {/* Depoimento 2 */}
            <div className="relative flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex items-center gap-1 text-amber-500 mb-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-amber-500" />
                  ))}
                </div>
                <p className="text-xs sm:text-sm text-foreground/90 leading-relaxed italic">
                  &ldquo;{t("landing.testimonial2Quote")}&rdquo;
                </p>
              </div>

              <div className="mt-6 pt-4 border-t border-border/50 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-300 font-bold flex items-center justify-center text-xs">
                  CL
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground">Carlos Eduardo Lima</p>
                  <p className="text-[11px] text-muted-foreground">{t("landing.testimonial2Role")}</p>
                </div>
              </div>
            </div>

            {/* Depoimento 3 */}
            <div className="relative flex flex-col justify-between rounded-2xl border border-border/80 bg-card p-6 shadow-xs">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent rounded-t-2xl" />
              <div>
                <div className="flex items-center gap-1 text-amber-500 mb-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-amber-500" />
                  ))}
                </div>
                <p className="text-xs sm:text-sm text-foreground/90 leading-relaxed italic">
                  &ldquo;{t("landing.testimonial3Quote")}&rdquo;
                </p>
              </div>

              <div className="mt-6 pt-4 border-t border-border/50 flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-300 font-bold flex items-center justify-center text-xs">
                  MS
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground">Mariana Siqueira</p>
                  <p className="text-[11px] text-muted-foreground">{t("landing.testimonial3Role")}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 6. TABELA DE PREÇOS (id="planos" e id="precos")              */}
      {/* ============================================================ */}
      <section id="planos" className="scroll-mt-16 border-t border-border/60 bg-muted/15 py-12 sm:scroll-mt-20">
        <div id="precos" className="w-full">
          <PricingTable onSelectPlan={(plan) => handleNavigate(`/solicitar-convite?plano=${plan}`)} />
        </div>
        {/* Tabela acessível sr-only com comparação de planos e features i18n */}
        <div className="sr-only">
          <table>
            <thead>
              <tr>
                <th>
                  <span className="sr-only">{t("landing.compareFeatureHeader")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((rowKey) => (
                <tr key={rowKey}>
                  <td>
                    <span role="img" aria-label={t("landing.included")}><Check className="h-4 w-4" /></span>
                  </td>
                  <td>
                    <span role="img" aria-label={t("landing.notIncluded")}><Minus className="h-4 w-4" /></span>
                  </td>
                </tr>
              ))}
              {featureKeys.map((key) => (
                <tr key={key}>
                  <td>{t(`landing.${key}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 7. DÚVIDAS FREQUENTES (id="faq")                             */}
      {/* ============================================================ */}
      <section id="faq" className="scroll-mt-16 border-t border-border/60 bg-muted/10 py-20 sm:scroll-mt-20 sm:py-28">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <span className="text-xs font-bold uppercase tracking-wider text-primary">
              {t("landing.faqEyebrow")}
            </span>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl">
              {t("landing.faqHeading")}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              {t("landing.faqLead")}
            </p>
          </div>

          <Accordion type="single" collapsible className="w-full rounded-2xl border border-border/70 bg-card p-6 shadow-xs">
            <AccordionItem value="item-1">
              <AccordionTrigger>{t("landing.faqQ1")}</AccordionTrigger>
              <AccordionContent>
                {t("landing.inviteFaqAnswer1")}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-2">
              <AccordionTrigger>{t("landing.faqQ2")}</AccordionTrigger>
              <AccordionContent>
                {t("landing.faqA2")}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-3">
              <AccordionTrigger>{t("landing.faqQ3")}</AccordionTrigger>
              <AccordionContent>
                {t("landing.faqA3")}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-4">
              <AccordionTrigger>{t("landing.faqQ4")}</AccordionTrigger>
              <AccordionContent>
                {t("landing.faqA4")}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-5">
              <AccordionTrigger>{t("landing.faqQ5")}</AccordionTrigger>
              <AccordionContent>
                {t("landing.faqA5")}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </section>
      </main>

      {/* ============================================================ */}
      {/* 8. BANNER CTA FINAL                                          */}
      {/* ============================================================ */}
      <section
        data-testid="landing-final-cta"
        className="relative overflow-hidden py-20 sm:py-24 border-t border-border/60 bg-card text-center"
      >
        {/* Rim light superior */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/25 to-transparent" />

        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary mb-4">
            <Zap className="h-3.5 w-3.5" />
            <span>{t("landing.finalCtaEyebrow")}</span>
          </div>

          <h2 className="text-3xl font-extrabold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
            {t("landing.finalCtaHeading")}
          </h2>

          <p className="mt-4 text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            {t("landing.inviteFinalBody")}
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              type="button"
              size="lg"
              onClick={() => handleNavigate("#/solicitar-convite")}
              className="h-11 px-8 text-sm font-semibold shadow-md gap-2"
            >
              <span>{t("landing.inviteCta")}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 9. FOOTER COMPLETO                                           */}
      {/* ============================================================ */}
      <footer className="border-t border-border/60 bg-muted/20 py-12 text-xs text-muted-foreground">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 pb-10 border-b border-border/50">
            {/* Coluna 1 */}
            <div>
              <p className="font-bold text-foreground text-sm mb-3">{t("landing.footerColProduct")}</p>
              <ul className="space-y-2">
                <li><a href="#/landing" data-scroll-target="recursos" onClick={handleSectionLink("recursos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkOverview")}</a></li>
                <li><a href="#/landing" data-scroll-target="recursos" onClick={handleSectionLink("recursos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkCardsInvoices")}</a></li>
                <li><a href="#/landing" data-scroll-target="recursos" onClick={handleSectionLink("recursos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkCaps")}</a></li>
                <li><a href="#/landing" data-scroll-target="planos" onClick={handleSectionLink("planos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkPlans")}</a></li>
              </ul>
            </div>

            {/* Coluna 2 */}
            <div>
              <p className="font-bold text-foreground text-sm mb-3">{t("landing.footerColFeatures")}</p>
              <ul className="space-y-2">
                <li><a href="#/landing" data-scroll-target="recursos" onClick={handleSectionLink("recursos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkOfx")}</a></li>
                <li><a href="#/landing" data-scroll-target="recursos" onClick={handleSectionLink("recursos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkLimits")}</a></li>
                <li><a href="#/landing" data-scroll-target="recursos" onClick={handleSectionLink("recursos")} className="hover:text-foreground transition-colors">{t("landing.footerLinkCategorization")}</a></li>
                <li><a href="#/landing" data-scroll-target="como-funciona" onClick={handleSectionLink("como-funciona")} className="hover:text-foreground transition-colors">{t("landing.footerLinkHowItWorks")}</a></li>
              </ul>
            </div>

            {/* Coluna 3 */}
            <div>
              <p className="font-bold text-foreground text-sm mb-3">{t("landing.footerColSecurity")}</p>
              <ul className="space-y-2">
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkIsolation")}</span></li>
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkEncryption")}</span></li>
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkLgpd")}</span></li>
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkMfa")}</span></li>
              </ul>
            </div>

            {/* Coluna 4 */}
            <div>
              <p className="font-bold text-foreground text-sm mb-3">Atlas</p>
              <ul className="space-y-2">
                <li><a href="#/landing" data-scroll-target="faq" onClick={handleSectionLink("faq")} className="hover:text-foreground transition-colors">{t("landing.footerLinkFaq")}</a></li>
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkTerms")}</span></li>
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkPrivacy")}</span></li>
                <li><span className="hover:text-foreground transition-colors">{t("landing.footerLinkSupport")}</span></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
            <p className="text-[11px] text-muted-foreground">
              {t("landing.footerCopyright", { year: new Date().getFullYear() })}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {t("landing.footerEnvNote")}
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}
export default LandingPage
