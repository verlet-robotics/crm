// Aggregate .state/unmatched.jsonl + surface candidate allowlist entries.
//
// Discovery scripts log every unmatched (or unresolvable) affiliation via
// logUnmatched() in match-institution.ts. This script reads the JSONL,
// normalizes affiliation strings, counts occurrences across sources, and
// prints the top candidates — these are the institutions we keep encountering
// but haven't added to INSTITUTION_ALLOWLIST yet.
//
// Run with: yarn nx run twenty-outreach-research:report:unmatched
// Or:       tsx src/discover/report-unmatched.ts [--top 30]
//
// The output is human-actionable: copy a line, drop it into sources.ts as a
// new Institution entry, and the next discovery run will pick it up.
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';

import { UNMATCHED_LOG_PATH } from './match-institution.js';

type LogEntry = {
  affiliation: string;
  source: string;
  authorName?: string;
  paperUrl?: string;
  ts: string;
};

const STOPWORDS = [
  'department of',
  'department',
  'dept of',
  'dept.',
  'school of',
  'school',
  'institute of',
  'institute',
  'laboratory',
  'lab',
  'group',
  'center for',
  'centre for',
  'center',
  'centre',
  'faculty of',
  'faculty',
  'division of',
  'division',
];

const TLD_STRIPS = ['.edu', '.ac.uk', '.ac.jp', '.ac.kr', '.edu.cn', '.com', '.org'];

// Normalize an affiliation string so multiple phrasings of the same org map
// together. Simple + idempotent — sufficient for ranking.
const normalize = (raw: string): string => {
  let s = raw.toLowerCase().trim();
  for (const sw of STOPWORDS) {
    s = s.replaceAll(sw, ' ');
  }
  // Strip URL-ish suffixes if affiliation is a domain
  for (const tld of TLD_STRIPS) {
    if (s.endsWith(tld)) s = s.slice(0, -tld.length);
  }
  s = s.replace(/[,;|·]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
};

const parseTop = (argv: string[]): number => {
  const flag = argv.find((a) => a.startsWith('--top='));
  if (flag) {
    const n = Number(flag.replace('--top=', ''));
    return Number.isFinite(n) && n > 0 ? n : 30;
  }
  return 30;
};

const readEntries = async (): Promise<LogEntry[]> => {
  if (!fs.existsSync(UNMATCHED_LOG_PATH)) {
    console.log(`[report:unmatched] no log at ${UNMATCHED_LOG_PATH} — run discovery first`);
    return [];
  }
  const entries: LogEntry[] = [];
  const stream = fs.createReadStream(UNMATCHED_LOG_PATH);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip malformed lines silently.
    }
  }
  return entries;
};

type Aggregate = {
  normalized: string;
  sample: string; // a representative raw affiliation
  count: number;
  sources: Set<string>;
  authors: Set<string>;
};

const aggregate = (entries: LogEntry[]): Aggregate[] => {
  const byKey = new Map<string, Aggregate>();
  for (const e of entries) {
    if (!e.affiliation || e.affiliation.length < 3) continue;
    const norm = normalize(e.affiliation);
    if (!norm) continue;
    const existing = byKey.get(norm);
    if (existing) {
      existing.count += 1;
      existing.sources.add(e.source);
      if (e.authorName) existing.authors.add(e.authorName);
    } else {
      byKey.set(norm, {
        normalized: norm,
        sample: e.affiliation,
        count: 1,
        sources: new Set([e.source]),
        authors: new Set(e.authorName ? [e.authorName] : []),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
};

const printReport = (rows: Aggregate[], top: number): void => {
  const truncated = rows.slice(0, top);
  console.log('');
  console.log('─'.repeat(78));
  console.log(`Top ${truncated.length} unmatched affiliations  (of ${rows.length} unique)`);
  console.log('─'.repeat(78));
  for (const r of truncated) {
    const sources = [...r.sources].join(',');
    const authorSample = [...r.authors].slice(0, 2).join(', ');
    console.log(
      `${String(r.count).padStart(4)}x  ${r.sample}\n` +
        `         sources=${sources}  authors=${authorSample}${r.authors.size > 2 ? ` (+${r.authors.size - 2} more)` : ''}`,
    );
  }
  console.log('─'.repeat(78));
  console.log('');
  console.log('To add one: edit src/discover/sources.ts → INSTITUTION_ALLOWLIST.');
  console.log('Suggested template:');
  console.log('');
  console.log(`  {`);
  console.log(`    name: '<DISPLAY NAME>',`);
  console.log(`    matchers: ['<lowercase substring 1>', '<lowercase substring 2>'],`);
  console.log(`    domain: '<org-domain.tld>',`);
  console.log(`    accountType: 'INSTITUTION', // or 'LAB' for industry research`);
  console.log(`    why: '<one-line rationale>',`);
  console.log(`  },`);
  console.log('');
};

const main = async () => {
  const top = parseTop(process.argv.slice(2));
  const entries = await readEntries();
  if (entries.length === 0) return;
  console.log(`[report:unmatched] ${entries.length} unmatched log entries total`);
  const agg = aggregate(entries);
  printReport(agg, top);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
