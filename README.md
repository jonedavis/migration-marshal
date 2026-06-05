# migration-marshal

Catches Postgres migrations that lock production tables before they ship. It flags the lock and
downtime risk, explains it in plain language, and rewrites the migration for a zero-downtime deploy.

It catches the operations that take a blocking lock on a busy table:

- Adding a column with a volatile `DEFAULT` (e.g. `gen_random_uuid()`), which rewrites the whole table
- `CREATE INDEX` without `CONCURRENTLY`, which blocks writes for the entire build
- `SET NOT NULL` on an existing column, a full table scan under lock
- `ADD CONSTRAINT` (CHECK or FK) without `NOT VALID`, which scans every row under lock

## The problem

Most `ALTER TABLE` operations take an ACCESS EXCLUSIVE lock. On a busy table a harmless-looking
change (a column, an index, a NOT NULL) can queue behind a running query, stall everything behind
it, and take production down. It passed in staging; it fails at scale.

This is not hypothetical. The same failure mode, in public write-ups:

- **GoCardless** took 15 seconds of payments-API downtime from a routine foreign-key migration.
  The `ALTER TABLE` ran fast; it took an `AccessExclusive` lock that queued behind one
  long-running read, and every API query stacked up behind that.
  [Zero-downtime Postgres migrations: the hard parts](https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/)
- **Xata** traces the cascade: a DDL statement waiting on `ACCESS EXCLUSIVE` forces every
  following query, even plain `SELECT`s, into a queue behind it.
  [Schema changes and the Postgres lock queue](https://xata.io/blog/migrations-and-exclusive-locks)
- **pganalyze** shows, from their monitoring data, that even an `ADD COLUMN` needs that
  exclusive lock for a moment, which is enough to stall reads on a busy table.
  [Finding the root cause of locking problems in Postgres](https://pganalyze.com/blog/5mins-postgres-find-cause-locking-problems)

migration-marshal catches these at authoring time, before they reach CI or production.

## Who it's for

Backend and platform engineers shipping Postgres schema changes (Prisma, raw SQL, or any tool
that produces a `.sql` migration) who want the dangerous patterns caught at authoring time, not
in a postmortem.

They live by one rule: a schema change must never take a lock that blocks production traffic.
migration-marshal encodes that rule and checks every migration against it.

## What's in it

| Component | Type | When it runs |
|-----------|------|--------------|
| `safe-migrations` | Skill | Inline, while authoring or reviewing a migration |
| `migration-reviewer` | Agent | On demand, read-only, returns Risk / Why / Rewrite |
| PreToolUse hook | Hook | Automatically, before any unsafe migration write, blocks it so Claude self-corrects |

The hook is a fast local string-check, scoped to the highest-risk patterns, and needs nothing else
to run.

## Install

You only need the files, no database and no external tools. Get them either way, then `cd` in.

Clone it:

```bash
git clone https://github.com/jonedavis/migration-marshal.git migration-marshal
cd migration-marshal
```

Or download the ZIP from GitHub (the green **Code** button, then **Download ZIP**), unzip it, and
`cd migration-marshal`.

**Load it:**

```bash
claude --plugin-dir .
```

The `safe-migrations` skill, the `migration-reviewer` agent, and the PreToolUse hook are active for
that session, with no network and nothing else to install.

## Try it

**Review a migration:**

> Use migration-reviewer on examples/unsafe/20260601120000_add_tracking_id/migration.sql

Returns Risk, Why, Rewrite. Compare with `examples/safe/`.

**Watch the gate:**

> I'm demoing the migration-marshal hook and want to watch it block a bad write. Do not review or rewrite this, the hook is the safety net. Write it exactly as given to prisma/migrations/add_tracking/migration.sql: ALTER TABLE orders ADD COLUMN tracking_id UUID NOT NULL DEFAULT gen_random_uuid();

The hook blocks the write before it reaches disk and returns the reason. Then:

> make it zero-downtime

and it rewrites to the safe version. (The `safe-migrations` skill may make Claude reluctant to write the unsafe version at all, which is the skill working upstream of the hook. The prompt above frames the write as a hook demo so Claude attempts it and you see the gate fire.)

## How it works

The agent reasons over the migration using the skill's rules and recipes. The hook scans the
proposed SQL one statement at a time for the dangerous patterns and denies with a reason, so
Claude self-corrects. Unlike a post-edit reminder, the hook denies the write before the unsafe
SQL ever reaches disk; for migrations the cost of a bad write is an outage, so the gate blocks
rather than nudges. It is a string check, not a parser.

Why a plugin and not a linter? A linter checks a migration after you have written it to a file, and
it only rejects. This plugin shifts the same knowledge to authoring time: it makes safe the default,
blocks the unsafe write before it reaches disk, and rewrites it for you. Same rules, caught earlier,
with a fix instead of a rejection.

## Deploying on a team

A plugin outlives the person who wrote it: one engineer's hard-won migration judgment becomes a
tool the whole team runs the same way every time. Commit it to your plugin repo and run it through
normal review; permissions live in the consuming repo and your org's managed settings, not the plugin.

## Build your own

This repo doubles as a worked example, the smallest plugin that does something real: a skill, an
agent, and a hook wired together. Clone it, swap the migration rules for your own domain, and you
have a starting point. The canonical repo is
[github.com/jonedavis/migration-marshal](https://github.com/jonedavis/migration-marshal), and for a
step-by-step walkthrough of building one from scratch, see the guide at
[migration-marshal.vercel.app](https://migration-marshal.vercel.app).

## What I'd do with more time

- Optional read-only DB introspection so the reviewer uses real table sizes, turning a "risky if
  large" verdict into a definite one.
- Wider rules: column type changes, enum changes, partitioned tables.
- Surface the hook's denials as PR comments on the offending migration.

## Limitations

Static analysis only. It never connects to your database, which keeps setup small. The hook is a
fast string check, not a parser: a focused tripwire scoped to the highest-risk patterns, not exhaustive coverage.

## License

MIT. See [LICENSE](LICENSE).
