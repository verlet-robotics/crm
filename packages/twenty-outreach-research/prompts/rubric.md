# Email draft rubric

Score each dimension 1–5. Total is 0–25. Drafts below 18 should be rewritten.
A single dimension scoring 2 or lower triggers an automatic rewrite regardless
of total.

## 1. Specificity of personalization (1–5)
- **5**: References a named paper / funding round / hire / project from the last 90 days, by title or date.
- **4**: References a named lab focus area or product line with at least one specific detail.
- **3**: Generic but accurate ("your work on manipulation").
- **2**: "I came across your research."
- **1**: No personalization or wrong-target personalization.

## 2. Hook plausibility (1–5)
- **5**: A real human who read the cited paper/news would write this exact sentence.
- **4**: Plausible, slightly generic phrasing.
- **3**: Plausible but mechanical.
- **2**: Reads like a template variable was filled in.
- **1**: Reads like an LLM glued the personalization on top of a generic email.

## 3. Sales-bot smell (1–5, higher = less smell)
- **5**: Could pass as written by a Yale grad student to a PI peer.
- **4**: Slightly formal but believable.
- **3**: Has one or two phrases that read as marketing.
- **2**: Multiple template phrases ("I wanted to reach out", "touching base").
- **1**: Smells like a Mailchimp sequence.

## 4. Length & cut (1–5)
- **5**: Exactly at the target word count with no flab.
- **4**: Within 10% of target.
- **3**: Within 20%.
- **2**: Off by 25%+ in either direction.
- **1**: Off by 50%+ or rambling.

## 5. CTA clarity (1–5)
- **5**: A single, low-friction, named action.
- **4**: Single action but slightly demanding.
- **3**: Single action, generic.
- **2**: Multiple CTAs or unclear ask.
- **1**: No CTA.

## Output format
Return JSON:
```json
{
  "specificity": 4,
  "hookPlausibility": 5,
  "salesBotSmell": 5,
  "length": 4,
  "ctaClarity": 5,
  "total": 23,
  "rewriteNeeded": false,
  "notes": "Hook is strong but second paragraph drifts into commercial register for an academic target."
}
```
