import { useEffect, useState, type JSX } from 'react'
import { ArrowLeft, FolderSearch, Sparkles } from 'lucide-react'
import type { SkillInfo } from '../../../shared/ipc'
import { Response } from '../conversation/Response'
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
 * the on-disk truth. Clicking a row opens the skill's PREVIEW (slice 2): the
 * SKILL.md body fetched over the gated `skills:read` and rendered read-only with
 * the conversation's own markdown pipeline (`Response` works outside a
 * Conversation — file chips render inert). Reveal goes through `skills:reveal`.
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
  // The skill whose preview is open (slice 2), or null = the list.
  const [openSkill, setOpenSkill] = useState<SkillInfo | null>(null)

  useEffect(() => {
    let active = true
    setSkills(null)
    setOpenSkill(null) // a Workspace switch resets to that Workspace's list
    void window.api.skillsList({ workspaceDir }).then((result) => {
      if (active) setSkills(result)
    })
    return () => {
      active = false
    }
  }, [workspaceDir])

  if (openSkill) {
    return (
      <SkillPreview
        skill={openSkill}
        workspaceDir={workspaceDir}
        onBack={() => setOpenSkill(null)}
      />
    )
  }

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
        of the same name. Click a skill to read its instructions.
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
            // The open-preview button and the Reveal button are SIBLINGS (nested
            // buttons are invalid HTML); the row's hover wash lives on the <li>.
            <li
              key={skill.name}
              className="flex items-start gap-3 rounded-[9px] border border-border p-3 transition-colors hover:bg-accent/10 focus-within:bg-accent/10"
            >
              <button
                type="button"
                onClick={() => setOpenSkill(skill)}
                aria-label={`Open /${skill.name}`}
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left outline-none"
              >
                <Sparkles className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <SkillHeading skill={skill} />
                  <span className="text-[13px] text-muted">{skill.description}</span>
                  <span className="truncate text-[11px] text-faint">{skill.path}</span>
                </span>
              </button>
              <RevealButton skill={skill} workspaceDir={workspaceDir} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One skill's read-only preview (slice 2): the SKILL.md BODY (the instructions
 * the agent receives) over the gated `skills:read`, rendered with the same
 * markdown pipeline the conversation uses. A refused/failed read degrades to a
 * hint — Reveal still works, so the file is never unreachable.
 */
function SkillPreview({
  skill,
  workspaceDir,
  onBack,
}: {
  skill: SkillInfo
  workspaceDir: string | null
  onBack: () => void
}): JSX.Element {
  // undefined = loading; null = read refused/failed; string = the body.
  const [markdown, setMarkdown] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let active = true
    setMarkdown(undefined)
    void window.api.skillsRead({ workspaceDir, path: skill.path }).then((result) => {
      if (active) setMarkdown(result.ok ? result.markdown : null)
    })
    return () => {
      active = false
    }
  }, [skill.path, workspaceDir])

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <div className="flex items-center gap-2">
        <IconButton aria-label="Back to skills" title="Back to skills" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h1 className="min-w-0 truncate text-[19px] font-semibold tracking-tight text-text-strong">
          /{skill.name}
        </h1>
        <SkillBadges skill={skill} />
        <span className="flex-1" />
        <RevealButton skill={skill} workspaceDir={workspaceDir} />
      </div>
      <p className="text-[13px] text-muted">{skill.description}</p>
      <p className="truncate text-[11px] text-faint">{skill.path}</p>

      {markdown === undefined ? (
        <div className="rounded-[9px] border border-border p-3 text-[13px] text-muted">
          Reading SKILL.md…
        </div>
      ) : markdown === null ? (
        <div className="rounded-[9px] border border-border p-3 text-[13px] text-muted">
          Couldn’t read this skill’s file — it may have moved. Reveal it to inspect on disk.
        </div>
      ) : markdown === '' ? (
        <div className="rounded-[9px] border border-border p-3 text-[13px] text-muted">
          This skill has no instructions beyond its frontmatter.
        </div>
      ) : (
        <div className="rounded-[9px] border border-border p-4">
          <Response text={markdown} />
        </div>
      )}
    </div>
  )
}

function SkillHeading({ skill }: { skill: SkillInfo }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[13px] font-semibold text-text-strong">/{skill.name}</span>
      <SkillBadges skill={skill} />
    </span>
  )
}

function SkillBadges({ skill }: { skill: SkillInfo }): JSX.Element {
  return (
    <>
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
    </>
  )
}

/** Reveal SKILL.md in the OS file manager — stops propagation so a click inside
 * a list row reveals WITHOUT opening the preview. */
function RevealButton({
  skill,
  workspaceDir,
}: {
  skill: SkillInfo
  workspaceDir: string | null
}): JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      title="Reveal SKILL.md in the file manager"
      onClick={(event) => {
        event.stopPropagation()
        void window.api.skillsReveal({ workspaceDir, path: skill.path })
      }}
    >
      <FolderSearch className="size-3.5" aria-hidden />
      Reveal
    </Button>
  )
}
