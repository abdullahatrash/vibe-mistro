# Vibe Mistro

Vibe Mistro is a desktop app for running and orchestrating [Mistral Vibe](https://docs.mistral.ai/vibe/code/cli/install-setup) coding agents across your local projects. It drives Vibe's Agent Client Protocol (ACP) server, `vibe-acp`, and gives you a full GUI on top of it: parallel workspaces, persistent conversation threads, streamed tool calls and diffs, approval controls, and a set of side surfaces (git, terminal, files, skills) so you rarely have to leave the app.

## Features

- **Workspaces & threads** — open any local project, run one warm agent per workspace, and keep many named conversation threads per project. Threads persist across restarts and resume where you left off.
- **Live conversation view** — streamed reasoning, tool calls, edit diffs, and rich markdown rendering, with search (⌘K) across thread titles and transcripts and jump-to-message.
- **Agent controls** — per-thread approval mode (default / plan / accept-edits / auto-approve / chat), model picker, and reasoning effort, all sticky per thread.
- **Permission requests** — when the agent wants to do something sensitive mid-turn, you approve or deny it inline.
- **Composer** — `/` slash-command autocomplete, image attachments, long-paste chips, and a follow-up queue with interrupt (Stop) support.
- **Git panel** — working-tree status, diffs, staging, commits, branch management, revert, and GitHub pull-request surfacing.
- **Terminal dock** — a multi-tab shell running in your workspace (⌘J).
- **Files & skills browsers** — browse workspace files with previews, and inspect the agent skills available to Vibe (with in-app SKILL.md preview).
- **Open in IDE** — jump from the app straight into your editor.
- **Settings** — environment detection plus an update check for the Vibe CLI.

Authentication is delegated entirely to Vibe: sign-in opens Mistral's browser flow, and no credentials are ever stored by the app.

## Installation

> [!WARNING]
> Vibe Mistro requires the Mistral Vibe CLI.
> Install and authenticate it before use:
>
> - Install the [Mistral Vibe CLI](https://docs.mistral.ai/vibe/code/cli/install-setup) so that `vibe` and `vibe-acp` are on your `PATH`
> - Sign in — either from the CLI, or later from inside the app (it opens the browser sign-in flow for you)

### Run from source

There are no packaged releases yet — run it from source with [Bun](https://bun.sh):

```bash
git clone https://github.com/abdullahatrash/vibe-mistro.git
cd vibe-mistro
bun install
bun run dev
```

## Some notes

This is a beta. Expect rough edges.

There is no public docs site yet — see the markdown files in [docs](./docs).

## Documentation

- [Docs index](./docs/README.md)
- [Architecture decisions (ADRs)](./docs/adr)
- [Domain glossary](./CONTEXT.md)
- [Conventions](./docs/conventions.md)

## Contributing

```bash
bun install
bun run dev         # launch Electron + Vite dev server
bun run typecheck   # type-check main + renderer
bun run lint        # eslint
bun run test        # vitest
bun run build       # production build
```

Before opening a PR, make sure all four gates pass:

```bash
bun run lint && bun run typecheck && bun run build && bun run test
```

## License

[MIT](./LICENSE)
