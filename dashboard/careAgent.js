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

const SYSTEM_PROMPT = `You are a discharge-planning assistant for a community home-visit booking tool.
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

let cached = null;

function getAgent() {
  if (cached) return cached;
  if (!process.env.OPENAI_API_KEY) {
    throw new AgentError('OPENAI_API_KEY is not set. Add it to .env to evaluate discharge notes.');
  }
  const app = adk();
  const agent = app.agent({
    name: 'discharge_care_decision',
    model: openai('gpt-5.6-luna'),
    // `history()` is what actually puts the prompt passed to `app.run()` (the
    // discharge note + patient context) in front of the model — without it,
    // only the system prompt is sent and the model has nothing to decide from.
    context: [app.context.system(SYSTEM_PROMPT), app.context.history()],
    output: { schema: decisionSchema },
  });
  cached = { app, agent };
  return cached;
}

function formatSections(sections) {
  const entries = Object.entries(sections || {}).filter(([, value]) => value);
  if (entries.length === 0) return '(no sections recorded)';
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export async function evaluateDischargeNote({ sections, patient }) {
  const { app, agent } = getAgent();
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
