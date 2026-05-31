// L2 synthesizer: takes structured raw research inputs (papers, news, social,
// lab page, company signals) and produces a typed ResearchBrief.
//
// Run with: yarn nx run twenty-outreach-research:research:synth
// (the default invocation runs over a hardcoded UT Austin fixture so you can
// inspect the brief quality without wiring up scrapers yet.)
import { callJson } from '../lib/llm-router.js';
import { ResearchBriefSchema, type ResearchBrief } from './brief-schema.js';

export type ResearchInputs = {
  target: {
    name: string;
    affiliation: string;
    role: 'professor' | 'phd' | 'engineer' | 'exec';
    homepageUrl?: string;
    twitterHandle?: string;
  };
  papers: { title: string; year: number; venue?: string; abstract?: string; url?: string }[];
  news: { title: string; date: string; source: string; summary: string; url?: string }[];
  social: { date: string; text: string; url?: string }[];
  labPage?: { url: string; extractedSummary: string };
  companySignals?: {
    funding: { round: string; amount: string; date: string }[];
    hiring: { role: string; date: string; url?: string }[];
    products: { name: string; date: string; summary: string }[];
  };
};

export type BriefSubject = 'person' | 'company';

const personTask =
  `Synthesize the structured ResearchBrief. Ground every claim in one of the inputs above — never invent papers, funding, or projects. If a field has no evidence, return an empty array or "none". Rank hookCandidates by specificity desc; the top hook should name a specific paper, project, or event.`;

const companyTask =
  `Synthesize a COMPANY-level ResearchBrief — this is an organization, not an individual. targetName is the company itself. Focus on what they build, their stage/funding, hiring signals, recent launches, and the data/evaluation bottleneck a robot-learning company at their stage most likely hits. Set bestFitVerletService to the Verlet capability that best addresses THAT bottleneck, and recommendedRegister to "commercial". technicalProfile.focus should describe the company's product/research focus; knownPainPoints are org-level (data scale, eval throughput, sim-to-real). Ground every claim in the inputs above — never invent funding, products, or hires. hookCandidates should be company-level (a funding round, product launch, key hire, public roadmap), ranked by specificity desc.`;

const buildUserPrompt = (inputs: ResearchInputs, subject: BriefSubject = 'person'): string => {
  return [
    `# Target`,
    `Name: ${inputs.target.name}`,
    `Affiliation: ${inputs.target.affiliation}`,
    `Role: ${inputs.target.role}`,
    inputs.target.homepageUrl ? `Homepage: ${inputs.target.homepageUrl}` : '',
    inputs.target.twitterHandle ? `Twitter: @${inputs.target.twitterHandle}` : '',
    '',
    `# Recent papers (${inputs.papers.length})`,
    ...inputs.papers.map(
      (p, i) =>
        `${i + 1}. [${p.year}${p.venue ? ' · ' + p.venue : ''}] ${p.title}\n   ${p.abstract ?? ''}${p.url ? '\n   ' + p.url : ''}`,
    ),
    '',
    `# News / blog mentions (${inputs.news.length})`,
    ...inputs.news.map(
      (n, i) => `${i + 1}. [${n.date} · ${n.source}] ${n.title}\n   ${n.summary}${n.url ? '\n   ' + n.url : ''}`,
    ),
    '',
    `# Social posts (${inputs.social.length})`,
    ...inputs.social.map((s, i) => `${i + 1}. [${s.date}] ${s.text}${s.url ? '\n   ' + s.url : ''}`),
    '',
    inputs.labPage ? `# Lab page summary (${inputs.labPage.url})\n${inputs.labPage.extractedSummary}\n` : '',
    inputs.companySignals
      ? [
          `# Company signals`,
          `Funding: ${inputs.companySignals.funding.map((f) => `${f.round} ${f.amount} ${f.date}`).join('; ') || 'none'}`,
          `Hiring: ${inputs.companySignals.hiring.map((h) => h.role + ' (' + h.date + ')').join('; ') || 'none'}`,
          `Products: ${inputs.companySignals.products.map((p) => p.name + ' (' + p.date + ')').join('; ') || 'none'}`,
          '',
        ].join('\n')
      : '',
    `# Your task`,
    subject === 'company' ? companyTask : personTask,
  ]
    .filter(Boolean)
    .join('\n');
};

export const synthesizeBrief = async (
  inputs: ResearchInputs,
  opts: { subject?: BriefSubject } = {},
): Promise<ResearchBrief> => {
  return callJson('synthesizer', buildUserPrompt(inputs, opts.subject), ResearchBriefSchema);
};

// ── Fixture: Yuke Zhu @ UT Austin (referenced in the existing email template).
// Real-looking but hand-curated so the synthesizer's output is verifiable.
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
        'Introduces a large-scale simulation environment covering 100+ household tasks across diverse kitchens, designed to study scaling laws for generalist robot policies.',
      url: 'https://robocasa.ai',
    },
    {
      title: 'MimicGen: A Data Generation System for Scalable Robot Learning',
      year: 2023,
      venue: 'CoRL',
      abstract:
        'Automatically generates large-scale robot demonstrations by adapting a small number of human demonstrations through pose transformation, enabling 50K+ trajectories from 200 source demos.',
    },
    {
      title: 'OKAMI: Teaching Humanoid Robots Manipulation Skills through Single-Video Imitation',
      year: 2024,
      venue: 'CoRL',
      abstract:
        'Pipeline for transferring manipulation skills to humanoid robots from a single egocentric human video using object-aware retargeting.',
    },
  ],
  news: [
    {
      title: 'Yuke Zhu named to MIT Tech Review Innovators Under 35 (Robotics)',
      date: '2025-09-12',
      source: 'MIT Technology Review',
      summary: 'Recognized for work scaling robot manipulation through simulation + automated data generation.',
    },
  ],
  social: [
    {
      date: '2026-04-02',
      text: 'Excited to share that the Texas Robotics group has 6 new humanoid platforms arriving this summer. Looking for collaborators on bimanual manipulation data pipelines.',
    },
  ],
  labPage: {
    url: 'https://rpl.cs.utexas.edu/',
    extractedSummary:
      'Robot Perception and Learning Lab. ~15 students. Focus areas: imitation learning, sim-to-real, humanoid manipulation. Platforms in use: ALOHA, Franka Panda, two Unitree H1 humanoids (2025 acquisitions). Funded by NSF, ONR, Toyota Research Institute.',
  },
};

const main = async () => {
  console.log('[synth] Running synthesizer over UT Austin fixture (Yuke Zhu)…');
  const brief = await synthesizeBrief(utAustinFixture);
  console.log('[synth] Brief:\n');
  console.log(JSON.stringify(brief, null, 2));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[synth] FAILED');
    console.error(err);
    process.exit(1);
  });
}
