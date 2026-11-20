# Skill Overrides — atlas-financeiro (auto-loaded)

Skills vendored em `.agents/skills/` são genéricas multi-stack e citam exemplos Java/Spring/Vue/Flyway/Keycloak/Kafka como ilustração. **Neste repo elas NÃO definem stack.** Prevalência:

- Verdade de stack: `stack-context.md` (React 19 + Vite + Tailwind v4 + Template Atlas Shadcn no frontend; Supabase Postgres + Cloudflare Workers / Edge Functions no backend).
- Frontend / Design System: `DESIGN.md` + Template Atlas Admin (`AtlasAdminLayout`, tokens shadcn em OKLCH, Inter/JetBrains Mono — substitui qualquer menção genérica a Vue ou estilos arbitrários nas skills).
- DB/RLS/dinheiro: `supabase-postgres-standards.md` (substitui qualquer menção Flyway/`V__`/`*IT.java`/Testcontainers/JPA/`@HasPermission` Java).
- Segurança: `security-standard.md` + skill `security-review` (substitui `@HasPermission`/`@Valid` Java por RLS + zod + CHECK).
- Auth: `supabase-js` / Supabase Auth; nunca `localStorage`/axios Bearer.
- Quando skill e rule divergirem, **a rule deste repo vence**; não abrir exceção silenciosa — registrar em `workflow-state.json.overrides`.
