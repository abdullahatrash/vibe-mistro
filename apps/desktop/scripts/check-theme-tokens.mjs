import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import process from 'node:process'

const SOURCE_ROOT = new URL('../src/renderer/src/', import.meta.url)
const SOURCE_PATH = SOURCE_ROOT.pathname
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const REMOVED_TOKEN_NAMES = [
  'bg',
  'panel',
  'surface',
  'border-muted',
  'text',
  'text-strong',
  'text-body',
  'text-secondary',
  'placeholder',
  'faint',
  'accent-text',
  'accent-emphasis',
  'on-accent',
  'ok',
  'bad',
]
const UTILITY_PREFIXES = ['bg', 'text', 'border', 'divide', 'ring', 'from', 'via', 'to']
const REMOVED_UTILITY = new RegExp(
  `\\b(?:${UTILITY_PREFIXES.join('|')})-(?:${REMOVED_TOKEN_NAMES.join('|')})(?=$|[\\s/"'\\x60])`,
  'g',
)

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      if (!SOURCE_EXTENSIONS.has(extname(entry.name)) || entry.name.includes('.test.')) return []
      return [path]
    }),
  )
  return nested.flat()
}

const violations = []
for (const filePath of await sourceFiles(SOURCE_PATH)) {
  const lines = (await readFile(filePath, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    for (const match of line.matchAll(REMOVED_UTILITY)) {
      violations.push(`${relative(SOURCE_PATH, filePath)}:${index + 1}: ${match[0]}`)
    }
  })
}

if (violations.length > 0) {
  console.error('Removed theme utilities found; use the semantic token layer:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
}
