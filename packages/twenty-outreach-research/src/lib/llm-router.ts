// Role-based LLM router. Each pipeline role maps to a model + system prompt.
//
// Defaults are hard-coded for sane out-of-the-box behavior, but every role
// can be overridden via env vars using a "provider:model" prefix convention:
//
//   EXTRACTOR_MODEL=nvidia:meta/llama-3.3-70b-instruct
//   SYNTHESIZER_MODEL=anthropic:claude-sonnet-4-6
//   WRITER_MODEL=openrouter:moonshotai/kimi-k2
//   CRITIC_MODEL=openrouter:moonshotai/kimi-k2
//   JUDGE_MODEL=nvidia:moonshotai/kimi-k2-instruct
//
// Supported provider prefixes:
//   anthropic:<model>       — Anthropic API (ANTHROPIC_API_KEY)
//   openai:<model>          — OpenAI API (OPENAI_API_KEY)
//   nvidia:<model>          — NVIDIA NIM, OpenAI-compatible (NVIDIA_API_KEY)
//   openrouter:<model>      — OpenRouter gateway (OPENROUTER_API_KEY)
//   moonshot:<model>        — Moonshot direct, intl endpoint (MOONSHOT_API_KEY)
//   groq:<model>            — Groq fast inference (GROQ_API_KEY)
import 'dotenv/config';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, generateObject, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import {
  SYSTEM_PROMPT_FOR_RESEARCH,
  SYSTEM_PROMPT_FOR_DRAFTING,
  SYSTEM_PROMPT_FOR_JUDGING,
} from './prompt-cache.js';

export type Role = 'extractor' | 'synthesizer' | 'writer' | 'critic' | 'judge';

// ── OpenAI-compatible provider factories ──────────────────────────────────
//
// Created lazily — we only construct the provider when a role actually needs
// it, so missing keys for unused providers are not a hard error.

let _nvidia: ReturnType<typeof createOpenAICompatible> | null = null;
const nvidia = () => {
  if (_nvidia) return _nvidia;
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY not set (requested by nvidia:* model)');
  _nvidia = createOpenAICompatible({
    name: 'nvidia',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: key,
  });
  return _nvidia;
};

let _openrouter: ReturnType<typeof createOpenAICompatible> | null = null;
const openrouter = () => {
  if (_openrouter) return _openrouter;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set (requested by openrouter:* model)');
  _openrouter = createOpenAICompatible({
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: key,
    headers: {
      // OpenRouter rate-limit and attribution headers — optional but recommended.
      'HTTP-Referer': 'https://verlet.co',
      'X-Title': 'Verlet outreach research',
    },
  });
  return _openrouter;
};

let _moonshot: ReturnType<typeof createOpenAICompatible> | null = null;
const moonshot = () => {
  if (_moonshot) return _moonshot;
  const key = process.env.MOONSHOT_API_KEY;
  if (!key) throw new Error('MOONSHOT_API_KEY not set (requested by moonshot:* model)');
  _moonshot = createOpenAICompatible({
    name: 'moonshot',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKey: key,
  });
  return _moonshot;
};

let _groq: ReturnType<typeof createOpenAICompatible> | null = null;
const groq = () => {
  if (_groq) return _groq;
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set (requested by groq:* model)');
  _groq = createOpenAICompatible({
    name: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: key,
  });
  return _groq;
};

// ── Resolver ──────────────────────────────────────────────────────────────

const resolveModel = (spec: string): LanguageModel => {
  const idx = spec.indexOf(':');
  if (idx < 0) {
    throw new Error(
      `Invalid model spec "${spec}". Expected "provider:model", e.g. "anthropic:claude-opus-4-7".`,
    );
  }
  const provider = spec.slice(0, idx);
  const model = spec.slice(idx + 1);
  switch (provider) {
    case 'anthropic':
      return anthropic(model);
    case 'openai':
      return openai(model);
    case 'nvidia':
      return nvidia()(model);
    case 'openrouter':
      return openrouter()(model);
    case 'moonshot':
      return moonshot()(model);
    case 'groq':
      return groq()(model);
    default:
      throw new Error(
        `Unknown provider "${provider}" in model spec "${spec}". Supported: anthropic, openai, nvidia, openrouter, moonshot, groq.`,
      );
  }
};

// ── Role defaults ─────────────────────────────────────────────────────────
//
// Picked for: cheap roles → free NIM, quality roles → Claude, judge → an
// independent family (Kimi K2 via NIM) so the judge isn't blind to its own
// patterns. Override any of these via env vars.

const DEFAULT_MODEL: Record<Role, string> = {
  extractor: 'nvidia:meta/llama-3.3-70b-instruct',
  synthesizer: 'anthropic:claude-sonnet-4-6',
  writer: 'anthropic:claude-opus-4-7',
  critic: 'anthropic:claude-opus-4-7',
  // Current Kimi on NIM as of 2026-05; v2-instruct was retired 2026-05-12.
  judge: 'nvidia:moonshotai/kimi-k2.6',
};

const ROLE_TEMPERATURE: Record<Role, number> = {
  extractor: 0,
  synthesizer: 0.3,
  writer: 0.7,
  critic: 0.1,
  judge: 0.1,
};

const ROLE_SYSTEM: Record<Role, string> = {
  extractor:
    'You are an extraction agent. Given raw scraped text or paper abstracts, return ONLY the structured JSON requested. No commentary.',
  synthesizer: SYSTEM_PROMPT_FOR_RESEARCH,
  writer: SYSTEM_PROMPT_FOR_DRAFTING,
  critic: SYSTEM_PROMPT_FOR_DRAFTING,
  judge: SYSTEM_PROMPT_FOR_JUDGING,
};

const ROLE_ENV: Record<Role, string> = {
  extractor: 'EXTRACTOR_MODEL',
  synthesizer: 'SYNTHESIZER_MODEL',
  writer: 'WRITER_MODEL',
  critic: 'CRITIC_MODEL',
  judge: 'JUDGE_MODEL',
};

export const modelForRole = (role: Role): { spec: string; model: LanguageModel; provider: string } => {
  const spec = process.env[ROLE_ENV[role]] ?? DEFAULT_MODEL[role];
  const provider = spec.split(':')[0];
  return { spec, model: resolveModel(spec), provider };
};

// Anthropic and OpenAI both use native structured-output paths under the hood
// (tool-calling and json_schema strict mode respectively), so generateObject
// works correctly. Every other provider here routes through
// @ai-sdk/openai-compatible, which defaults to loose `response_format: json_object`
// mode — the model invents field names. For those we force a tool call instead,
// because Kimi K2 / Llama / Nemotron / Qwen are all trained to fill tool
// parameters with exact field names from the schema.
const PROVIDERS_WITH_NATIVE_STRUCTURED_OUTPUT = new Set(['anthropic', 'openai']);

// ── Public API ────────────────────────────────────────────────────────────

export const callText = async (role: Role, userPrompt: string): Promise<string> => {
  const { model } = modelForRole(role);
  const { text } = await generateText({
    model,
    system: ROLE_SYSTEM[role],
    prompt: userPrompt,
    temperature: ROLE_TEMPERATURE[role],
  });
  return text;
};

export const callJson = async <T>(
  role: Role,
  userPrompt: string,
  schema: z.ZodType<T>,
): Promise<T> => {
  const { model, provider, spec } = modelForRole(role);

  if (PROVIDERS_WITH_NATIVE_STRUCTURED_OUTPUT.has(provider)) {
    const { object } = await generateObject({
      model,
      system: ROLE_SYSTEM[role],
      prompt: userPrompt,
      schema,
      temperature: ROLE_TEMPERATURE[role],
    });
    return object;
  }

  // Forced tool call → schema-conforming output on Kimi K2 / Llama / etc.
  // Moonshot and NIM both ignore `response_format: json_schema`; Kimi is trained
  // to fill tool parameters with the exact field names the schema specifies.
  const toolName = `emit_${role}_result`;
  const { toolCalls, text } = await generateText({
    model,
    system: ROLE_SYSTEM[role],
    prompt: userPrompt,
    temperature: ROLE_TEMPERATURE[role],
    tools: {
      [toolName]: tool({
        description: `Emit the structured ${role} result. You MUST think through the full answer first, then fill EVERY field with substantive content drawn from the user message. Empty strings or empty arrays are NEVER valid — if you cannot answer a field with real content from the input, you have misunderstood the task. Do not call this tool with placeholder values.`,
        inputSchema: schema,
      }),
    },
    toolChoice: { type: 'tool', toolName },
  });

  if (!toolCalls.length) {
    if (process.env.LLM_DEBUG) {
      console.error(`[llm-debug] no tool calls; model emitted text: ${text.slice(0, 500)}`);
    }
    throw new Error(
      `Model ${spec} (role=${role}) did not produce a tool call despite forced toolChoice. Check provider tool-calling support.`,
    );
  }

  if (process.env.LLM_DEBUG) {
    console.error(`[llm-debug] toolCalls[0].input keys: ${Object.keys((toolCalls[0].input ?? {}) as object).join(',')}`);
    console.error(`[llm-debug] toolCalls[0].input raw: ${JSON.stringify(toolCalls[0].input).slice(0, 800)}`);
    if (text) console.error(`[llm-debug] preceding text: ${text.slice(0, 500)}`);
  }

  // The SDK validates input against inputSchema; re-parse defensively in case
  // some openai-compatible provider strips validation.
  let parsed = schema.parse(toolCalls[0].input);

  // Kimi K2 on NIM intermittently emits the schema shape with empty content
  // (all strings "", all arrays []) — known forced-tool failure mode where the
  // model fills parameters before reasoning. Detect and retry once with a more
  // directive nudge in the prompt.
  if (looksEmpty(parsed)) {
    console.warn(`[llm-router] ${spec} (role=${role}) returned empty fields; retrying once with a stronger directive`);
    const retryResult = await generateText({
      model,
      system: ROLE_SYSTEM[role],
      prompt: `${userPrompt}\n\n---\nIMPORTANT: Your previous response called the tool with all fields empty. That is not acceptable. Re-read the brief above and fill EVERY field with concrete, substantive content drawn from the inputs. Do not call the tool until you have the content.`,
      temperature: ROLE_TEMPERATURE[role],
      tools: {
        [toolName]: tool({
          description: `Emit the structured ${role} result. EVERY field must be populated with real content from the brief above; empty strings and empty arrays are forbidden.`,
          inputSchema: schema,
        }),
      },
      toolChoice: { type: 'tool', toolName },
    });
    if (!retryResult.toolCalls.length) {
      throw new Error(`Model ${spec} retry produced no tool call`);
    }
    parsed = schema.parse(retryResult.toolCalls[0].input);
    if (looksEmpty(parsed)) {
      throw new Error(
        `Model ${spec} (role=${role}) consistently returns empty structured output. Try a different provider (anthropic, openai, or groq) for this role.`,
      );
    }
  }

  return parsed;
};

// Heuristic: an output "looks empty" if every top-level string field is "" and
// every top-level array field has length 0. Catches the known Kimi forced-tool
// placeholder-fill mode.
const looksEmpty = (obj: unknown): boolean => {
  if (!obj || typeof obj !== 'object') return false;
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return true;
  let nonEmpty = 0;
  for (const [, v] of entries) {
    if (typeof v === 'string') {
      if (v.trim().length > 0) nonEmpty++;
    } else if (Array.isArray(v)) {
      if (v.length > 0) nonEmpty++;
    } else if (typeof v === 'number') {
      if (v !== 0) nonEmpty++;
    } else if (typeof v === 'boolean') {
      nonEmpty++;
    } else if (v && typeof v === 'object') {
      // Nested object — only count if it has any non-empty content.
      if (!looksEmpty(v)) nonEmpty++;
    }
  }
  return nonEmpty === 0;
};

// Diagnostic helper — print the resolved model per role. Useful before a run.
export const printRouterConfig = (): void => {
  console.log('[router] resolved models:');
  for (const role of Object.keys(DEFAULT_MODEL) as Role[]) {
    const { spec } = modelForRole(role);
    const overridden = !!process.env[ROLE_ENV[role]];
    console.log(`  ${role.padEnd(12)} → ${spec}${overridden ? '  (override)' : ''}`);
  }
};
