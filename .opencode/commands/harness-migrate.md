Migre/atualize o projeto atual para o template Harness de Frontend (perfil shadcn).

Passos:
1. Rode `node scripts/migrate.mjs --target .` (use `--profile claude` se o projeto usar o perfil claude; `--force` para sobrescrever tudo).
2. Revise o diff/backup em `.harness-backup/<timestamp>/`.
3. Rode `npm run validate` (ou `node scripts/validate.mjs`).
4. Se houver falhas, corrija antes de concluir.

O comando instala/atualiza: tokens, builder, verify, migrate/validate, oxlint, Storybook+MCP, kit shadcn, commands/skills/agents, docs, `DESIGN.md` adaptado ao perfil decidido e mescla `package.json`/`opencode.jsonc`.