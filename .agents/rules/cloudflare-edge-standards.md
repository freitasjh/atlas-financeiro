# Cloudflare Edge Standards

- Static assets served from Cloudflare Pages (Brotli, Anycast). Build output: Vite `dist/`.
- Workers handle payment webhooks (Stripe/Asaas) and cron jobs; verify webhook signatures before processing.
- Webhook events drive subscription state changes (RF13): checkout, renewal, cancellation.
- No secrets in client bundle; use Wrangler secrets / Supabase service role only in edge.
