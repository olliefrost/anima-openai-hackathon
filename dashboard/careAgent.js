import { adk } from '@animahealth/adk';
import { openai } from '@animahealth/adk/openai';
import { z } from 'zod';
import { careTypes } from './src/model.js';

export class AgentError extends Error {}

const decisionSchema = z.object({
  careNeeded: z.boolean().describe('Whether the discharge note indicates the patient needs community-service follow-up care.'),
  careType: z.enum(careTypes).nullable().describe('The single best-matching category of care needed. Null when careNeeded is false.'),
  urgency: z.enum(['routine', 'urgent']).nullable().describe('How soon the care should start. Null when careNeeded is false.'),
  ambiguous: z.boolean().describe('True when the note does not give enough information to decide confidently — prefer this over guessing.'),
  confidence: z.enum(['low', 'medium', 'high']),
  rationale: z.string().describe('One or two sentences citing the specific part of the note that drove this decision.'),
  summary: z.string().describe('A short plain-language summary (2-4 sentences) of the discharge note for a non-clinical reviewer: why the patient was admitted and what needs to happen next.'),
  homeVisitBooking: z.object({
    title: z.string().trim().min(1).describe('A short, specific booking title, e.g. "Post-discharge wound review at home".'),
    text: z.string().trim().min(20).describe('A clear one-to-three sentence handover for the community team: what the visit is for and the relevant discharge context, grounded only in the supplied note and patient context.'),
  }).nullable().describe('A draft home-visit booking title and text, only when careType is home-visit, careNeeded is true, and ambiguous is false. Null otherwise.'),
});

function hasValidHomeVisitDraft(decision) {
  const needsDraft = decision.careNeeded && decision.careType === 'home-visit' && !decision.ambiguous;
  return needsDraft === Boolean(decision.homeVisitBooking);
}

const DECISION_SYSTEM_PROMPT = `You are a discharge-planning assistant for a community home-visit booking tool.
You are given the free-text sections of a hospital discharge summary and what is known about the patient.
Decide whether the patient needs follow-on care from community services after this discharge, and if so,
which single category best fits from exactly this list: ${careTypes.join(', ')}.

Only use information present in the note and patient context. If the note is genuinely ambiguous or
missing what you'd need to decide — for example "requires community follow-up" with no detail on what
kind — set ambiguous to true and say why in the rationale, rather than guessing a category. Do not invent
care needs the text doesn't support. This tool is a review aid: an over-confident wrong answer causes more
harm than an honest "ambiguous".

Also write "summary": a short, plain-language summary of the discharge note (2-4 sentences) for a
non-clinical reviewer, covering why the patient was admitted and what needs to happen next.

Only when careType is home-visit, careNeeded is true, and ambiguous is false, also draft
"homeVisitBooking". Write a specific title and a concise one-to-three sentence handover for the community
team who will receive the booking. The handover must read naturally and say what the team should assess or
do at the visit and why, using relevant discharge details such as wound care, mobility, or medication support.
Include useful constraints or risks when the supplied information supports them. Do not copy fragments,
invent instructions, diagnoses, timings, or clinical facts, and do not use generic boilerplate. In every
other case, set homeVisitBooking to null.`;

const matchVerdictSchema = z.object({
  id: z.string(),
  verdict: z.enum(['matches', 'no-match', 'ambiguous']).describe(
    '"matches" if this booking plausibly delivers the needed care type, "no-match" if it clearly does not, ' +
      '"ambiguous" if the booking\'s text is too generic or terse to tell either way — prefer this over guessing.'
  ),
  reason: z.string().describe("One sentence citing what in the booking's title, kind, status, or data supports this verdict."),
});

const matchSchema = z.object({ verdicts: z.array(matchVerdictSchema) });

const MATCH_SYSTEM_PROMPT = `You are reviewing whether community-service bookings actually deliver a specific
type of follow-up care that a hospital discharge decision said a patient needs.

You are given the care type decided as needed, the rationale behind that decision, and a list of community
bookings made for this patient after discharge (each with an id, title, kind, status, and any other recorded
detail). For EACH booking, decide whether it plausibly represents that care type being delivered.

Use clinical judgement, not literal keyword matching — for example "wound dressing change" plausibly
fulfils district nursing, and "OT home assessment" plausibly fulfils occupational therapy, even without an
exact phrase match. But when a booking's text is too generic or terse to tell either way (for example a
title as bare as "hi" or "visit" with no other detail), mark it ambiguous rather than guessing — the same
principle as the original care decision: an over-confident wrong verdict here is worse than an honest
"unclear".

Return exactly one verdict per booking given, each referencing its id.`;

let app = null;
let decisionAgent = null;
let matchAgent = null;

function requireOpenAiKey() {
  if (!process.env.OPENAI_API_KEY) {
    throw new AgentError('OPENAI_API_KEY is not set. Add it to .env to evaluate discharge notes.');
  }
}

function getApp() {
  if (!app) app = adk();
  return app;
}

// `history()` is what actually puts the prompt passed to `app.run()` in
// front of the model — without it, only the system prompt is sent and the
// model has nothing to decide from. Both agents below need it.
function getDecisionAgent() {
  requireOpenAiKey();
  if (decisionAgent) return decisionAgent;
  const currentApp = getApp();
  decisionAgent = currentApp.agent({
    name: 'discharge_care_decision',
    model: openai('gpt-5.6-luna'),
    context: [currentApp.context.system(DECISION_SYSTEM_PROMPT), currentApp.context.history()],
    output: { schema: decisionSchema },
  });
  return decisionAgent;
}

function getMatchAgent() {
  requireOpenAiKey();
  if (matchAgent) return matchAgent;
  const currentApp = getApp();
  matchAgent = currentApp.agent({
    name: 'care_booking_match',
    model: openai('gpt-5.6-luna'),
    context: [currentApp.context.system(MATCH_SYSTEM_PROMPT), currentApp.context.history()],
    output: { schema: matchSchema },
  });
  return matchAgent;
}

function formatSections(sections) {
  const entries = Object.entries(sections || {}).filter(([, value]) => value);
  if (entries.length === 0) return '(no sections recorded)';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export async function evaluateDischargeNote({ sections, patient }) {
  const agent = getDecisionAgent();
  const prompt = [
    'Discharge note sections:',
    formatSections(sections),
    '',
    'Patient context:',
    `Conditions: ${(patient?.conditions || []).join(', ') || 'unknown'}`,
    `Known needs: ${(patient?.needs || []).join(', ') || 'unknown'}`,
  ].join('\n');

  let result;
  try {
    result = await app.run(agent, prompt);
  } catch (err) {
    throw new AgentError(`Discharge note evaluation failed: ${err.message}`);
  }

  // `output: { schema }` already constrains the model's response, but ADK's
  // structured output goes through a "forgiving" parser (coercion, partial
  // matches) rather than a hard schema gate — re-validating here is the
  // actual boundary check before an unvalidated shape reaches reconciliation.
  const parsed = decisionSchema.safeParse(result.output.value);
  if (!parsed.success || !hasValidHomeVisitDraft(parsed.data)) {
    throw new AgentError('Discharge note evaluation returned an unexpected shape.');
  }
  return parsed.data;
}

function formatBookingForPrompt(booking) {
  const when = Number.isFinite(booking.startsAt) ? new Date(booking.startsAt).toISOString() : 'unknown date';
  const details = booking.data && Object.keys(booking.data).length > 0 ? ` | details: ${JSON.stringify(booking.data)}` : '';
  return `- id: ${booking.id} | title: "${booking.title || '(no title)'}" | kind: ${booking.kind} | status: ${booking.status} | date: ${when}${details}`;
}

// Reasons about whether each booking actually delivers the decided care
// type — the replacement for keyword matching. `bookings` should already be
// filtered to whatever's actually worth checking (see model.js's
// bookingsToEvaluate); this returns one verdict per booking, same order.
export async function evaluateCareMatch({ careType, rationale, bookings }) {
  if (bookings.length === 0) return [];

  const agent = getMatchAgent();
  const prompt = [
    `Care type decided as needed: ${careType}`,
    `Why it was decided: ${rationale}`,
    '',
    'Bookings to check (one verdict per id):',
    ...bookings.map(formatBookingForPrompt),
  ].join('\n');

  let result;
  try {
    result = await app.run(agent, prompt);
  } catch (err) {
    throw new AgentError(`Care-match evaluation failed: ${err.message}`);
  }

  const parsed = matchSchema.safeParse(result.output.value);
  if (!parsed.success) {
    throw new AgentError('Care-match evaluation returned an unexpected shape.');
  }

  const verdictById = new Map(parsed.data.verdicts.map((verdict) => [verdict.id, verdict]));
  const missing = bookings.filter((booking) => !verdictById.has(booking.id));
  if (missing.length > 0 || verdictById.size !== bookings.length || parsed.data.verdicts.length !== bookings.length) {
    throw new AgentError('Care-match evaluation did not return a verdict for every booking.');
  }

  return bookings.map((booking) => verdictById.get(booking.id));
}
