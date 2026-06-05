#!/usr/bin/env node
// PreToolUse gate. Blocks unsafe Postgres migrations before they reach disk,
// and hands back a reason so Claude can self-correct.
//
// Detection is a deliberate fast string check, not a parser: explainable line
// by line, zero dependencies, fast enough to run on every write. It covers the
// lock-causing patterns (volatile default, CREATE INDEX without CONCURRENTLY,
// SET NOT NULL, ADD CONSTRAINT without NOT VALID), the canonical patterns the
// standard safe-migration guides and Rails' strong_migrations flag. Scoped to the
// worst offenders by design, not exhaustive. Fails open on error.

const fs = require("node:fs");

function allow() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function looksLikeMigration(p) {
  if (!p) return false;
  const s = p.toLowerCase();
  return s.endsWith(".sql") && s.includes("migration");
}

let input;
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); }
catch { process.stderr.write("migration-marshal: bad hook input; skipping.\n"); allow(); }

const tool = input.tool_name || "";
const ti = input.tool_input || {};
const filePath = ti.file_path || ti.path || "";

let content = "";
if (tool === "Write") content = ti.content || "";
else if (tool === "Edit") content = ti.new_string || "";
else if (tool === "MultiEdit" && Array.isArray(ti.edits))
  content = ti.edits.map((e) => e.new_string || "").join("\n");

if (!looksLikeMigration(filePath) || !content.trim()) allow();

// Drop line comments before scanning. Claude often documents a safe rewrite with
// a comment like `-- was: ADD COLUMN ... DEFAULT gen_random_uuid()`, and a naive
// check would match that dangerous pattern inside the comment and block a safe one.
const sql = content
  .toLowerCase()
  .split("\n")
  .map((line) => line.split("--")[0])
  .join("\n");
const statements = sql.split(";"); // one statement at a time
const findings = new Set();

const volatileFns = ["gen_random_uuid(", "uuid_generate_v", "random(", "clock_timestamp(", "timeofday("];

for (const stmt of statements) {
  // volatile default rewrites the whole table under ACCESS EXCLUSIVE
  if (stmt.includes("add column") && stmt.includes("default") &&
      volatileFns.some((fn) => stmt.includes(fn))) {
    findings.add("ADD COLUMN with a VOLATILE default rewrites the whole table under ACCESS EXCLUSIVE.");
  }

  if (stmt.includes("create index") && !stmt.includes("concurrently")) {
    findings.add("CREATE INDEX without CONCURRENTLY blocks writes for the entire build.");
  }
  if (stmt.includes("create unique index") && !stmt.includes("concurrently")) {
    findings.add("CREATE UNIQUE INDEX without CONCURRENTLY blocks writes for the entire build.");
  }

  // safe only when a validated NOT VALID check came first (PG12+)
  if (stmt.includes("set not null") && !sql.includes("not valid")) {
    findings.add("ALTER COLUMN ... SET NOT NULL on an existing column scans the whole table under lock.");
  }

  if (stmt.includes("add constraint") && !stmt.includes("not valid") &&
      (stmt.includes("check") || stmt.includes("foreign key"))) {
    findings.add("ADD CONSTRAINT (CHECK/FK) without NOT VALID scans all rows under lock.");
  }
}

if (findings.size) {
  deny(
    "migration-marshal blocked this migration:\n\n- " + [...findings].join("\n- ") +
    "\n\nAsk the migration-reviewer agent for a zero-downtime rewrite before writing this file."
  );
}
allow();
