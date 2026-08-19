/**
 * PROTOTYPE (#422) — throwaway. Stub data only; nothing here talks to main.
 *
 * Deliberately awkward on purpose: long names, a Bot with no messages yet, two
 * Bots in the SAME project, and one whose project name is long enough to fight
 * for space. A prototype fed tidy data flatters every layout equally.
 */

export interface ProtoBot {
  id: string
  name: string
  colour: string
  description: string
  project: string
  lastActive: string
  preview: string
  messages: number
  unread: boolean
}

export const PROTO_BOTS: ProtoBot[] = [
  {
    id: 'b1',
    name: 'Rex',
    colour: '#e8734a',
    description: 'Reviews my diffs before I open a PR',
    project: 'vibe-mistro',
    lastActive: '4m',
    preview: "The set_config_option change looks right, but the legacy fallback still isn't validated —",
    messages: 412,
    unread: true,
  },
  {
    id: 'b2',
    name: 'Scribe',
    colour: '#5b8def',
    description: 'Keeps the ADRs and CONTEXT.md honest',
    project: 'vibe-mistro',
    lastActive: '2h',
    preview: 'Drafted the amendment for ADR-0007. The scope claim needed rewording per axis, not one blanket',
    messages: 87,
    unread: false,
  },
  {
    id: 'b3',
    name: 'Patent Librarian',
    colour: '#3fa87a',
    description: 'Prior-art sweeps and claim-chart legwork',
    project: 'flowleap-patent-cli',
    lastActive: '3d',
    preview: 'Six candidates from the EPO sweep, two look like real 102 risks. Charted the closest one',
    messages: 1204,
    unread: false,
  },
  {
    id: 'b4',
    name: 'Mise',
    colour: '#b06ccc',
    description: 'Tidies dependencies and dead config',
    project: 'rakazo',
    lastActive: 'just now',
    preview: '',
    messages: 0,
    unread: false,
  },
]

/** One Bot's conversation tail — enough to judge density, not to read. */
export const PROTO_TURNS: { role: 'user' | 'bot'; text: string }[] = [
  {
    role: 'user',
    text: 'Have another look at the legacy fallback path in agent-controls.ts — I think the cast is unsafe.',
  },
  {
    role: 'bot',
    text: "It is. `typeof [] === 'object'`, so `modes: []` walks straight through the guard and `missingControlAxes` reports nothing missing. The renderer then calls `.availableModes.map()` on undefined. The tripwire stays silent for exactly the drift class it exists to catch.",
  },
  { role: 'user', text: 'Write it up as a review comment.' },
  {
    role: 'bot',
    text: 'Posted. I framed it as one blocking fix plus two smaller notes, and pointed at the missing test case rather than the symptom.',
  },
]

/**
 * The scale case (#442 q4). Four Bots flatter every layout; the sidebar's real
 * question is what twenty look like next to Projects in ONE scroll region.
 */
export function manyBots(n = 20): ProtoBot[] {
  const names = [
    'Rex', 'Scribe', 'Patent Librarian', 'Mise', 'Ledger', 'Sweep', 'Tilde', 'Pilot',
    'Cartographer', 'Nit', 'Warden', 'Echo', 'Drift', 'Beacon', 'Quill', 'Forge',
    'Lantern', 'Ferry', 'Marginalia', 'Kiln',
  ]
  const colours = ['#e8734a', '#5b8def', '#3fa87a', '#b06ccc', '#d9a441', '#4aa8b8']
  const projects = ['vibe-mistro', 'rakazo', 'flowleap-patent-cli', 'vibe-mistro']
  return Array.from({ length: n }, (_, i) => ({
    id: `many-${i}`,
    name: names[i % names.length],
    colour: colours[i % colours.length],
    description: 'A teammate',
    project: projects[i % projects.length],
    lastActive: `${i + 1}h`,
    preview: '…',
    messages: (i + 1) * 37,
    unread: i % 7 === 0,
  }))
}
