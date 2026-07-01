import type { WorkspaceFlags } from './Shell'

/**
 * Roll up the live status of all NON-active Workspaces (pure), for the collapsed
 * project-switcher trigger (#128). Replacing the inline multi-project list with a
 * switcher dropdown hides every non-active Workspace behind the trigger — so a
 * BACKGROUND Workspace blocked on a permission prompt (or mid-stream) would become
 * invisible until the dropdown is opened, regressing the deferred TB2 finding. This
 * surfaces that signal ON the closed trigger: `needsAttention` if ANY non-active
 * Workspace is blocked on a permission, `streaming` if ANY has a turn in flight.
 *
 * The active Workspace is EXCLUDED — its own Thread list renders directly below the
 * switcher, so its status is already visible per-Thread; the roll-up is purely the
 * "something you're not looking at wants you" summary. Keyed by Workspace id; an
 * empty/blank map (or a null active id) yields all-false.
 */
export function backgroundAttention(
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>,
  activeWorkspaceId: string | null,
): WorkspaceFlags {
  let streaming = false
  let needsAttention = false
  for (const [id, flags] of Object.entries(workspaceFlags)) {
    if (id === activeWorkspaceId) continue
    if (flags.streaming) streaming = true
    if (flags.needsAttention) needsAttention = true
  }
  return { streaming, needsAttention }
}
