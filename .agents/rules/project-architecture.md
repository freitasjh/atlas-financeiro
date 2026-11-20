# Project Architecture — atlas-financeiro

Three independent app modules:
1. Landing + conversion (public): value prop, interactive demo, pricing, checkout, support terms.
2. Core SaaS (auth): dashboard, ledger (editable grid), credit cards, invoices, reconciliation staging, rules, budgets.
3. Backoffice (superadmin): MRR/ARR/churn/conversion, tenant management, operational telemetry.

Key RF: RF01 auth, RF02 accounts, RF03 credit cards, RF04 transactions, RF05 installments, RF06 anticipation, RF07 invoice payment, RF08 statement ingestion, RF09 dedup, RF10 auto-categorization, RF11 budgets, RF12 bulk ops, RF13 subscriptions.

Performance: TanStack Table virtualization (RNF03); FCP <1.2s via Cloudflare CDN (RNF05); keyboard shortcuts + bottom sheets (RNF04).

## Congelado Fase 1 (I7/I8 fechados)
- 8 rotas: `/login /register /reset` (BlankLayout) + protegidas `/ /lancamentos /cartoes /config` (DefaultLayout) + `*` 404. Guards: 401→refresh→login.
- CommandPalette Cmd/Ctrl+K placeholder (rotas + tema/idioma).
- 9 primitivos shadcn: Button, Input, Card, Dialog, Table (simples, sem virtualização), Badge, Skeleton, Sonner/toast, Drawer/BottomSheet.
- 9 compostos shell (design-system): AppShell, BlankLayout, Topbar, BottomNav, CommandPalette, PageHeader, StateBlock, DataTableStub, ThemeLocaleSwitch (consomem os primitivos).
- N/A Fase 1 (follow-ups): virtualização TanStack Table (RNF03), Recharts, bulk edit, ingestão, backoffice, FCP<1.2s (RNF05→Módulo 4).
