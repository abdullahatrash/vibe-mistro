# Next session — design-system epic COMPLETE; pick the next epic (or clear the follow-up backlog)

🎉 The **design-system epic (PRD #109) is fully shipped** — every UI area (tokens → primitives → shell →
sidebar → conversation → composer → auth → git panel) now runs on the design tokens + primitive library.
Baseline is **675 tests** green on `main`. There is **no active epic**; the next one is your call.

Open a fresh Claude Code session **in `/Users/abdullahatrash/mistral/vibe-mistro`** (so `main` is the cwd — it
auto-loads `CLAUDE.md` + the memory index) and paste the block below as the first message.

## Paste this

> Read `HANDOFF.md` (esp. §3 the team loop, §6 what's next) and skim the `design-system-epic` memory. The
> **design-system epic (PRD #109) is COMPLETE** — all of #110–#119 + the sidebar cluster shipped; every area is
> on tokens + primitives. First confirm the baseline: on `main`, run the four gates
> (`export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/.local/bin:$PATH"; bun run lint && bun run typecheck
> && bun run build && bun run test`) → expect **675 tests green** (`main` @ `3485094` or later). Then we pick the
> next thing to work on — either a **new epic** (see the roadmap below) or **clearing the follow-up backlog**
> below. When we build, follow the **team loop in HANDOFF §3**: a manual worktree with a **real `bun install`**
> (never a `node_modules` symlink), an implementer agent (issues carry `/tdd`), your own **independent
> verification** (re-run all four gates + read the diff — always `git diff <commit>^..<commit>` for scope, since
> `main` moves fast in parallel), an **adversarial review** agent, fold fixes, **targeted `git add <paths>`
> (never `-A`)**, push, and **I merge**. For anything touching **auth, security, or a new IPC**, surface the
> decision to me (HITL) before committing. **Ask me which of the two lists below to start**; don't assume.

## ⚠️ Two gotchas that bit us this epic (read these)
- **NO LOCKFILE.** The repo tracks no `bun.lock`. Any PR that ADDS a dependency (this epic added streamdown,
  `@streamdown/code`, `use-stick-to-bottom`, CVA, `@fontsource-variable/geist`) means **you MUST `bun install`
  after every `git pull` on `main`** — otherwise `bun run dev`/build fail to resolve the new package. This bit
  the user twice.
- **`main` moves fast in parallel.** Judge an implementer's scope with **`git diff <commit>^..<commit>`** (against
  the commit's PARENT), NOT `git diff origin/main` — a moved `origin/main` shows phantom "out-of-scope" files.
  When a merge conflicts because `main` advanced mid-slice, rebuild clean: `git reset --hard origin/main` then
  `git checkout <impl-sha> -- <only the in-scope files>`, recommit (real bug we hit on #117/#153/#114).

## Open follow-up backlog (small, tracked issues — good warm-up work)
- **#168** — file-path chips NEVER render: streamdown's `harden` blocks relative/file link hrefs (`[x](path)` →
  `[blocked]`) before our chip override runs (a #114-era issue). The reveal IPC + `FileChip` are built + secure
  and READY; this fixes the harden config (SECURITY-SENSITIVE — must re-verify `javascript:` stays blocked). Also
  the place to consider auto-linkifying bare file paths in prose (agents rarely emit markdown file-links).
- **#164** — a tool row spins forever if ACP omits a terminal `tool_call_update` (thread `streaming` into
  `ToolRow`; show a static glyph once settled).
- **#162** — streamdown table `<thead>` renders dark-grey (the `muted` token-collision, tables only). Override
  `th`/`thead` in `Response.tsx`'s `components` (mirror the `inlineCode` fix).
- **#159** — shiki grammars duplicated (streamdown 3.x vs `@pierre/diffs` 4.x, ~+10MB lazy). Pin one shiki via
  package.json `overrides` WITH a `@pierre/diffs` highlighting regression check.
- **Verification debt:** #80 sign-in re-check + #87/#88 git branches/PR were static-verified only — live-smoke
  when convenient.

## Next-epic roadmap (CodexMonitor parity — user picks one; grill-with-docs → ADR → tracer-bullet issues)
- **File tree + prompt library** — a file browser in the side panel. Unblocks BOTH the paused **`@` file-path
  autocomplete** (needs a main-side file-listing IPC; the agent expands `@path` itself server-side — see
  `HANDOFF.md` §6) AND a cleaner path for #168's chips.
- **Terminal dock** — node-pty embedded terminal (see `opencode` for the Electron mechanics). The design mockups
  already reserve chrome for it (a 230px dock; the shimmer/snake-spinner brand palette is in place).
- **Settings / usage meter / in-app updates / packaging** — electron-updater + electron-builder (see `opencode`).
  The Settings page shell already exists (#130).
- **Git/GitHub follow-ups** (ADR-0008 deferred tier) — multi-repo, a full PR/issue browser, "Ask PR",
  worktree-per-Thread isolation.
- **Composer extras — final piece** — `@` file-path autocomplete (see file-tree above); `$` skills already
  covered by `/`.

## Where the epic's decisions live (for reference / if you touch conversation/composer)
- **ADR-0010** (design-system decisions) · **ADR-0011** (draft threads / lazy binding) · **ADR-0012** (eager
  primary session at connect, reused by first prompt — the fix for empty agent-control pickers on a fresh draft).
- `docs/design-tokens.md` (exact values) · `docs/design-system-components.md` (what was lifted from
  shadcn/t3code) · `docs/streamdown-spike.md` (the Response/markdown wiring + the security posture).
