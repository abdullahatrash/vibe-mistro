import type { Migration } from './sqlite-db'

/**
 * What to do with a database's schema at open (#475) — the PURE core of the
 * migration runner, so the awkward cases are settled in a unit test rather than
 * against a real file.
 *
 * WHY THIS EXISTS. Migrations used to be keyed by `PRAGMA user_version` alone —
 * an integer POSITION, not an identity. Two branches that each append a
 * migration therefore both claim the same number, and a database that ran one
 * branch's version 5 looks, to the other branch, exactly like a database that
 * ran ITS version 5. The runner skips it forever and the table is never created.
 *
 * That is not hypothetical: a profile migrated by a parked branch reached
 * `user_version = 6` with neither `bots` nor `routines`, and the app logged
 * `no such table: bots` on every launch for eight days without anyone noticing,
 * because the stores are best-effort and swallow their failures. The fail-closed
 * check did not catch it either: it refuses a NEWER version, and this one was
 * not newer, it was DIVERGENT — same number, different meaning.
 *
 * So the ledger records migrations by NAME, and every migration declares the
 * schema objects it creates, which lets the plan tell three states apart that
 * the integer could not:
 *
 * - **never applied** — no ledger row. Run it.
 * - **claimed but absent** — a ledger row (usually from the `user_version`
 *   backfill) yet NOT ONE of its objects exists. The claim is false; run it and
 *   say so out loud. This is the divergent-branch case, and it self-heals.
 * - **claimed and partial** — some objects exist and some do not. That is not a
 *   version mix-up, it is a damaged schema, and re-running `up` would fail on the
 *   half that IS there. Refuse, and let the caller lock the database rather than
 *   write into it.
 */

/** A migration whose ledger row is a lie, with what makes it one. */
export interface MigrationDiscrepancy {
  name: string
  /** Objects the migration declares but that `sqlite_master` does not have. */
  missing: readonly string[]
}

export interface MigrationPlan {
  /**
   * Everything to run, in `id` order — never-applied and falsely-claimed alike,
   * so a repaired early migration still precedes a later one that references it.
   */
  run: readonly Migration[]
  /** Names to record as applied WITHOUT running: the `user_version` backfill. */
  backfill: readonly string[]
  /** The falsely-claimed subset of {@link run} — worth logging, never silent. */
  repaired: readonly MigrationDiscrepancy[]
  /** Damaged schemas. Non-empty means: do not migrate, do not write. */
  inconsistent: readonly MigrationDiscrepancy[]
}

export function planMigrations(args: {
  migrations: readonly Migration[]
  /** Names in the `schema_migrations` ledger. */
  applied: ReadonlySet<string>
  /** True when the ledger table is new/empty, so `user_version` is all we have. */
  ledgerEmpty: boolean
  userVersion: number
  /** Every name in `sqlite_master` — tables, indexes, triggers alike. */
  existingObjects: ReadonlySet<string>
}): MigrationPlan {
  // The ledger is authoritative once it exists. On the FIRST open after this
  // change it does not, so read `user_version` the only way it can honestly be
  // read — "the first N migrations of this list ran" — and record those names.
  // For a divergent database that reading is wrong, which is exactly what the
  // object check below is for: the backfill states the claim, the objects test it.
  const backfill = args.ledgerEmpty
    ? args.migrations.filter((m) => m.id <= args.userVersion).map((m) => m.name)
    : []
  const claimed = new Set([...args.applied, ...backfill])

  const run: Migration[] = []
  const repaired: MigrationDiscrepancy[] = []
  const inconsistent: MigrationDiscrepancy[] = []

  for (const migration of args.migrations) {
    if (!claimed.has(migration.name)) {
      run.push(migration)
      continue
    }
    const missing = migration.creates.filter((object) => !args.existingObjects.has(object))
    if (missing.length === 0) continue
    if (missing.length === migration.creates.length) {
      // Nothing it makes is there: it never ran, whatever the ledger says.
      run.push(migration)
      repaired.push({ name: migration.name, missing })
      continue
    }
    inconsistent.push({ name: migration.name, missing })
  }

  return {
    run,
    // A name that is being RUN is recorded by the runner, not by the backfill —
    // recording it twice would be harmless but claiming it before it ran is not.
    backfill: backfill.filter((name) => !run.some((m) => m.name === name)),
    repaired,
    inconsistent,
  }
}
