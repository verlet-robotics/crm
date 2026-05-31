// Helpers for matching free-text affiliation strings against the curated
// INSTITUTION_ALLOWLIST + creating/finding the corresponding Twenty Company.
//
// Also exports logUnmatched() so discovery scripts can record affiliations
// we encountered but didn't recognise. Aggregated by report-unmatched.ts to
// suggest new allowlist entries — makes the allowlist self-improving over
// time without us guessing what we're missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { upsertCompanyByDomain } from '../lib/twenty-client.js';

import { type Institution, INSTITUTION_ALLOWLIST } from './sources.js';

export const matchInstitution = (affiliationText: string): Institution | null => {
  if (!affiliationText) return null;
  const haystack = affiliationText.toLowerCase();
  // Longest matcher wins so 'mit csail' picks MIT, not a generic 'mit' across
  // unrelated strings.
  let best: { inst: Institution; len: number } | null = null;
  for (const inst of INSTITUTION_ALLOWLIST) {
    for (const m of inst.matchers) {
      if (haystack.includes(m.toLowerCase())) {
        if (!best || m.length > best.len) best = { inst, len: m.length };
      }
    }
  }
  return best?.inst ?? null;
};

export const ensureInstitutionCompany = async (
  inst: Institution,
): Promise<{ id: string; name: string }> => {
  return upsertCompanyByDomain({
    name: inst.name,
    domainName: inst.domain,
    accountType: inst.accountType,
  });
};

// ─── Unmatched-affiliation logging ───────────────────────────────────
//
// Append-only JSONL at .state/unmatched.jsonl. Each line:
//   { affiliation, source, context, ts }
//
// report-unmatched.ts reads + aggregates + surfaces top candidates for the
// allowlist. We deliberately log even when affiliation is empty/short — the
// report filters those out, but logging tells us how often S2 returns nothing
// (separate signal from "affiliation present but unfamiliar").

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../../.state');
const UNMATCHED_FILE = path.join(STATE_DIR, 'unmatched.jsonl');

let stateEnsured = false;
const ensureStateDir = (): void => {
  if (stateEnsured) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  stateEnsured = true;
};

export type UnmatchedSource = 'arxiv' | 'similar' | 'citations' | 'coauthor';

export const logUnmatched = (
  affiliation: string,
  source: UnmatchedSource,
  context?: { authorName?: string; paperUrl?: string },
): void => {
  try {
    ensureStateDir();
    const entry = {
      affiliation: (affiliation ?? '').trim(),
      source,
      ...(context?.authorName && { authorName: context.authorName }),
      ...(context?.paperUrl && { paperUrl: context.paperUrl }),
      ts: new Date().toISOString(),
    };
    fs.appendFileSync(UNMATCHED_FILE, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (err) {
    // Logging failures must never break discovery. Print and move on.
    console.warn(`[match-institution] logUnmatched failed:`, err);
  }
};

export const UNMATCHED_LOG_PATH = UNMATCHED_FILE;
