export type BillingPeriod = "monthly" | "annually"

export interface PricingFeature {
  text: string
  /**
   * Chave i18n opcional (`pricing.*`). Quando ausente ou não resolvida, o
   * componente cai no literal `text` — evolução aditiva, sem fork do template.
   */
  textKey?: string
  included: boolean
  highlight?: boolean
}

export interface PricingPlan {
  id: string
  /** Nome do produto (Free/Standard/Pro/Full) — permanece literal. */
  name: string
  description: string
  descriptionKey?: string
  badge?: string
  badgeKey?: string
  isPopular?: boolean
  priceMonthly: number
  priceAnnually: number
  features: PricingFeature[]
  ctaText: string
  ctaKey?: string
  limitLabel?: string
  limitLabelKey?: string
}

export interface ComparisonCategory {
  category: string
  categoryKey?: string
  features: {
    name: string
    nameKey?: string
    tooltip?: string
    tooltipKey?: string
    free?: string | boolean
    standard?: string | boolean
    pro?: string | boolean
    full?: string | boolean
    starter?: string | boolean
    professional?: string | boolean
    enterprise?: string | boolean
  }[]
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    id: "free",
    name: "Free",
    descriptionKey: "pricing.freeDescription",
    description: "O essencial para quem quer começar a organizar contas e gastos sem custo algum.",
    priceMonthly: 0,
    priceAnnually: 0,
    limitLabelKey: "pricing.freeLimit",
    limitLabel: "Até 2 contas",
    ctaKey: "landing.inviteCta",
    ctaText: "Solicitar convite",
    features: [
      { textKey: "pricing.freeFeature1", text: "Até 2 contas cadastradas", included: true },
      { textKey: "pricing.freeFeature2", text: "Lançamentos manuais ilimitados", included: true },
      { textKey: "pricing.freeFeature3", text: "Categorização de receitas e despesas", included: true },
      { textKey: "pricing.freeFeature4", text: "Acesso web e responsivo no celular", included: true },
      { textKey: "pricing.freeFeature5", text: "Faturas de cartão por ciclo", included: false },
      { textKey: "pricing.freeFeature6", text: "Importação de extratos bancários", included: false },
      { textKey: "pricing.freeFeature7", text: "Tetos e orçamentos por categoria", included: false },
      { textKey: "pricing.freeFeature8", text: "Regras automáticas de autocategorização", included: false },
    ],
  },
  {
    id: "standard",
    name: "Standard",
    descriptionKey: "pricing.standardDescription",
    description: "Para quem quer controle completo de contas correntes, cartões e extratos bancários.",
    priceMonthly: 1990,
    priceAnnually: 1592, // 20% off (equiv. mensal de 19104 cents anuais)
    limitLabelKey: "pricing.standardLimit",
    limitLabel: "Contas ilimitadas",
    ctaKey: "pricing.ctaChoose",
    ctaText: "Escolher Standard",
    features: [
      { textKey: "pricing.standardFeature1", text: "Contas e carteiras ilimitadas", included: true },
      { textKey: "pricing.standardFeature2", text: "Gestão de cartões por ciclo de fatura", included: true, highlight: true },
      { textKey: "pricing.standardFeature3", text: "Importação de extratos OFX e CSV", included: true },
      { textKey: "pricing.standardFeature4", text: "Lançamentos e parcelamentos futuros", included: true },
      { textKey: "pricing.standardFeature5", text: "Painel consolidado de saldos reais", included: true },
      { textKey: "pricing.standardFeature6", text: "Tetos mensais por categoria", included: false },
      { textKey: "pricing.standardFeature7", text: "Regras automáticas de categorização", included: false },
      { textKey: "pricing.standardFeature8", text: "Suporte prioritário via chat", included: false },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    descriptionKey: "pricing.proDescription",
    description: "O plano mais completo para planejamento financeiro, metas e controle preventivo.",
    badgeKey: "pricing.proBadge",
    badge: "Mais Escolhido",
    isPopular: true,
    priceMonthly: 3990,
    priceAnnually: 3192, // 20% off (equiv. mensal de 38304 cents anuais)
    limitLabelKey: "pricing.proLimit",
    limitLabel: "Recomendado",
    ctaKey: "pricing.ctaChoose",
    ctaText: "Escolher Pro",
    features: [
      { textKey: "pricing.proFeature1", text: "Tudo o que está no plano Standard", included: true, highlight: true },
      { textKey: "pricing.proFeature2", text: "Tetos e orçamentos mensais por categoria", included: true, highlight: true },
      { textKey: "pricing.proFeature3", text: "Regras automáticas de autocategorização", included: true },
      { textKey: "pricing.proFeature4", text: "Alertas de limites e vencimento de faturas", included: true },
      { textKey: "pricing.proFeature5", text: "Auditoria e conciliação bancária assistida", included: true },
      { textKey: "pricing.proFeature6", text: "Relatórios mensais detalhados", included: true },
      { textKey: "pricing.proFeature7", text: "Exportação de dados em CSV e relatórios", included: true },
      { textKey: "pricing.proFeature8", text: "Suporte prioritário via chat e e-mail", included: true },
    ],
  },
  {
    id: "full",
    name: "Full",
    descriptionKey: "pricing.fullDescription",
    description: "Solução definitiva para máxima organização financeira com suporte prioritário VIP.",
    badgeKey: "pricing.fullBadge",
    badge: "Completo",
    priceMonthly: 6990,
    priceAnnually: 5592, // 20% off (equiv. mensal de 67104 cents anuais)
    limitLabelKey: "pricing.fullLimit",
    limitLabel: "Acesso Total",
    ctaKey: "pricing.ctaChoose",
    ctaText: "Escolher Full",
    features: [
      { textKey: "pricing.fullFeature1", text: "Tudo o que está no plano Pro", included: true },
      { textKey: "pricing.fullFeature2", text: "Contas e finanças compartilhadas", included: true, highlight: true },
      { textKey: "pricing.fullFeature3", text: "Relatórios consolidados avançados", included: true },
      { textKey: "pricing.fullFeature4", text: "Backup automático redundante", included: true },
      { textKey: "pricing.fullFeature5", text: "Acesso antecipado a novas funcionalidades", included: true },
      { textKey: "pricing.fullFeature6", text: "Suporte VIP com atendimento acelerado", included: true },
    ],
  },
]

export const COMPARISON_TABLE: ComparisonCategory[] = [
  {
    categoryKey: "pricing.catAccounts",
    category: "Gestão de Contas & Lançamentos",
    features: [
      {
        nameKey: "pricing.featBankAccounts",

        name: "Contas Bancárias Cadastradas",
        free: "pricing.cellUpTo2",
        standard: "pricing.cellUnlimited",
        pro: "pricing.cellUnlimited",
        full: "pricing.cellUnlimited",
      },
      {
        nameKey: "pricing.featManualEntries",

        name: "Lançamentos Manuais de Entradas e Saídas",
        free: true,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featSmartCategories",

        name: "Categorização Inteligente",
        free: true,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featBalancePanel",

        name: "Painel Consolidado de Saldos",
        free: true,
        standard: true,
        pro: true,
        full: true,
      },
    ],
  },
  {
    categoryKey: "pricing.catCards",
    category: "Cartões de Crédito & Faturas",
    features: [
      {
        nameKey: "pricing.featInvoicesByCycle",

        name: "Faturas Organizadas por Ciclo",
        free: false,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featInstallmentProvision",

        name: "Provisão de Parcelamentos Futuros",
        free: false,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featCommittedLimit",

        name: "Indicador Visual de Limite Comprometido",
        free: false,
        standard: true,
        pro: true,
        full: true,
      },
    ],
  },
  {
    categoryKey: "pricing.catBudgets",
    category: "Orçamentos & Automação",
    features: [
      {
        nameKey: "pricing.featMonthlyCaps",

        name: "Tetos Mensais por Categoria",
        free: false,
        standard: false,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featAutoRules",

        name: "Regras Automáticas de Categorização",
        free: false,
        standard: false,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featLimitAlerts",

        name: "Alertas Preventivos de Limite",
        free: false,
        standard: false,
        pro: true,
        full: true,
      },
    ],
  },
  {
    categoryKey: "pricing.catImport",
    category: "Importação & Relatórios",
    features: [
      {
        nameKey: "pricing.featOfxImport",

        name: "Importação de Extratos OFX e CSV",
        free: false,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featDupDetection",

        name: "Detecção Automática de Duplicatas",
        free: false,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featReportExport",

        name: "Exportação de Relatórios Financeiros",
        free: false,
        standard: false,
        pro: true,
        full: true,
      },
    ],
  },
  {
    categoryKey: "pricing.catSecurity",
    category: "Segurança & Suporte",
    features: [
      {
        nameKey: "pricing.featEncryptionIsolation",

        name: "Criptografia e Isolamento por Conta",
        free: true,
        standard: true,
        pro: true,
        full: true,
      },
      {
        nameKey: "pricing.featSupport",

        name: "Suporte Técnico",
        free: "pricing.cellCommunity",
        standard: "pricing.cellEmail48h",
        pro: "pricing.cellPriorityChat",
        full: "pricing.cellVipDedicated",
      },
    ],
  },
]
