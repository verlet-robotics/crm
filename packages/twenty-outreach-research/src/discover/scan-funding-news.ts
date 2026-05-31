// Stage 1 scanner — funding news.
//
// Exa neural search for robotics startup funding announcements in the last
// N days. Uses the LLM extractor role to pull (company name, round, amount,
// date, headline) out of the news titles + highlights. Filters out companies
// already known by string-matching against ICP_COMPANIES + the GitHub scan
// cache (best-effort dedup).
//
// Cheap: 4-6 Exa neural searches + one LLM extractor call per scan.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateObject } from 'ai';
import { z } from 'zod';

import { modelForRole } from '../lib/llm-router.js';
import { searchNews } from '../research/scrapers/exa.js';

import { ICP_COMPANIES } from './sources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, '../../.state');

const QUERIES = [
  'humanoid robotics startup funding announcement',
  'robot manipulation startup Series A Series B',
  'embodied AI startup raised funding',
  'physical AI robotics company Series funding',
  'robotics foundation model startup raise',
  'VLA robot policy startup funding',
];

const fundingExtractSchema = z.object({
  companies: z
    .array(
      z.object({
        name: z.string(),
        round: z.string().optional(),
        amount: z.string().optional(),
        url: z.string().optional(),
        headline: z.string().optional(),
        thesis: z.string().optional(),
      }),
    )
    .describe(
      'Robotics / manipulation / humanoid / embodied-AI companies mentioned as having raised funding. Skip anything that is pure AV, drone, automation-as-a-service, or non-robotics SaaS.',
    ),
});

type RawNewsHit = { title: string; url: string; date: string; summary: string };

const knownByName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return ICP_COMPANIES.some(
    (c) => c.name.toLowerCase() === lower || lower.includes(c.name.toLowerCase()),
  );
};

export type FundingNewsHit = {
  name: string;
  round?: string;
  amount?: string;
  url?: string;
  headline?: string;
  thesis?: string;
  noticedAt: string;
};

export const scanFundingNews = async (
  opts: { lookbackDays?: number } = {},
): Promise<FundingNewsHit[]> => {
  const lookback = opts.lookbackDays ?? 60;
  console.log(`[stage1:scan-funding] lookback=${lookback}d, ${QUERIES.length} queries`);

  const raw: RawNewsHit[] = [];
  for (const q of QUERIES) {
    try {
      const results = await searchNews(q, '', lookback);
      raw.push(
        ...results.map((r) => ({ title: r.title, url: r.url, date: r.date, summary: r.summary })),
      );
    } catch (err) {
      console.warn(`[stage1:scan-funding] query "${q}" failed:`, err instanceof Error ? err.message : err);
    }
  }
  // Dedup by URL.
  const byUrl = new Map<string, RawNewsHit>();
  for (const r of raw) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  const news = [...byUrl.values()];
  console.log(`[stage1:scan-funding] ${news.length} unique news items`);

  if (news.length === 0) return [];

  // Feed the corpus to the extractor for structured extraction.
  const corpus = news
    .map((n) => `[${n.date}] ${n.title}\n${n.summary}\nURL: ${n.url}`)
    .join('\n\n---\n\n');

  // synthesizer role uses Claude Sonnet by default which reliably supports
  // structured output via the AI SDK; extractor role (NIM Llama / Kimi) is
  // flaky with responseFormat schemas.
  const { model } = modelForRole('synthesizer');
  const { object } = await generateObject({
    model,
    schema: fundingExtractSchema,
    system:
      'You extract robotics startup funding announcements. For each company mentioned as having raised a round in the source material, return name + round + amount + URL + headline + a one-sentence thesis. Skip companies that are not building robots that physically manipulate objects in the world (no AV, drone, software-only AI). Be conservative — do not invent companies.',
    prompt: `Source material (recent news):\n\n${corpus}\n\nExtract robotics funding announcements.`,
  });

  const now = new Date().toISOString();
  const hits: FundingNewsHit[] = (object.companies ?? [])
    .filter((c) => c.name && !knownByName(c.name))
    .map((c) => ({
      name: c.name,
      ...(c.round && { round: c.round }),
      ...(c.amount && { amount: c.amount }),
      ...(c.url && { url: c.url }),
      ...(c.headline && { headline: c.headline }),
      ...(c.thesis && { thesis: c.thesis }),
      noticedAt: now,
    }));

  // Dedup by name (case-insensitive).
  const byName = new Map<string, FundingNewsHit>();
  for (const h of hits) {
    const k = h.name.toLowerCase().trim();
    if (!byName.has(k)) byName.set(k, h);
  }
  const out = [...byName.values()];
  console.log(`[stage1:scan-funding] ${out.length} unknown robotics companies extracted`);
  return out;
};

const main = async () => {
  const args = process.argv.slice(2);
  const lookback = Number(
    args.find((a) => a.startsWith('--lookback='))?.replace('--lookback=', '') ?? '60',
  );
  const hits = await scanFundingNews({ lookbackDays: lookback });

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = path.join(STATE_DIR, 'scan-funding-news.json');
  fs.writeFileSync(out, JSON.stringify(hits, null, 2), 'utf-8');
  console.log(`[stage1:scan-funding] wrote ${hits.length} hits → ${out}`);

  console.log('\nAll hits:');
  for (const h of hits) {
    console.log(`  ${h.name.padEnd(30)} ${h.round ?? '?'.padEnd(8)} ${h.amount ?? ''}`);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
