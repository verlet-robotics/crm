// Agentic role-finder — the fix for the leader blind spot.
//
// Title-keyword discovery (Apollo people-search, Exa LinkedIn) structurally
// misses leaders whose indexed title is empty or generic — e.g. Mistral's Head
// of Robotics, Olivier Duchenne, whose Apollo title is blank. Apollo HAD his
// email; we just never queried by name because nothing told us his name.
//
// This pass works the way a human SDR does (Clay's "Claygent" pattern):
//   1. Neural web search seeded by the standardized role list — "who is the
//      head of robotics at <company>", "<company> COO", etc. — across org-charts
//      / news / leadership pages.
//   2. A grounded LLM extractor reads the snippets and names the people, tagging
//      each with a target function + a quoted evidence sentence.
//   3. Apollo match-by-name resolves identity + email (proven to return blank-
//      title leaders that people-search drops).
//
// Output Candidates are tagged 'web' and are TRUSTED by provenance (an org-chart
// naming someone Head of X is stronger than a title keyword) — callers merge
// them past any keyword gate.
import { z } from 'zod';

import { matchPersonByName } from '../discover/apollo.js';
import { searchWeb } from '../research/scrapers/exa.js';
import { callJson } from '../lib/llm-router.js';

import { classifyRole, roleQueries, tierForRole, ALL_FUNCTIONS, type FunctionTag } from './role-taxonomy.js';
import { settled, sleep, splitName } from './shared.js';
import type { Candidate, FinderTarget, SourceTag } from './types.js';

type LeadOptions = {
  functions?: FunctionTag[];
  perQueryResults?: number;
  maxApolloMatches?: number;
};

const LeadSchema = z.object({
  leads: z.array(
    z.object({
      name: z.string().describe('Full name of the person, exactly as written.'),
      inferredRole: z.string().describe('Their role/title as the text describes it (e.g. "Head of Robotics").'),
      function: z
        .enum(['ROBOT_LEARNING', 'DATA_EVAL', 'PRODUCT', 'OPERATIONS', 'PARTNERSHIPS', 'FOUNDER', 'UNKNOWN'])
        .describe('Which target function this person owns.'),
      evidence: z.string().describe('The exact sentence from the text that names this person and ties them to the company + role.'),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

const buildPrompt = (companyName: string, snippets: { url: string; text: string }[]): string =>
  [
    `Company: ${companyName}`,
    '',
    'Below are web snippets (org-charts, news, leadership/team pages). Extract the people who are explicitly named AND tied to this company AND to one of these functions:',
    '- ROBOT_LEARNING: robotics / robot learning / manipulation / AI / ML / perception / autonomy leadership',
    '- DATA_EVAL: data, data collection, evaluation, teleoperation, annotation, ML infra',
    '- PRODUCT: product leadership',
    '- OPERATIONS: COO / operations / chief of staff',
    '- PARTNERSHIPS: partnerships / business development / procurement',
    '- FOUNDER: CEO / founder / president',
    '',
    'Rules:',
    '- Only output a person if the text EXPLICITLY names them and ties them to BOTH the company and a function. Do not infer or guess names.',
    '- Quote the exact sentence as `evidence`. If a person is named without a clear company+role tie, skip them.',
    '- Prefer leaders (Head/VP/Director/Chief/Lead/Founder). If none are named, return an empty list.',
    '',
    '--- SNIPPETS ---',
    ...snippets.map((s, i) => `[${i + 1}] ${s.url}\n${s.text}`),
  ].join('\n');

export const findRoleLeads = async (
  target: FinderTarget,
  opts: LeadOptions = {},
): Promise<Candidate[]> => {
  const functions = opts.functions ?? ALL_FUNCTIONS;
  const companyName = target.name;

  // 1. Neural web search — one "who is the {primary role} at {company}" query
  // per function (bounded cost). Dedup hits by URL.
  const seen = new Set<string>();
  const snippets: { url: string; text: string }[] = [];
  for (const fn of functions) {
    const query = roleQueries(companyName, fn)[0];
    const hits = await settled(`web-${fn}`, searchWeb(query, { numResults: opts.perQueryResults ?? 5 }));
    for (const h of hits ?? []) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      const text = h.highlights.join(' ') || h.text;
      if (text) snippets.push({ url: h.url, text: text.slice(0, 1200) });
    }
  }
  if (snippets.length === 0) {
    console.log('[stage2:contacts] lead-finder: no web snippets found');
    return [];
  }

  // 2. Grounded extraction (free extractor role).
  let extracted: z.infer<typeof LeadSchema>['leads'] = [];
  try {
    const result = await callJson('extractor', buildPrompt(companyName, snippets), LeadSchema);
    extracted = result.leads;
  } catch (err) {
    console.warn(`[stage2:contacts] lead-finder extraction failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  // Dedup by normalized name; keep the higher-confidence mention.
  const byName = new Map<string, (typeof extracted)[number]>();
  const rank = { high: 3, medium: 2, low: 1 } as const;
  for (const l of extracted) {
    const key = l.name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const prev = byName.get(key);
    if (!prev || rank[l.confidence] > rank[prev.confidence]) byName.set(key, l);
  }
  const leads = [...byName.values()];
  console.log(`[stage2:contacts] lead-finder: extracted ${leads.length} named lead(s) from ${snippets.length} snippets`);

  // 3. Apollo match-by-name → resolve identity + email (bounded for credits).
  const maxMatches = opts.maxApolloMatches ?? 12;
  const candidates: Candidate[] = [];
  for (const lead of leads.slice(0, maxMatches)) {
    const split = splitName(lead.name);
    if (!split) continue;
    const role = classifyRole(lead.inferredRole);
    const defaultTier = role.function ? tierForRole(role) : 'OTHER';
    const sources = new Set<SourceTag>(['web']);
    const rawNotes = [`Web lead (${lead.confidence}, ${lead.function}): ${lead.evidence}`.slice(0, 300)];

    const matched = await matchPersonByName(split.firstName, split.lastName, target.domain).catch(() => null);
    await sleep(250);
    if (matched) sources.add('apollo');

    candidates.push({
      firstName: matched?.firstName ?? split.firstName,
      lastName: matched?.lastName ?? split.lastName,
      // Prefer a real Apollo title, else the role the page described.
      ...((matched?.title ?? lead.inferredRole) && { title: matched?.title ?? lead.inferredRole }),
      ...(matched?.email && { email: matched.email }),
      ...(matched?.linkedinUrl && { linkedinUrl: matched.linkedinUrl }),
      ...(matched?.id && { apolloId: matched.id }),
      defaultTier,
      sources,
      rawNotes: matched
        ? [...rawNotes, `Apollo match-by-name: ${matched.email ?? 'no email'}`]
        : rawNotes,
    });
  }
  const withEmail = candidates.filter((c) => c.email).length;
  console.log(`[stage2:contacts] lead-finder: ${candidates.length} candidate(s), ${withEmail} with Apollo email`);
  return candidates;
};
