import { useEffect, useState, type JSX } from 'react'
import { ArrowLeft, FolderSearch, Sparkles } from 'lucide-react'
import type { SkillInfo } from '../../../shared/ipc'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'

/**
 * The Skills browser (#259): a routed outlet view (the Settings pattern) listing
 * the installed Vibe skills for the selected Workspace + global — scanned and
 * parsed by MAIN from the on-disk `SKILL.md` dirs, no agent involved, so it
 * works process-free. Scan-on-open: mounting (and switching Workspace) re-lists;
 * there is no filesystem watching (#259 out of scope). Rows carry a scope badge
 * (project shadows global, Vibe's first-name-wins) and a "not invocable" badge
 * for `user-invocable: false` skills the `/` menu would hide — the browser shows
 * the on-disk truth. Reveal goes through the gated `skills:reveal` IPC.
 */
export function SkillsView({
  workspaceDir,
  workspaceName,
  onClose,
}: {
  /** The selected Workspace's directory (project skills), or null = global only. */
  workspaceDir: string | null
  /** Display name for the project-scope hint (null when no Workspace is selected). */
  workspaceName: string | null
  onClose: () => void
}): JSX.Element {
  // null = scanning; [] = scanned, nothing installed.
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)

  useEffect(() => {
    let active = true
    setSkills(null)
    void window.api.skillsList({ workspaceDir }).then((result) => {
      if (active) setSkills(result)
    })
    return () => {
      active = false
    }
  }, [workspaceDir])

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <div className="flex items-center gap-2">
        <IconButton aria-label="Back" title="Back" onClick={onClose}>
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h1 className="text-[19px] font-semibold tracking-tight text-text-strong">Skills</h1>
      </div>
      <p className="text-[13px] text-muted">
        The agent skills installed on this machine — invoked with <code>/name</code> in the
        composer. Project skills{workspaceName ? ` (${workspaceName})` : ''} shadow global ones
        of the same name.
      </p>

      {skills === null ? (
        <div className="rounded-[9px] border border-border p-3 text-[13px] text-muted">
          Scanning skill folders…
        </div>
      ) : skills.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-[9px] border border-border p-4 text-[13px] text-muted">
          <span className="flex items-center gap-2 font-semibold text-text-strong">
            <Sparkles className="size-4" aria-hidden />
            No skills installed
          </span>
          <span>
            Create one at <code>~/.vibe/skills/&lt;name&gt;/SKILL.md</code> (global) or{' '}
            <code>.vibe/skills/&lt;name&gt;/SKILL.md</code> inside a project — a Markdown file
            with <code>name</code> and <code>description</code> frontmatter. Vibe picks it up on
            its next session (or <code>/reload</code>).
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li
              key={skill.name}
              className="flex items-start gap-3 rounded-[9px] border border-border p-3"
            >
              <Sparkles className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-text-strong">
                    /{skill.name}
                  </span>
                  <Badge
                    variant={skill.scope === 'project' ? 'accent' : 'outline'}
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                  >
                    {skill.scope === 'project' ? 'Project' : 'Global'}
                  </Badge>
                  {!skill.userInvocable && (
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] text-muted">
                      not invocable
                    </Badge>
                  )}
                </span>
                <span className="text-[13px] text-muted">{skill.description}</span>
                <span className="truncate text-[11px] text-faint">{skill.path}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                title="Reveal SKILL.md in the file manager"
                onClick={() => void window.api.skillsReveal({ workspaceDir, path: skill.path })}
              >
                <FolderSearch className="size-3.5" aria-hidden />
                Reveal
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
