# Stack Context — atlas-financeiro (auto-loaded)

## Frontend (Template Atlas Admin)
- Framework: React 19 + TypeScript (strict mode, `noUnusedLocals`).
- Bundler: Vite v6.
- Estilização & Design System: Tailwind CSS v4 (`@import "tailwindcss"` + `@theme inline`), Shadcn UI (estilo `new-york`, base neutra OKLCH).
- Layout Canônico: `AtlasAdminLayout` (`src/layouts/AtlasAdminLayout.tsx`).
- Tipografia: Inter (Sans) + JetBrains Mono (Mono/Tabular).
- Ícones: `lucide-react`.
- Tokens & Temas: `src/tokens-shadcn.css` + `src/index.css` (DTCG tokens OKLCH claro/escuro via classe `.dark`).

## Backend & Infra
- Backend/DB: Supabase (Postgres 15+, Auth JWT, Edge Functions Deno, Storage). No custom Node/Java backend.
- Edge: Cloudflare Pages (Frontend hosting) + Cloudflare Workers (webhooks/cron). Supabase Edge Functions for heavy parsing.
- Money: BIGINT cents only (RNF01/RN01). Never float/double. Classe `tabular-nums` obrigatória no frontend.
- Multi-tenant: RLS `auth.uid() = user_id` on every protected table.
- Types: generate via `supabase gen types typescript`.

## Freeze Fase 1 (I2/I3/I4 fechados — medido 2026-11-01)
- Node v26.7.0, npm 11.19.0, Supabase CLI v2.121.0, Docker 29.8.1.
- Portas: Supabase local `54321` API, `54322` DB, `54323` Studio, `54324` Inbucket (padrão CLI, confirmar em `supabase status`).
- Comandos: `supabase start/stop/db reset`, `supabase gen types typescript --local`.
- Comandos Frontend: `npm run build`, `npm run typecheck`.
- Module map:
  - Frontend: `src/components/`, `src/layouts/`, `src/app/`, `src/lib/`, `src/hooks/`.
  - Backend: `supabase/migrations`, `supabase/functions`, `supabase/tests`.
