// Shared types for Stage 2 contact discovery.
//
// Two finders feed this pipeline: commercial-finder (Apollo/Firecrawl/Exa) and
// academic-finder (lab-roster/S2/Exa). Both produce Candidate[] for the shared
// scoring + Hunter enrichment + balance + Twenty commit shell in find-contacts.ts.

export type AccountType = 'COMPANY' | 'INSTITUTION' | 'LAB';

export type SourceTag = 'apollo' | 'firecrawl' | 'exa' | 'hunter' | 's2' | 'web';

// Deliverability confidence on a discovered email — drives a send-time gate.
//   VERIFIED — Hunter found it on ≥1 webpage or the verifier says deliverable.
//   RISKY    — accept_all / webmail / unknown (may bounce or be a catch-all).
//   GUESSED  — derived from a Hunter pattern alone (sourceCount 0); treat as a
//              hypothesis, not a confirmed address.
export type EmailConfidence = 'VERIFIED' | 'RISKY' | 'GUESSED';

// Commercial tiers (BUYER/FOUNDER/TECHNICAL/OTHER) and academic tiers
// (PI/POSTDOC/PHD_STUDENT/RESEARCH_ENG/MASTERS_STUDENT/LAB_STAFF) share one
// union — finders only emit values from their own subset.
export type Tier =
  | 'BUYER'
  | 'FOUNDER'
  | 'TECHNICAL'
  | 'ACADEMIC'
  | 'PI'
  | 'POSTDOC'
  | 'PHD_STUDENT'
  | 'RESEARCH_ENG'
  | 'MASTERS_STUDENT'
  | 'LAB_STAFF'
  | 'OTHER';

export type Candidate = {
  firstName: string;
  lastName: string;
  title?: string;
  email?: string;
  linkedinUrl?: string;
  city?: string;
  sources: Set<SourceTag>;
  rawNotes: string[];
  apolloId?: string;
  // Default tier when no title is present — academic finder uses this to mark
  // S2-discovered co-authors as PHD_STUDENT even when no title string is known.
  defaultTier?: Tier;
  // S2 paperCount: how many of the PI's recent papers this person co-authored.
  // 1 = likely external collaborator; >=2 = likely lab member. Used by Hunter
  // gating (avoid fake pattern-guess emails for one-off external collaborators).
  paperCount?: number;
  // S2 authorId — used by the academic finder for per-author affiliation
  // lookup to filter external collaborators out of the top-N.
  s2AuthorId?: string;
  // S2 affiliations list (lowercased). Populated by the academic finder's
  // affiliation cross-ref pass. Empty array means "S2 had no affiliation data
  // for this author"; null/undefined means "lookup not yet attempted".
  s2Affiliations?: string[];
  // Position-inferred tier from S2 (PI / PHD_STUDENT / POSTDOC). Stored
  // separately from defaultTier so the academic finder can start strict
  // (paperCount<2 → defaultTier=OTHER) but upgrade defaultTier back to
  // inferredTier after the affiliation cross-ref confirms the author is at
  // the target institution.
  inferredTier?: Tier;
  // Email deliverability signals. emailVerification + emailSourceCount come
  // straight from Hunter; emailConfidence is the tri-state we compute + persist.
  emailVerification?: 'valid' | 'invalid' | 'accept_all' | 'webmail' | 'disposable' | 'unknown';
  emailSourceCount?: number;
  emailConfidence?: EmailConfidence;
};

export type FinderTarget = {
  companyId?: string;
  name: string;
  domain: string;
  accountType: AccountType;
  titleKeywords: string[];
  labUrl?: string;
  piName?: string;
  // Program-scoped commercial discovery: robotics topic keywords used to gate a
  // big diversified company (Mistral, OpenAI) down to its robotics PROGRAM,
  // rather than its whole org. Presence of this field routes find-contacts to
  // the program finder. labUrl doubles as the program page, piName as the lead.
  programKeywords?: string[];
};
