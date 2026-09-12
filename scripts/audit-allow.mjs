#!/usr/bin/env node
/**
 * CI security-audit gate (Phase 19 — FORENSIC-AUDIT D-5 / S-2).
 *
 * Runs `pnpm audit --prod --json` and fails (exit 1) on any advisory of
 * severity moderate/high/critical that is NOT in `.audit-allowlist.json`.
 * Allowlisted advisories are printed as "accepted" with their reason so they
 * stay visible. A brand-new high/critical advisory now breaks the build.
 *
 *   node scripts/audit-allow.mjs            # gate
 *   node scripts/audit-allow.mjs --list     # just print what audit found
 *
 * Zero dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING = new Set(['moderate', 'high', 'critical']);
const listOnly = process.argv.includes('--list');

function loadAllowlist() {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, '.audit-allowlist.json'), 'utf8'));
    return Array.isArray(raw.allow) ? raw.allow : [];
  } catch {
    return [];
  }
}

function runAudit() {
  try {
    const out = execFileSync('pnpm', ['audit', '--prod', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    return out;
  } catch (e) {
    // pnpm audit exits non-zero when it finds anything — the JSON is still on stdout.
    if (e.stdout) return e.stdout.toString();
    console.error('could not run `pnpm audit`:', e.message);
    process.exit(2);
  }
}

function normalize(json) {
  // pnpm has shipped two shapes: { advisories: {id: adv} } and { vulnerabilities: {...} }.
  const advisories = json.advisories ?? json.vulnerabilities ?? {};
  const list = Array.isArray(advisories) ? advisories : Object.values(advisories);
  return list.map((a) => ({
    id:
      a.github_advisory_id ??
      (typeof a.url === 'string' ? a.url.split('/').pop() : undefined) ??
      String(a.id ?? ''),
    module: a.module_name ?? a.name ?? a.package?.name ?? 'unknown',
    severity: String(a.severity ?? 'unknown').toLowerCase(),
    title: (a.title ?? a.name ?? '').toString().slice(0, 80),
    url: a.url ?? '',
  }));
}

const allow = loadAllowlist();
const isAllowed = (adv) =>
  allow.some((e) => (e.id && e.id === adv.id) || (e.module && e.module === adv.module));

const advisories = normalize(JSON.parse(runAudit()));
const blocking = advisories.filter((a) => BLOCKING.has(a.severity));

if (listOnly) {
  for (const a of advisories)
    console.log(`${a.severity.padEnd(9)} ${a.module.padEnd(24)} ${a.id}  ${a.title}`);
  process.exit(0);
}

const accepted = blocking.filter(isAllowed);
const unexpected = blocking.filter((a) => !isAllowed(a));

if (accepted.length) {
  console.log(`\n  ${accepted.length} advisory(ies) accepted via .audit-allowlist.json:`);
  for (const a of accepted) {
    const entry = allow.find((e) => e.id === a.id || e.module === a.module);
    console.log(
      `   • ${a.severity} ${a.module} (${a.id}) — ${entry?.reason ?? 'no reason recorded'}`,
    );
  }
}

if (unexpected.length) {
  console.error(
    `\n  ✗ ${unexpected.length} NEW moderate+/high/critical advisory(ies) — not allowlisted:`,
  );
  for (const a of unexpected) {
    console.error(`   • ${a.severity} ${a.module} (${a.id})  ${a.title}\n     ${a.url}`);
  }
  console.error(
    `\n  Fix the dependency, or (if genuinely unavoidable) add an entry with a reason to .audit-allowlist.json.\n`,
  );
  process.exit(1);
}

console.log(`\n  ✓ no unexpected moderate+/high/critical advisories\n`);
process.exit(0);
