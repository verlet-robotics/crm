// Seed configuration for L1 discovery. Lists are deliberately curated.
//
// Three axes:
//   - INSTITUTION_ALLOWLIST  → academic + industry-research affiliations we accept
//                              from arXiv / S2 / citation lookups.
//   - ICP_COMPANIES          → commercial humanoid + foundation-model targets we
//                              expand via Apollo + cross-reference in GitHub.
//   - ROBOTICS_REPOS         → open-source repos whose contributor list is full
//                              of engineers at ICP_COMPANIES who don't publish.
//
// Curation principles:
//   - One row per top-level domain. Lab-level sub-orgs ride in matchers, not as
//     separate rows (otherwise we double-create Twenty Companies).
//   - Manipulation / imitation learning / humanoid / robot foundation-model
//     groups only. Pure locomotion, pure perception, pure RL theory are out.
//   - China entries use canonical .com / .ai domains where possible; their
//     local-language matchers (具身智能, 数据负责人) are intentional and
//     handled by case-insensitive substring match.
//
// Edit here to expand the discovery surface area.

export type Institution = {
  // Display name used to upsert/match Twenty Companies. Must be unique per row.
  name: string;
  // Loose strings checked case-insensitively against affiliation text. Include
  // common abbreviations + lab names. Longer matchers win in ties.
  matchers: string[];
  // Top-level public domain used for Twenty Company lookup by domainName.
  domain: string;
  accountType: 'INSTITUTION' | 'LAB';
  // Free-form one-liner so a future reader can tell why this entry is here.
  // Not used at runtime — pure documentation.
  why?: string;
  // Stage 2 academic-finder defaults — used when the Twenty Company record
  // doesn't have labPageUrl/principalInvestigator set yet. CLI flags
  // (--lab-url, --lab-pi) always override.
  defaultLabUrl?: string;
  defaultPi?: string;
};

export const INSTITUTION_ALLOWLIST: Institution[] = [
  // ─── US academic
  {
    name: 'Yale University',
    matchers: ['yale', 'apollo lab yale', 'yale apollo'],
    domain: 'yale.edu',
    accountType: 'INSTITUTION',
    why: "Verlet's origin institution — Apollo Lab is the founder lineage. NB: Yale GRAB Lab (Dollar) is hardware-oriented, NOT a policy/data buyer.",
    // defaultLabUrl + defaultPi: populate per-lab via Twenty CRM custom fields
    // (labPageUrl, principalInvestigator) or CLI --lab-url / --lab-pi flags.
  },
  {
    name: 'Johns Hopkins University',
    matchers: ['johns hopkins', 'jhu', 'lcsr', 'cirl jhu', 'gregory hager', 'axel krieger', 'star jhu'],
    domain: 'jhu.edu',
    accountType: 'INSTITUTION',
    why: 'LCSR / CIRL — surgical bimanual policy training (dVRK platform). Hager, Krieger, Kazanzides train policies on bimanual data.',
  },
  {
    name: 'Stanford University',
    matchers: ['stanford', 'iris lab', 'chelsea finn', 'jeannette bohg'],
    domain: 'stanford.edu',
    accountType: 'INSTITUTION',
    why: 'IRIS Lab (Finn), REAL Lab, Bohg manipulation — foundational manipulation/imitation research',
  },
  {
    name: 'MIT',
    matchers: ['mit ', 'massachusetts institute', 'csail', 'improbable ai', 'pulkit agrawal'],
    domain: 'mit.edu',
    accountType: 'INSTITUTION',
    why: 'CSAIL, Improbable AI Lab (Agrawal) — dexterous manipulation, RialTo, generalist humanoid control',
  },
  {
    name: 'Carnegie Mellon University',
    matchers: ['carnegie mellon', 'cmu', 'ri cmu', 'robotics institute'],
    domain: 'cmu.edu',
    accountType: 'INSTITUTION',
    why: 'Robotics Institute — Deepak Pathak, Shubham Tulsiani, Abhinav Gupta manipulation work',
  },
  {
    name: 'UT Austin',
    matchers: ['ut austin', 'utexas', 'university of texas at austin', 'rpl lab', 'robin lab'],
    domain: 'utexas.edu',
    accountType: 'INSTITUTION',
    why: 'Yuke Zhu (RPL), Roberto Martín-Martín (RoboIn) — household manipulation + foundation policies',
  },
  {
    name: 'UC Berkeley',
    matchers: ['berkeley', 'uc berkeley', 'bair', 'pieter abbeel', 'sergey levine'],
    domain: 'berkeley.edu',
    accountType: 'INSTITUTION',
    why: 'BAIR — Abbeel, Levine, Goldberg, Kanazawa. THE robot-learning hub',
  },
  {
    name: 'University of Washington',
    matchers: ['university of washington', 'uw ', 'rse lab', 'paul allen school'],
    domain: 'washington.edu',
    accountType: 'INSTITUTION',
    why: 'Dieter Fox group (also NVIDIA) — perception + manipulation, AI2 partnerships',
  },
  {
    name: 'Princeton University',
    matchers: ['princeton', 'pli princeton'],
    domain: 'princeton.edu',
    accountType: 'INSTITUTION',
    why: 'Shuran Song (now Stanford but Princeton group still active), Felix Heide, Olga Russakovsky',
  },
  {
    name: 'Columbia University',
    matchers: ['columbia university', 'shuran song'],
    domain: 'columbia.edu',
    accountType: 'INSTITUTION',
    why: 'Shuran Song current home — Diffusion Policy, UMI, manipulation foundation models',
  },
  {
    name: 'Cornell University',
    matchers: ['cornell', 'cornell tech'],
    domain: 'cornell.edu',
    accountType: 'INSTITUTION',
    why: 'Yunzhu Li (cross-appointed UIUC), Sanjiban Choudhury — imitation, contact-rich manipulation',
  },
  {
    name: 'University of Michigan',
    matchers: ['university of michigan', 'umich'],
    domain: 'umich.edu',
    accountType: 'INSTITUTION',
    why: 'Dmitry Berenson, Chad Jenkins — robot manipulation, language-grounded skills',
  },
  {
    name: 'Georgia Tech',
    matchers: ['georgia tech', 'georgia institute of technology'],
    domain: 'gatech.edu',
    accountType: 'INSTITUTION',
    why: 'Sonia Chernova, Danfei Xu (former NVIDIA) — manipulation + learning from human data',
  },
  {
    name: 'University of Pennsylvania',
    matchers: ['upenn', 'grasp lab', 'university of pennsylvania', 'amp lab', 'penn engineering'],
    domain: 'upenn.edu',
    accountType: 'INSTITUTION',
    why: 'GRASP Lab — Daniilidis, Pratik Chaudhari, Dinesh Jayaraman, Nadia Figueroa. Top-3 US manipulation',
  },
  {
    name: 'UC San Diego',
    matchers: ['ucsd', 'uc san diego', 'university of california san diego', 'xiaolong wang'],
    domain: 'ucsd.edu',
    accountType: 'INSTITUTION',
    why: 'Xiaolong Wang lab — dexterous manipulation from human video, Allegro Hand, VLA work',
  },
  {
    name: 'USC',
    matchers: ['usc ', 'university of southern california', 'clvr lab', 'icaros'],
    domain: 'usc.edu',
    accountType: 'INSTITUTION',
    why: 'Stefanos Nikolaidis (ICAROS) — PATO teleop, signal-temporal-logic imitation',
  },
  {
    name: 'Caltech',
    matchers: ['caltech', 'california institute of technology'],
    domain: 'caltech.edu',
    accountType: 'INSTITUTION',
    why: 'Yisong Yue + Aaron Ames — learning for autonomy, expanding into manipulation',
  },
  {
    name: 'NYU',
    matchers: ['nyu ', 'new york university', 'cilvr', 'grail nyu', 'lerrel pinto'],
    domain: 'nyu.edu',
    accountType: 'INSTITUTION',
    why: 'Lerrel Pinto — constructivist robot learning, open-source manipulators (DOBB-E, Stick-V2)',
  },
  {
    name: 'Northeastern University',
    matchers: ['northeastern', 'helping hands lab', 'robert platt'],
    domain: 'northeastern.edu',
    accountType: 'INSTITUTION',
    why: 'Robert Platt — grasp pose detection, clutter manipulation, mobile manipulation',
  },
  {
    name: 'Brown University',
    matchers: ['brown university', 'george konidaris', 'stefanie tellex', 'intelligent robot lab'],
    domain: 'brown.edu',
    accountType: 'INSTITUTION',
    why: 'Konidaris + Tellex — language-grounded manipulation, abstraction learning',
  },
  {
    name: 'Rice University',
    matchers: ['rice university', 'kavraki lab', 'rice robotics'],
    domain: 'rice.edu',
    accountType: 'INSTITUTION',
    why: 'Lydia Kavraki — motion planning, OMPL infrastructure used across the field',
  },
  {
    name: 'UIUC',
    matchers: ['uiuc', 'university of illinois', 'saurabh gupta'],
    domain: 'illinois.edu',
    accountType: 'INSTITUTION',
    why: 'Saurabh Gupta — robot learning from ego video, embodied perception',
  },
  {
    name: 'University of Toronto',
    matchers: ['university of toronto', 'utoronto', 'vector institute', 'florian shkurti', 'animesh garg'],
    domain: 'utoronto.edu',
    accountType: 'INSTITUTION',
    why: 'Shkurti (RVL) + Garg (PAIR) — imitation-guided RL, watch-and-do from video',
  },
  {
    name: 'Arizona State University',
    matchers: ['arizona state', 'asu ', 'heni ben amor'],
    domain: 'asu.edu',
    accountType: 'INSTITUTION',
    why: 'Heni Ben Amor — bimanual grasping, HRI, imitation learning',
  },

  // ─── Europe / UK
  {
    name: 'Oxford Robotics Institute',
    matchers: ['oxford', 'ori oxford', 'a2i lab', 'ingmar posner'],
    domain: 'ox.ac.uk',
    accountType: 'INSTITUTION',
    why: 'Ingmar Posner (A2I) — data-efficient learning from demo, bimanual occluded grasping',
  },
  {
    name: 'ETH Zurich',
    matchers: ['eth zurich', 'eth zürich', 'eidgenössische', 'rsl eth'],
    domain: 'ethz.ch',
    accountType: 'INSTITUTION',
    why: 'Robotic Systems Lab manipulation arm, Katzschmann soft robotics',
  },
  {
    name: 'Imperial College London',
    matchers: ['imperial college'],
    domain: 'imperial.ac.uk',
    accountType: 'INSTITUTION',
    why: 'Robot Learning Lab — Edward Johns; Andrew Davison SLAM',
  },
  {
    name: 'MPI for Intelligent Systems',
    matchers: ['mpi-is', 'max planck intelligent systems', 'tübingen', 'tuebingen', 'mpi stuttgart'],
    domain: 'tuebingen.mpg.de',
    accountType: 'INSTITUTION',
    why: 'Schölkopf, Georg Martius — TriFinger platform, dexterous manipulation, causal robot learning',
  },
  {
    name: 'TU Munich',
    matchers: ['tu munich', 'tum munich', 'mirmi', 'munich institute of robotics'],
    domain: 'tum.de',
    accountType: 'INSTITUTION',
    why: 'MIRMI — Europe-largest robotics institute (Haddadin moved to MBZUAI Jan 2025 but MIRMI active)',
  },
  {
    name: 'TU Berlin',
    matchers: ['tu berlin', 'technische universität berlin', 'marc toussaint', 'lis lab berlin', 'science of intelligence'],
    domain: 'tu-berlin.de',
    accountType: 'INSTITUTION',
    why: 'Marc Toussaint moved from Stuttgart 2020 (LIS Lab) + Science of Intelligence cluster. Often mistakenly tagged as "Stuttgart".',
  },
  {
    name: 'Aalto University',
    matchers: ['aalto', 'aalto robotics', 'ville kyrki'],
    domain: 'aalto.fi',
    accountType: 'INSTITUTION',
    why: 'Ville Kyrki group — imitation + RL, mobile manipulation. Largest Finnish robot-learning hub.',
  },
  {
    name: 'EPFL',
    matchers: ['epfl', 'lasa lab', 'aude billard', 'josie hughes'],
    domain: 'epfl.ch',
    accountType: 'INSTITUTION',
    why: 'Aude Billard (LASA) + Hughes (CREATE) — learning from demo, reactive control',
  },
  {
    name: 'University of Bristol BRL',
    matchers: ['bristol', 'bristol robotics lab', 'brl bristol', 'mayol-cuevas'],
    domain: 'bristol.ac.uk',
    accountType: 'INSTITUTION',
    why: 'Bristol Robotics Lab — tactile manipulation, single-demonstration coarse-to-fine imitation',
  },
  {
    name: 'University of Edinburgh',
    matchers: ['edinburgh university', 'edinburgh centre for robotics', 'sethu vijayakumar'],
    domain: 'ed.ac.uk',
    accountType: 'INSTITUTION',
    why: 'Sethu Vijayakumar — bimanual manipulation, NASA Valkyrie partnerships',
  },
  {
    name: 'TU Delft',
    matchers: ['tu delft', 'delft university', 'cognitive robotics', 'jens kober'],
    domain: 'tudelft.nl',
    accountType: 'INSTITUTION',
    why: 'Jens Kober — interactive learning, learning from demonstration',
  },
  {
    name: 'KIT Karlsruhe',
    matchers: ['karlsruhe institute', 'kit karlsruhe', 'h2t lab', 'tamim asfour'],
    domain: 'kit.edu',
    accountType: 'INSTITUTION',
    why: 'Tamim Asfour — ARMAR humanoids, grasp planning, kinesthetic teaching',
  },
  {
    name: 'IIT Genoa',
    matchers: ['istituto italiano di tecnologia', 'iit genoa', 'icub'],
    domain: 'iit.it',
    accountType: 'INSTITUTION',
    why: 'iCub humanoid platform, ergoCub industrial humanoid program',
  },

  // ─── Asia
  {
    name: 'University of Tokyo',
    matchers: ['university of tokyo', 'utokyo', 'jsk lab', 'inaba lab'],
    domain: 'u-tokyo.ac.jp',
    accountType: 'INSTITUTION',
    why: 'JSK Lab (Inaba, Okada) — humanoid manipulation, soft hands',
  },
  {
    name: 'KAIST',
    matchers: ['kaist', 'korea advanced institute', 'riro lab', 'daehyung park'],
    domain: 'kaist.ac.kr',
    accountType: 'INSTITUTION',
    why: 'Daehyung Park (RIRO) — VLA, physical AI, generalist humanoids',
  },
  {
    name: 'Seoul National University',
    matchers: ['seoul national', 'snu rllab', 'songhwai oh'],
    domain: 'snu.ac.kr',
    accountType: 'INSTITUTION',
    why: 'Songhwai Oh (RLLAB) — real-to-sim-to-real manipulation, foundation policies on humanoids',
  },
  {
    name: 'Tsinghua University',
    matchers: ['tsinghua', 'tea lab tsinghua', 'huazhe xu', 'iiis tsinghua'],
    domain: 'tsinghua.edu.cn',
    accountType: 'INSTITUTION',
    why: 'Huazhe Xu (TEA Lab) — visual RL, dexterous manipulation, cross-embodiment',
  },
  {
    name: 'Tsinghua AIR',
    matchers: ['tsinghua air', 'institute for ai industry research', 'air tsinghua'],
    domain: 'air.tsinghua.edu.cn',
    accountType: 'INSTITUTION',
    why: 'Distinct applied-AI institute separate from main Tsinghua CS — different buyer + industry-partnership budget.',
  },
  {
    name: 'Peking University',
    matchers: ['peking university', 'pku ', 'cfcs pku', 'hao dong pku'],
    domain: 'pku.edu.cn',
    accountType: 'INSTITUTION',
    why: 'Hao Dong (CFCS) — embodied AI, manipulation foundation models, Galbot scientist',
  },
  {
    name: 'Shanghai Jiao Tong University',
    matchers: ['shanghai jiao tong', 'sjtu', 'mvig sjtu', 'cewu lu'],
    domain: 'sjtu.edu.cn',
    accountType: 'INSTITUTION',
    why: 'Cewu Lu (MVIG) — AnyGrasp, embodied intelligence, household manipulation',
  },
  {
    name: 'Shanghai Qi Zhi Institute',
    matchers: ['shanghai qi zhi', 'shanghai qizhi', 'sqz shanghai'],
    domain: 'sqz.ac.cn',
    accountType: 'INSTITUTION',
    why: 'Private embodied-AI institute hosting Xu + Yi Wu + Xiaolong Wang affiliates',
  },
  {
    name: 'National University of Singapore',
    matchers: ['national university of singapore', 'nus ', 'nus arc', 'lin shao'],
    domain: 'nus.edu.sg',
    accountType: 'INSTITUTION',
    why: 'Lin Shao, Marcelo Ang (ARC) — soft manipulation, foundation policies',
  },
  {
    name: 'Nanyang Technological University',
    matchers: ['nanyang technological', 'ntu singapore', 'ntu rrc', 'mmlab ntu', 'robotics learning lab ntu'],
    domain: 'ntu.edu.sg',
    accountType: 'INSTITUTION',
    why: 'MMLab + Robotics Learning Lab — released 10M-sample egocentric dataset for embodied AI / VLA + DynamicVLA work.',
  },
  {
    name: 'Hong Kong University of Science and Technology',
    matchers: ['hkust', 'hong kong university of science', 'mevita robotics', 'mrl hkust'],
    domain: 'hkust.edu.hk',
    accountType: 'INSTITUTION',
    why: 'Mevita Robotics Lab — generalist robot learning + visuotactile dexterous; led China lunar dual-arm op robot.',
  },

  // ─── Canada
  {
    name: 'McGill University',
    matchers: ['mcgill', 'mrl mcgill', 'gregory dudek'],
    domain: 'mcgill.ca',
    accountType: 'INSTITUTION',
    why: 'Dudek (also Samsung AI Centre Montreal) — manipulation + perception',
  },

  // ─── Industry research labs (account_type LAB so they ICP differently)
  {
    name: 'NVIDIA Research',
    matchers: ['nvidia research', 'nvidia gear', 'gear lab', 'project gr00t', 'jim fan nvidia'],
    domain: 'nvidia.com',
    accountType: 'LAB',
    why: 'GEAR Lab (Fan + Zhu) — Project GR00T humanoid foundation models, Isaac GR00T N1',
  },
  {
    name: 'Google DeepMind',
    matchers: ['deepmind', 'google deepmind', 'google research robotics', 'gemini robotics', 'rt-x'],
    domain: 'deepmind.com',
    accountType: 'LAB',
    why: 'Gemini Robotics, RT-X, Open X-Embodiment — buyer of cross-embodiment data',
  },
  {
    name: 'Toyota Research Institute',
    matchers: ['toyota research', 'tri lbm', 'large behavior model', 'russ tedrake'],
    domain: 'tri.global',
    accountType: 'LAB',
    why: 'Russ Tedrake — Large Behavior Models program, dexterous manipulation',
  },
  {
    name: 'RAI Institute',
    matchers: ['rai institute', 'robotics and ai institute', 'rai-inst', 'boston dynamics ai institute', 'marc raibert'],
    domain: 'rai-inst.com',
    accountType: 'LAB',
    why: 'Marc Raibert Hyundai-funded research arm; 2025 partnership with BD on Atlas RL',
  },
  {
    name: 'Meta FAIR',
    matchers: ['meta fair', 'fair meta', 'facebook ai research', 'meta embodied ai', 'meta superintelligence'],
    domain: 'meta.com',
    accountType: 'LAB',
    why: 'FAIR Embodied AI — sim/datasets/HW stack; acquired ARI May 2026 for humanoid AI',
  },
  {
    name: 'Microsoft Research Robotics',
    matchers: ['microsoft research', 'msr applied robotics', 'msr robotics'],
    domain: 'microsoft.com',
    accountType: 'LAB',
    why: 'Applied Robotics Research — ChatGPT-Robot, long-step robot control',
  },
  {
    name: 'Allen Institute for AI',
    matchers: ['allen institute', 'allenai', 'ai2 prior', 'mosaic ai2'],
    domain: 'allenai.org',
    accountType: 'LAB',
    why: 'PRIOR team — MolmoBot March 2026, 42M grasp annotations, sim-to-real bridge',
  },
  {
    name: 'IBM Research Robotics',
    matchers: ['ibm research', 'ibm robotics'],
    domain: 'ibm.com',
    accountType: 'LAB',
    why: 'RoCo Challenge 2026 with Galaxea R1 Lite; smaller team but funded',
  },
  {
    name: 'Samsung Research',
    matchers: ['samsung research', 'sait samsung', 'samsung ai'],
    domain: 'samsung.com',
    accountType: 'LAB',
    why: 'Robotic-hand group launched 2025; Shallow-π April 2026 (17Hz inference)',
  },
  {
    name: 'Hugging Face Robotics',
    matchers: ['hugging face robotics', 'lerobot team', 'pollen robotics', 'remi cadene', 'huggingface robotics'],
    domain: 'huggingface.co',
    accountType: 'LAB',
    why: 'Acquired Pollen Robotics April 2025; LeRobot Hub 58K datasets May 2026',
  },
  {
    name: 'Amazon FAR',
    matchers: ['amazon frontier ai for robotics', 'amazon far', 'amazon robotics ai', 'covariant amazon'],
    domain: 'amazon.com',
    accountType: 'LAB',
    why: 'Pieter Abbeel + Covariant team; massive in-house data + manipulation foundation model effort',
  },
];

export type IcpCompany = {
  name: string;
  domain: string;
  // Loose substring matchers Apollo title-search keys off. Include CN/JP/KR
  // local-language variants for non-US targets — Apollo doesn't translate.
  titleMatchers: string[];
  // ISO-3166 alpha-2. Used for Twenty Company.country and for disambiguation
  // (e.g. 'AI2 Robotics' CN vs 'Allen Institute / AI2' US).
  country: string;
  // Free-form rationale. Not used at runtime.
  why?: string;
};

export const ICP_COMPANIES: IcpCompany[] = [
  // ─── Existing humanoid US set
  {
    name: 'Figure',
    domain: 'figure.ai',
    country: 'US',
    titleMatchers: ['robot learning', 'manipulation', 'head of data', 'ml lead', 'foundation model'],
    why: 'Figure 02 humanoid; OpenAI partnership ended, in-house foundation model — top data buyer',
  },
  {
    name: 'Physical Intelligence',
    domain: 'physicalintelligence.company',
    country: 'US',
    titleMatchers: ['research', 'manipulation', 'data', 'engineering', 'foundation model'],
    why: 'Pi0, Pi0.5 models; cross-embodiment training — direct customer for teleop + ego data',
  },
  {
    name: 'Skild AI',
    domain: 'skild.ai',
    country: 'US',
    titleMatchers: ['research', 'manipulation', 'data', 'foundation model'],
    why: 'Skild Brain — general-purpose robot foundation model',
  },
  {
    name: 'Apptronik',
    domain: 'apptronik.com',
    country: 'US',
    titleMatchers: ['robot learning', 'manipulation', 'data', 'ml', 'head of ai'],
    why: 'Apollo humanoid; Mercedes-Benz + GXO partnerships',
  },
  {
    name: 'Agility Robotics',
    domain: 'agilityrobotics.com',
    country: 'US',
    titleMatchers: ['robot learning', 'manipulation', 'data', 'ml'],
    why: 'Digit humanoid in Amazon/Spanx warehouses',
  },
  {
    name: '1X Technologies',
    domain: '1x.tech',
    country: 'US',
    titleMatchers: ['robot learning', 'manipulation', 'data', 'ml', 'foundation model'],
    why: 'Neo Beta household humanoid; OpenAI investor — home data heavy buyer',
  },
  {
    name: 'Sanctuary AI',
    domain: 'sanctuary.ai',
    country: 'CA',
    titleMatchers: ['robot learning', 'manipulation', 'data', 'ml', 'phoenix'],
    why: 'Phoenix humanoid with tactile in-hand manipulation',
  },
  {
    name: 'Tesla Optimus',
    domain: 'tesla.com',
    country: 'US',
    titleMatchers: ['optimus', 'humanoid', 'robot learning'],
    why: 'Optimus Gen 2/3; Musk + Grok integration',
  },

  // ─── New US humanoid wave (2026)
  {
    name: 'Persona AI',
    domain: 'personainc.ai',
    country: 'US',
    titleMatchers: ['head of data', 'robot learning', 'vp engineering', 'cto', 'head of ai'],
    why: 'Nic Radford (ex-Apptronik founder) + Jerry Pratt CTO; HD Hyundai shipyard humanoid',
  },
  {
    name: 'K-Scale Labs',
    domain: 'kscale.dev',
    country: 'US',
    titleMatchers: ['head of ml', 'foundation model', 'robot learning', 'cto'],
    why: 'Ben Bolte (ex-Tesla Optimus); open-source K-Bot ($9K) + Z-Bot ($999)',
  },
  {
    name: 'Reflex Robotics',
    domain: 'reflexrobotics.com',
    country: 'US',
    titleMatchers: ['head of data', 'robot learning', 'head of ai'],
    why: 'NY-based wheeled humanoid; GXO pilot; Latam factory 2026',
  },
  {
    name: 'Foundation Robotics',
    domain: 'foundation.bot',
    country: 'US',
    titleMatchers: ['head of ai', 'robot learning', 'head of data'],
    why: 'Phantom humanoid; vision-only hybrid imitation. Diligence note: ex-Synapse CEO',
  },
  {
    name: 'Collaborative Robotics',
    domain: 'co.bot',
    country: 'US',
    titleMatchers: ['head of ml', 'ai lead', 'vp engineering'],
    why: 'Brad Porter ex-Amazon Robotics VP; Proxie mobile manipulator (bearish on humanoids)',
  },
  {
    name: 'Weave Robotics',
    domain: 'weaverobotics.com',
    country: 'US',
    titleMatchers: ['head of ai', 'robot learning', 'cto'],
    why: 'Isaac 0 laundry-folding home robot $8K — needs household manipulation data',
  },
  {
    name: 'Dyna Robotics',
    domain: 'dyna.co',
    country: 'US',
    titleMatchers: ['head of data', 'foundation model', 'head of ml'],
    why: 'Lindon Gao + Jason Ma (ex-DeepMind); DYNA-1 foundation model for stationary arms',
  },
  {
    name: 'Beyond Imagination',
    domain: 'beomni.ai',
    country: 'US',
    titleMatchers: ['head of ai', 'robot learning', 'head of data'],
    why: 'Kurzweil/Kamen/Robbins founded; teleop-first Beomni humanoid',
  },
  {
    name: 'Hello Robot',
    domain: 'hello-robot.com',
    country: 'US',
    titleMatchers: ['head of ml', 'head of ai', 'research lead'],
    why: 'Stretch 4 May 2026; >1000 users in 23 countries — academic + startup buyer',
  },
  {
    name: 'Path Robotics',
    domain: 'path-robotics.com',
    country: 'US',
    titleMatchers: ['head of ai', 'head of perception', 'physical ai'],
    why: 'Welding manipulation, Rove mobile quadruped welder, Navy HYPR contract',
  },
  {
    name: 'Field AI',
    domain: 'fieldai.com',
    country: 'US',
    titleMatchers: ['head of ml', 'robot learning'],
    why: 'Field Foundation Models for outdoor/unstructured environments — adjacent fit',
  },
  {
    name: 'Diligent Robotics',
    domain: 'diligentrobots.com',
    country: 'US',
    titleMatchers: ['head of ai', 'head of autonomy', 'robot learning'],
    why: 'Moxi hospital mobile manipulator; Serve Robotics acquisition Jan 2026',
  },
  {
    name: 'Mind Robotics',
    domain: 'mindrobotics.com',
    country: 'US',
    titleMatchers: ['head of data', 'robot learning', 'head of ai', 'foundation model', 'data flywheel'],
    why: 'Rivian (RJ Scaringe) spinout; $500M Series A March 2026 + $400M ext May; explicit data-flywheel thesis for dexterous manufacturing.',
  },
  {
    name: 'Fauna Robotics',
    domain: 'faunarobotics.com',
    country: 'US',
    titleMatchers: ['head of ai', 'robot learning', 'cto', 'foundation model'],
    why: 'NYC; exited stealth Jan 2026 with Sprout humanoid as Creator Edition dev platform (Disney, BD, UCSD, NYU). Small + approachable.',
  },
  {
    name: 'Noble Machines',
    domain: 'noblemachines.com',
    country: 'US',
    titleMatchers: ['head of ai', 'robot learning', 'cto', 'head of data'],
    why: 'Sunnyvale; ex-Apple/SpaceX/NASA/Caltech; Moby humanoid; F500 customer in 18mo. Formerly "Under Control Robotics".',
  },
  {
    name: 'Generalist AI',
    domain: 'generalistai.com',
    country: 'US',
    titleMatchers: ['head of data', 'foundation model', 'robot learning', 'research'],
    why: 'Pieter Abbeel new co; GEN-1 foundation model April 2026 (99% simple tasks); dexterity-mastery thesis = chronic demo-data appetite.',
  },
  {
    name: 'Integral AI',
    domain: 'integral.ai',
    country: 'US',
    titleMatchers: ['head of data', 'robot learning', 'foundation model', 'embodied ai'],
    why: 'SF (2020) + Tokyo arm March 2026 (Jad Tarifi ex-Google); building VLA-style models without an in-house robot fleet — must buy teleop data.',
  },

  // ─── EU humanoid
  {
    name: 'NEURA Robotics',
    domain: 'neura-robotics.com',
    country: 'DE',
    titleMatchers: ['head of ai', 'head of data', 'robot learning', 'vp ml'],
    why: '4NE1 humanoid; €1B Tether-led round March 2026 — top-3 European buyer',
  },
  {
    name: 'Prosper Robotics',
    domain: 'prosper.org',
    country: 'UK',
    titleMatchers: ['head of ai', 'head of teleoperation', 'cto'],
    why: 'Shariq Hashme (ex-OpenAI); Alfie wheeled home robot teleop-first',
  },
  {
    name: 'Sereact',
    domain: 'sereact.ai',
    country: 'DE',
    titleMatchers: ['head of ai', 'head of data', 'robot learning', 'foundation model'],
    why: 'Stuttgart; $110M Series B April 2026; Cortex 2.0 VLA + world model; BMW/Daimler customers explicitly need more manipulation demos.',
  },
  {
    name: 'Generative Bionics',
    domain: 'gbionics.ai',
    country: 'IT',
    titleMatchers: ['head of ai', 'robot learning', 'data lead', 'cto'],
    why: 'IIT Genoa spinout; €81M seed; AMD partner GENE.01 (CES 2026); robot launch Q4 2026 with no in-house data pipeline yet.',
  },
  {
    name: 'Kinisi Robotics',
    domain: 'kinisi-robotics.com',
    country: 'UK',
    titleMatchers: ['head of ai', 'robot learning', 'cto', 'head of data'],
    why: 'Bren Pierce (Bear Robotics/Robotize); factory + warehouse pilots; pragmatic founder, simpler-than-spectacle humanoid.',
  },
  {
    name: 'Devanthro',
    domain: 'devanthro.com',
    country: 'DE',
    titleMatchers: ['head of ai', 'robot learning', 'teleoperation'],
    why: 'Munich; Robody humanoid avatars are hybrid teleop+AI for elder care by design — their model literally is teleop demo data.',
  },

  // ─── China humanoid (national push)
  {
    name: 'Galbot',
    domain: 'galbot.com',
    country: 'CN',
    titleMatchers: ['head of data', 'foundation model', 'ai algorithm', '数据负责人', '具身智能'],
    why: 'Wang He (PKU/Stanford); $362M March 2026, HK IPO; CATL/Bosch/Toyota partnerships',
  },
  {
    name: 'Unitree Robotics',
    domain: 'unitree.com',
    country: 'CN',
    titleMatchers: ['head of ai', 'embodied ai', '具身智能', 'data lead'],
    why: 'G1 ($16K) + H1 + H2; A-share IPO 2026; commodity HW → competes on policies',
  },
  {
    name: 'AgiBot',
    domain: 'agibot.com',
    country: 'CN',
    titleMatchers: ['head of data', 'embodied ai', '具身智能负责人'],
    why: 'Ex-Huawei Deng Taihua + Peng Zhihui; G2 humanoid; Tencent/HongShan/BYD-backed',
  },
  {
    name: 'Robot Era',
    domain: 'robotera.com',
    country: 'CN',
    titleMatchers: ['head of data', 'ai lead', 'foundation model'],
    why: 'Tsinghua spin-out; $200M+ Series B+ May 2026; 95% vertically integrated',
  },
  {
    name: 'XPeng Robotics',
    domain: 'xpeng.com',
    country: 'CN',
    titleMatchers: ['robotics ai', 'vla', 'iron humanoid', '具身智能负责人'],
    why: 'IRON gen-2 humanoid; 82 DoF, VLA 2.0; mass-production late 2026',
  },
  {
    name: 'Fourier Intelligence',
    domain: 'fourierintelligence.com',
    country: 'CN',
    titleMatchers: ['head of ai', 'robot learning'],
    why: 'GR-1/GR-2/GR-3 humanoids; targeting mass production 2026',
  },
  {
    name: 'UBTECH Robotics',
    domain: 'ubtrobot.com',
    country: 'CN',
    titleMatchers: ['head of ai', 'walker product', 'data lead'],
    why: 'Walker S/S1 in EV factories; State Grid contracts; public on HKEX',
  },
  {
    name: 'LimX Dynamics',
    domain: 'limxdynamics.com',
    country: 'CN',
    titleMatchers: ['head of ai', 'cosa lead', 'foundation model'],
    why: 'Shenzhen humanoid (P1); building COSA agentic OS; $200M Series A+',
  },
  {
    name: 'Galaxea AI',
    domain: 'galaxea-ai.com',
    country: 'CN',
    titleMatchers: ['head of data', 'foundation model', 'embodied ai', '具身智能负责人'],
    why: 'Beijing; $144M Feb + $291M April 2026; mobile manipulation focus. NOT same as Galbot. China = friction tax.',
  },

  // ─── Foundation-model labs that touch / will touch physical AI
  {
    name: 'OpenAI Robotics',
    domain: 'openai.com',
    country: 'US',
    titleMatchers: ['robotics', 'embodied ai', 'robotics hardware'],
    why: 'Relaunched Nov 2024; Kalinowski resigned March 2026; reportedly hiring (Ben Bolte?)',
  },
  {
    name: 'World Labs',
    domain: 'worldlabs.ai',
    country: 'US',
    titleMatchers: ['head of robotics', 'simulation', 'spatial intelligence'],
    why: 'Fei-Fei Li $1B Feb 2026; Marble 3D-world generator; targets sim-to-real',
  },
  {
    name: 'Anthropic',
    domain: 'anthropic.com',
    country: 'US',
    titleMatchers: ['embodied ai research', 'research scientist'],
    why: 'Project Fetch (Claude controls robot dog); evals + ego-video buyer, not teleop',
  },
  {
    name: 'Black Forest Labs',
    domain: 'bfl.ai',
    country: 'DE',
    titleMatchers: ['physical ai', 'embodied ai', 'world model'],
    why: 'FLUX team pivoting to physical AI — visual world models for robot training',
  },
  {
    name: 'xAI',
    domain: 'x.ai',
    country: 'US',
    titleMatchers: ['robotics', 'embodied ai', 'optimus integration'],
    why: 'Grok = "System 2" brain in Tesla Optimus (Musk Jan 2026); cross-embodiment data buyer',
  },
];

// ───────────────────────────────────────────────────────────────────────
// arXiv daily feed
// ───────────────────────────────────────────────────────────────────────
export const ARXIV_FEED = {
  categories: ['cs.RO', 'cs.LG', 'cs.CV', 'cs.AI'] as const,
  keywords: [
    'manipulation',
    'imitation learning',
    'visuomotor',
    'teleoperation',
    'dexterous',
    'humanoid',
    'vision-language-action',
    'vla',
    'robot learning',
    'diffusion policy',
    'behavior cloning',
    'world model',
    'cross-embodiment',
  ] as const,
  lookbackDays: 2,
};

// ───────────────────────────────────────────────────────────────────────
// Seed papers — used by discover-similar (Exa findSimilar) AND
// discover-citations (S2 paper/{id}/citations). One canonical landmark
// paper per direction we care about.
//
// Keep the list tight; each seed produces 50-1000 citing papers and Exa
// returns 8 similar — multiplied across seeds, the candidate set is huge.
// ───────────────────────────────────────────────────────────────────────
export const SEED_PAPERS: string[] = [
  'https://arxiv.org/abs/2410.07864', // Pi0 — Physical Intelligence
  'https://arxiv.org/abs/2406.09246', // OpenVLA / RDT-1B family
  'https://arxiv.org/abs/2303.04137', // Diffusion Policy — Chi et al
  'https://arxiv.org/abs/2304.13705', // ALOHA — Zhao et al
  'https://arxiv.org/abs/2310.08864', // Open X-Embodiment / RT-X
  'https://arxiv.org/abs/2405.12213', // Octo — Open-X foundation
  'https://arxiv.org/abs/2402.10329', // UMI — Universal Manipulation Interface
  'https://arxiv.org/abs/2406.02523', // RoboCasa — Yuke Zhu lab
];

// Citation-walker seeds. Subset of SEED_PAPERS — only ones with stable
// arXiv IDs and broad citation graphs. arXiv ID format: 'arXiv:2410.07864'
// is the S2 paperId convention.
export const CITATION_SEEDS: { arxivId: string; title: string }[] = [
  { arxivId: 'arXiv:2410.07864', title: 'Pi0' },
  { arxivId: 'arXiv:2303.04137', title: 'Diffusion Policy' },
  { arxivId: 'arXiv:2304.13705', title: 'ALOHA' },
  { arxivId: 'arXiv:2310.08864', title: 'RT-X / Open X-Embodiment' },
  { arxivId: 'arXiv:2405.12213', title: 'Octo' },
];

// ───────────────────────────────────────────────────────────────────────
// GitHub repos for the contributor crawler.
//
// Picks: foundational open-source robotics-foundation-model repos. Engineers
// at humanoid co's commit here (LeRobot fork chains, Octo evaluation harnesses,
// MimicGen data pipelines) even when their company never publishes a paper.
//
// All public; rate-limit is the gating factor not access. Add a GITHUB_TOKEN
// env var to lift from 60 req/h → 5000 req/h.
// ───────────────────────────────────────────────────────────────────────
export type RoboticsRepo = {
  owner: string;
  repo: string;
  // Why this repo's contributor list is worth crawling. Documentation only.
  why?: string;
};

export const ROBOTICS_REPOS: RoboticsRepo[] = [
  { owner: 'huggingface', repo: 'lerobot', why: 'LeRobot — HF + Pollen; meta-repo for OSS robot policies' },
  { owner: 'Physical-Intelligence', repo: 'openpi', why: 'Pi0/Pi0.5 open release; PI engineers + integrators commit here' },
  { owner: 'octo-models', repo: 'octo', why: 'Octo foundation policy; Berkeley + Stanford forkers' },
  { owner: 'real-stanford', repo: 'diffusion_policy', why: 'Diffusion Policy reference impl — most-forked manipulation repo' },
  { owner: 'NVlabs', repo: 'mimicgen', why: 'MimicGen data augmentation; NVIDIA + ICP-customer integrations' },
  { owner: 'real-stanford', repo: 'universal_manipulation_interface', why: 'UMI reference — handheld gripper data collection' },
  { owner: 'tonyzhaozh', repo: 'act', why: 'ALOHA ACT reference impl' },
  { owner: 'Stanford-ILIAD', repo: 'droid', why: 'DROID dataset tooling — labs sharing teleop data' },
  { owner: 'NVlabs', repo: 'curobo', why: 'cuRobo motion planning — used by manipulation integrators' },
  { owner: 'isaac-sim', repo: 'IsaacLab', why: 'Isaac Lab sim — humanoid sim2real teams' },
];
