// Scraper-only smoke: fans out the 5 research sources for a target and dumps
// the raw ResearchInputs as JSON. No LLM cost — useful for verifying scraper
// keys and output quality before running the full pipeline.
//
// Run with:
//   tsx src/research/gather-inputs.smoke.ts --target "Yuke Zhu" \
//     --affiliation "UT Austin" --lab https://rpl.cs.utexas.edu/ --twitter yukez
import { gatherInputs, type TargetSpec } from './gather-inputs.js';

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
  const spec = parseArgs(process.argv.slice(2));
  if (!spec) {
    console.error(
      'Usage: tsx src/research/gather-inputs.smoke.ts --target "Name" --affiliation "Org" [--lab URL] [--twitter handle] [--company Name] [--domain example.com]',
    );
    process.exit(2);
  }
  const t0 = Date.now();
  const inputs = await gatherInputs(spec);
  console.log(`[smoke] gathered in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log(JSON.stringify(inputs, null, 2));
};

main().catch((err) => {
  console.error('[smoke] FAILED');
  console.error(err);
  process.exit(1);
});
