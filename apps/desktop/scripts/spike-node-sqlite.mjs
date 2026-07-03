// Spike for #293: prove `node:sqlite` fits the SQLite persistence epic (#292).
//
// Runs identically in the two runtimes that matter:
//   dev-machine Node (vitest)  : node scripts/spike-node-sqlite.mjs
//   Electron main              : electron scripts/spike-node-sqlite.mjs
//
// Checks: WAL journal mode, foreign-key enforcement, user_version pragma,
// FTS5 (MATCH + snippet + bm25), and a perf smoke (50k inserts / full read /
// FTS query). Prints a JSON report and exits non-zero on any failure.

import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const report = {
  runtime: process.versions.electron ? `electron ${process.versions.electron}` : 'node',
  node: process.versions.node,
  checks: {},
  perf: {},
}
let failed = false

function check(name, fn) {
  try {
    const value = fn()
    report.checks[name] = value === undefined ? 'ok' : value
  } catch (err) {
    report.checks[name] = `FAIL: ${err.message}`
    failed = true
  }
}

const dir = mkdtempSync(join(tmpdir(), 'spike-node-sqlite-'))
const db = new DatabaseSync(join(dir, 'spike.sqlite'))

check('wal', () => {
  const mode = db.prepare('PRAGMA journal_mode = WAL').get()
  if (String(Object.values(mode)[0]).toLowerCase() !== 'wal') throw new Error(`got ${JSON.stringify(mode)}`)
})

check('user_version', () => {
  db.exec('PRAGMA user_version = 7')
  const row = db.prepare('PRAGMA user_version').get()
  if (Number(Object.values(row)[0]) !== 7) throw new Error(`got ${JSON.stringify(row)}`)
})

check('foreign_keys_enforced', () => {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY);
           CREATE TABLE entries (seq INTEGER PRIMARY KEY AUTOINCREMENT,
             thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
             payload TEXT NOT NULL)`)
  let threw = false
  try {
    db.prepare('INSERT INTO entries (thread_id, payload) VALUES (?, ?)').run('missing', '{}')
  } catch {
    threw = true
  }
  if (!threw) throw new Error('orphan insert was allowed')
  db.prepare('INSERT INTO threads (id) VALUES (?)').run('t1')
  db.prepare('INSERT INTO entries (thread_id, payload) VALUES (?, ?)').run('t1', '{}')
  db.prepare('DELETE FROM threads WHERE id = ?').run('t1')
  const left = db.prepare('SELECT COUNT(*) AS n FROM entries').get()
  if (left.n !== 0) throw new Error('cascade delete left rows')
})

check('fts5_match_snippet_bm25', () => {
  db.exec(`CREATE TABLE prose_items (item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL);
           CREATE VIRTUAL TABLE prose_fts USING fts5(
             text, content='prose_items', content_rowid='rowid',
             tokenize='unicode61 remove_diacritics 2');
           CREATE TRIGGER prose_ai AFTER INSERT ON prose_items BEGIN
             INSERT INTO prose_fts (rowid, text) VALUES (new.rowid, new.text);
           END`)
  const ins = db.prepare('INSERT INTO prose_items (item_id, thread_id, text) VALUES (?, ?, ?)')
  ins.run('i1', 't1', 'the warm agent pool evicts the least recently active workspace')
  ins.run('i2', 't1', 'résumé of the sesión with diacritics folded')
  const hit = db
    .prepare(`SELECT p.item_id, snippet(prose_fts, 0, '[', ']', '…', 8) AS snip, bm25(prose_fts) AS rank
              FROM prose_fts JOIN prose_items p ON p.rowid = prose_fts.rowid
              WHERE prose_fts MATCH ? ORDER BY rank`)
    .get('agent pool')
  if (hit?.item_id !== 'i1' || !hit.snip.includes('[agent]')) throw new Error(JSON.stringify(hit))
  const folded = db
    .prepare('SELECT COUNT(*) AS n FROM prose_fts WHERE prose_fts MATCH ?')
    .get('resume sesion')
  if (folded.n !== 1) throw new Error('diacritic folding failed')
  return hit.snip
})

check('perf_smoke', () => {
  const N = 50_000
  const payload = JSON.stringify({ t: 'acp-event', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(200) } } })
  db.prepare('INSERT INTO threads (id) VALUES (?)').run('perf')
  const ins = db.prepare('INSERT INTO entries (thread_id, payload) VALUES (?, ?)')
  let t0 = performance.now()
  db.exec('BEGIN')
  for (let i = 0; i < N; i++) ins.run('perf', payload)
  db.exec('COMMIT')
  report.perf.insert50kMs = Math.round(performance.now() - t0)
  t0 = performance.now()
  const rows = db.prepare('SELECT seq, payload FROM entries WHERE thread_id = ? ORDER BY seq').all('perf')
  report.perf.readAllMs = Math.round(performance.now() - t0)
  if (rows.length !== N) throw new Error(`read ${rows.length}`)
  t0 = performance.now()
  ins.run('perf', payload) // single un-batched append, the live-turn shape
  report.perf.singleInsertMs = +(performance.now() - t0).toFixed(3)
  t0 = performance.now()
  db.prepare('SELECT COUNT(*) AS n FROM prose_fts WHERE prose_fts MATCH ?').get('workspace')
  report.perf.ftsQueryMs = +(performance.now() - t0).toFixed(3)
})

db.close()
rmSync(dir, { recursive: true, force: true })

console.log(JSON.stringify(report, null, 2))
console.log(failed ? 'SPIKE: FAIL' : 'SPIKE: PASS')

if (process.versions.electron) {
  const { app } = await import('electron')
  app.whenReady().then(() => app.exit(failed ? 1 : 0))
} else {
  process.exit(failed ? 1 : 0)
}
