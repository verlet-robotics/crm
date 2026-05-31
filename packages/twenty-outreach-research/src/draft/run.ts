// End-to-end driver: scrape → brief → hook → drafts → self-critique → judge.
//
// Live target:
//   tsx src/draft/run.ts --target "Yuke Zhu" --affiliation "UT Austin" \
//     --lab https://rpl.cs.utexas.edu/ --twitter yukez --role professor
//
// Without args, runs over the bundled fixture (no network calls).
import { synthesizeBrief } from '../research/synthesize-brief.js';
import type { ResearchInputs } from '../research/synthesize-brief.js';
import { gatherInputs, type TargetSpec } from '../research/gather-inputs.js';
import { selectBestHook, writeTwoVariants } from './write-draft.js';
import { selfCritique } from './self-critique.js';
import { judgeDraft } from './independent-judge.js';
import type { EmailDraft } from './draft-schema.js';
import { printRouterConfig } from '../lib/llm-router.js';

export const runDraftPipeline = async (
  inputs: ResearchInputs,
): Promise<{
  brief: Awaited<ReturnType<typeof synthesizeBrief>>;
  shortFinal: EmailDraft;
  longFinal: EmailDraft;
  judgeShort: Awaited<ReturnType<typeof judgeDraft>>;
  judgeLong: Awaited<ReturnType<typeof judgeDraft>>;
}> => {
  console.log('[pipe] L2 synthesizing brief…');
  const brief = await synthesizeBrief(inputs);
  console.log(`[pipe] brief: ${brief.oneLineSummary}`);

  const hook = selectBestHook(brief);
  console.log(`[pipe] best hook (spec=${hook.specificity}): ${hook.claim}`);

  console.log('[pipe] L3 writing two variants…');
  const drafts = await writeTwoVariants(brief, hook);

  console.log('[pipe] L3 self-critique…');
  const critique = await selfCritique(brief, hook, drafts);

  const shortFinal = critique.shortRewrite ?? drafts.shortVariant;
  const longFinal = critique.longRewrite ?? drafts.longVariant;
  console.log(
    `[pipe] critique scores: short=${critique.shortScore.total}/25 (rewrite=${critique.shortScore.rewriteNeeded}) ` +
      `long=${critique.longScore.total}/25 (rewrite=${critique.longScore.rewriteNeeded})`,
  );

  console.log('[pipe] independent judge scoring…');
  const [judgeShort, judgeLong] = await Promise.all([
    judgeDraft(brief, hook, shortFinal),
    judgeDraft(brief, hook, longFinal),
  ]);
  console.log(`[pipe] judge: short=${judgeShort.total}/25  long=${judgeLong.total}/25`);

  return { brief, shortFinal, longFinal, judgeShort, judgeLong };
};

// Default smoke runner uses the same fixture as synthesize-brief.ts
const utAustinFixture: ResearchInputs = {
  target: {
    name: 'Yuke Zhu',
    affiliation: 'UT Austin · Department of Computer Science · Texas Robotics',
    role: 'professor',
    homepageUrl: 'https://www.cs.utexas.edu/~yukez/',
    twitterHandle: 'yukez',
  },
  papers: [
    {
      title: 'RoboCasa: Large-Scale Simulation of Everyday Tasks for Generalist Robots',
      year: 2024,
      venue: 'RSS',
      abstract:
        'Introduces a large-scale simulation environment covering 100+ household tasks across diverse kitchens.',
    },
    {
      title: 'MimicGen: A Data Generation System for Scalable Robot Learning',
      year: 2023,
      venue: 'CoRL',
      abstract: 'Generates 50K+ trajectories from 200 source human demos via pose transformation.',
    },
    {
      title: 'OKAMI: Teaching Humanoid Robots Manipulation Skills through Single-Video Imitation',
      year: 2024,
      venue: 'CoRL',
      abstract: 'Skill transfer to humanoids from a single egocentric human video.',
    },
  ],
  news: [
    {
      title: 'Yuke Zhu named to MIT Tech Review Innovators Under 35',
      date: '2025-09-12',
      source: 'MIT Technology Review',
      summary: 'For work scaling robot manipulation through simulation + automated data generation.',
    },
  ],
  social: [
    {
      date: '2026-04-02',
      text: 'Texas Robotics has 6 new humanoid platforms arriving this summer. Looking for collaborators on bimanual manipulation data pipelines.',
    },
  ],
  labPage: {
    url: 'https://rpl.cs.utexas.edu/',
    extractedSummary:
      'Robot Perception and Learning Lab. ~15 students. Imitation learning, sim-to-real, humanoid manipulation. ALOHA, Franka Panda, two Unitree H1 humanoids (2025). NSF, ONR, TRI funded.',
  },
};

const parseArgs = (argv: string[]): TargetSpec | null => {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.set(key, next);
        i++;
      } else {
        args.set(key, 'true');
      }
    }
  }
  const name = args.get('target');
  const affiliation = args.get('affiliation');
  if (!name || !affiliation) return null;

  const roleArg = args.get('role') ?? 'professor';
  const role: TargetSpec['role'] = ['professor', 'phd', 'engineer', 'exec'].includes(roleArg)
    ? (roleArg as TargetSpec['role'])
    : 'professor';

  return {
    name,
    affiliation,
    role,
    ...(args.get('homepage') && { homepageUrl: args.get('homepage') }),
    ...(args.get('lab') && { labUrl: args.get('lab') }),
    ...(args.get('twitter') && { twitterHandle: args.get('twitter') }),
    ...(args.get('company') && { companyName: args.get('company') }),
    ...(args.get('domain') && { companyDomain: args.get('domain') }),
  };
};

const main = async () => {
  printRouterConfig();
  const argv = process.argv.slice(2);
  const liveSpec = parseArgs(argv);

  let inputs: ResearchInputs;
  if (liveSpec) {
    console.log(`[run] LIVE mode — scraping target: ${liveSpec.name} @ ${liveSpec.affiliation}`);
    inputs = await gatherInputs(liveSpec);
  } else {
    console.log('[run] FIXTURE mode — no --target arg, using bundled UT Austin fixture');
    inputs = utAustinFixture;
  }

  const result = await runDraftPipeline(inputs);
  console.log('\n=== BRIEF ===\n');
  console.log(JSON.stringify(result.brief, null, 2));
  console.log('\n=== SHORT VARIANT ===\n');
  console.log(`Subject: ${result.shortFinal.subject}`);
  console.log(`Signer: ${result.shortFinal.signerName}\n`);
  console.log(result.shortFinal.body);
  console.log(`\n[words=${result.shortFinal.wordCount}, judge=${result.judgeShort.total}/25]`);
  console.log(`  judge notes: ${result.judgeShort.notes}`);
  console.log('\n=== LONG VARIANT ===\n');
  console.log(`Subject: ${result.longFinal.subject}`);
  console.log(`Signer: ${result.longFinal.signerName}\n`);
  console.log(result.longFinal.body);
  console.log(`\n[words=${result.longFinal.wordCount}, judge=${result.judgeLong.total}/25]`);
  console.log(`  judge notes: ${result.judgeLong.notes}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[pipe] FAILED');
    console.error(err);
    process.exit(1);
  });
}
