# atlas-financeiro

Harness-governed OpenCode project. No application source lives here yet; the repo currently contains only governance (`.agents/`), the OpenCode plugin (`.opencode/plugins/`), and generated config.

## Layout

- `.agents/rules/*.md` — workflow, coding, security, harness rules. Auto-loaded via `opencode.json` `instructions`; do not duplicate in this file.
- `.agents/agents/*` — subagent prompts (orchestrator, developer-engineer, etc.).
- `.opencode/plugins/` — local plugins, auto-loaded by OpenCode (no `plugin` entries needed).
- `opencode.json` — v2-only config (`agent` singular, `permission`, no `tools` key).
- `harness.config.json` — harness gate data (commands, paths, protected paths).

## Verification

There is no `package.json` or test suite in this repo. `harness.config.json` declares `commands.suiteFull: "npm run test:run"`, but that command will fail until an app with npm scripts exists — do not treat it as runnable here.

Useful checks:
```sh
for f in .opencode/plugins/*.js .opencode/plugins/lib/*.mjs; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('opencode.json','utf8')); JSON.parse(require('fs').readFileSync('harness.config.json','utf8')); console.log('json ok')"
```

Plugin contract (measured, v2.0.32): each module must `export default { id, setup }` and `setup(ctx)` must return `undefined`. A truthy return is called by the runtime and crashes plugin load.

## Constraints

- Not a git repository: `git` commands fail. Do not assume version control.
- Protected paths (`.opencode/plugins/**`, `.agents/rules/**`, `.agents/schemas/**`, `.agents/agents/**`, `opencode.json`, `harness.config.json`) require human resolution / `Harness-Gate-Change` trailer to modify.
- Orchestrator (`agent.orchestrator`) has `edit: deny`; never edit feature code directly — delegate via `task` to `developer-engineer`.
- Agent responses must be in pt_BR (orchestrator mandate).

## Backups

Harness install backups live outside this target at `/home/joao/fusionlf/wsProjeto/.harness-backup-atlas-financeiro-*`. Retain until flagged items resolved and a green suite; rollback = copy files back + remove `.harness-install.json`.
