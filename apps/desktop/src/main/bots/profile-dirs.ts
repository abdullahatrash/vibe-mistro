import { join } from 'node:path'

/**
 * Where a Bot's two generated files live (#445, ADR-0027). Pure — env and home
 * are injected, exactly like `skill-dirs.ts`.
 *
 * Verified at vibe-acp 2.24.1 (`docs/acp-capture.md` §14.3): the USER agents dir
 * is `$VIBE_HOME/agents` (default `~/.vibe/agents`) and custom system prompts
 * live in `$VIBE_HOME/prompts`. **Vibe creates NEITHER** — both were absent
 * before the probe and a full `initialize` -> `session/new` -> exit left them
 * absent — so the writer must `mkdir -p` them itself.
 *
 * Project-scoped `<workspace>/.vibe/agents/` also works, but only in a TRUSTED
 * workspace, which makes it a silent persona-stripper in an untrusted one; that
 * is why ADR-0027 puts Bots in the user dirs and not in the user's repo.
 */

export interface VibeProfileDirs {
  /** `$VIBE_HOME/agents` — the profile TOMLs. */
  agentsDir: string
  /** `$VIBE_HOME/prompts` — the custom system-prompt `.md` files. */
  promptsDir: string
}

/** Resolve the two dirs from the resolved shell env + the user's home directory. */
export function vibeProfileDirs(env: NodeJS.ProcessEnv, home: string): VibeProfileDirs {
  const vibeHome = env.VIBE_HOME || join(home, '.vibe')
  return { agentsDir: join(vibeHome, 'agents'), promptsDir: join(vibeHome, 'prompts') }
}
