import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile, bookingsToEvaluate } from './src/model.js';
import { evaluateDischargeNote, evaluateCareMatch, AgentError } from './careAgent.js';
import { checkSweep, createDecisionCache } from './sweep.js';

const DASHBOARD = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DASHBOARD);
const DIST = path.join(DASHBOARD, 'dist');
const MAX_REQUEST_BYTES = 4096;
const SIMULATOR_URL = 'https://sim.animahacks.com';
const PORT = Number(process.env.PORT) || 8000;

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env is optional; SIM_API_KEY/OPENAI_API_KEY may already be present in the environment.
}

const MIME_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

class SimulatorError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function sendFile(res, filePath, contentType) {
  const data = await readFile(filePath);
  securityHeaders(res);
  res.setHeader('Content-Type', contentType);
  res.writeHead(200);
  res.end(data);
}

// NHS-SIM sits behind a Caddy reverse proxy (seen on every response's `via`
// header) that occasionally answers a healthy backend with a bare, empty-body
// 502 — confirmed live: the same request fails, then succeeds seconds later
// with no other change. Every caller here is a read-only GET, so retrying a
// handful of times is safe; only retry what's actually transient (a network/
// timeout failure, or 502/503/504) and fail fast on everything else so a bad
// key or a genuine permissions error doesn't wait out three attempts.
const UPSTREAM_RETRIES = 3;
const UPSTREAM_RETRY_DELAY_MS = 300;
const READ_TIMEOUT_MS = 20_000;
// Writes need far longer than reads. Measured live: `schedule_visit` takes
// 13-19s just to answer (a read is ~240ms), which sat right on the 20s cutoff
// both used to share. An abort counts as transient, so a booking would be cut
// off mid-flight and re-sent — turning one ~15s call into ~34s, or into a
// false "Cannot reach NHS-SIM" after three attempts against a sim that was
// reachable and merely slow. Re-sending was safe (same Idempotency-Key) but
// pointless. Keep this comfortably above the simulator's real write latency.
const WRITE_TIMEOUT_MS = 45_000;

async function upstream(key, apiPath, params = {}) {
  const url = new URL(apiPath, SIMULATOR_URL);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }

  let response;
  for (let attempt = 1; attempt <= UPSTREAM_RETRIES; attempt++) {
    let networkError = false;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch {
      networkError = true;
    }

    const transient = networkError || [502, 503, 504].includes(response?.status);
    if (!transient || attempt === UPSTREAM_RETRIES) {
      if (networkError) throw new SimulatorError('Cannot reach NHS-SIM. Check your network and retry.', 504);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS * attempt));
  }

  if (!response.ok) {
    if (response.status === 401) throw new SimulatorError('Invalid simulator team key.', 401);
    if (response.status === 403) throw new SimulatorError('Team key does not have access to this service.', 403);
    throw new SimulatorError(`Simulator returned HTTP ${response.status}.`, 502);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new SimulatorError('Unexpected simulator response.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SimulatorError('Unexpected simulator response.');
  }
  return data;
}

// Latest filed discharge-summary document per patient, plus the patient directory
// the hospital returned alongside those documents.
function latestFiledDischarges(resources) {
  // A patient can have more than one discharge episode (different `id`s, e.g. a
  // seeded example alongside a batch-generated one) — these are separate documents,
  // not edits of one record, so `version` doesn't track which happened more recently.
  // Compare by when the note was actually sent instead.
  const dischargeTime = (doc) => doc.data?.sentAt ?? doc.createdAt ?? 0;
  const latest = new Map();
  for (const doc of resources) {
    if (doc.kind !== 'discharge-summary' || doc.status !== 'filed' || !doc.patientId) continue;
    const prior = latest.get(doc.patientId);
    if (!prior || dischargeTime(doc) > dischargeTime(prior)) {
      latest.set(doc.patientId, doc);
    }
  }
  return latest;
}

async function hospitalDischarges(key) {
  const view = await upstream(key, '/api/sites/hospital/documents', { offset: 0, limit: 500 });
  if (!Array.isArray(view.resources)) {
    throw new SimulatorError('Unexpected simulator response.');
  }
  const patients = new Map((view.patients || []).map((patient) => [patient.id, patient]));
  const latest = latestFiledDischarges(view.resources);
  return { latest, patients };
}

async function findPatientById(key, patientId) {
  for (const site of ['hospital', 'gp', 'community']) {
    try {
      const page = await upstream(key, `/api/sites/${site}/patients`, { q: patientId, offset: 0 });
      const match = (page.items || []).find((patient) => patient.id === patientId);
      if (match) return match;
    } catch {
      // Try the next site; a lookup failure here shouldn't fail the whole check.
    }
  }
  return null;
}

// Community resources for one patient, normalized into a common shape with
// a best-effort `startsAt` so reconciliation can compare against discharge time.
//
// `/api/sites/community/appointments` looks like a per-patient booking list but
// isn't: it's a single day's capacity schedule and 400s without a `date` param
// ("A valid date is required"), so it can't be queried by patient. Booked care
// (visits, care plans, care packages) is patient-linked and shows up in
// `/api/sites/community/view` instead — the same source the original dashboard
// used, before this tool existed.
async function communityResources(key) {
  const view = await upstream(key, '/api/sites/community/view', { offset: 0, limit: 500 });
  return view.resources || [];
}

// Shared shape for a community resource, whether it came back from the
// read-only view fetch or from the one write this tool performs (scheduling
// a home visit) — so a freshly booked visit looks exactly like one that was
// already there.
function normalizeCommunityResource(resource) {
  return {
    id: resource.id,
    kind: resource.kind,
    title: resource.title,
    status: resource.status,
    startsAt: resource.dueAt ?? resource.createdAt,
    data: resource.data,
  };
}

function bookedCareFor(resources, patientId) {
  return resources.filter((resource) => resource.patientId === patientId).map(normalizeCommunityResource);
}

// POST to NHS-SIM's one generic write endpoint (POST /api/sites/{site}/actions,
// confirmed against the live OpenAPI spec), retrying like upstream() does for
// reads. Retrying a POST is only safe because callers reuse the same
// Idempotency-Key across attempts, which per NHS-SIM's own docs is exactly
// what it's for. Shared by every write scheduleHomeVisit() makes below.
async function postAction(key, site, body, idempotencyKey) {
  const url = new URL(`/api/sites/${site}/actions`, SIMULATOR_URL);
  const requestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  };

  let response;
  for (let attempt = 1; attempt <= UPSTREAM_RETRIES; attempt++) {
    let networkError = false;
    try {
      response = await fetch(url, { ...requestInit, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
    } catch {
      networkError = true;
    }
    const transient = networkError || [502, 503, 504].includes(response?.status);
    if (!transient || attempt === UPSTREAM_RETRIES) {
      if (networkError) throw new SimulatorError('Cannot reach NHS-SIM. Check your network and retry.', 504);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS * attempt));
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // A non-JSON body on an error response still falls through to the
    // status-based messages below.
  }

  if (!response.ok) {
    if (response.status === 401) throw new SimulatorError('Invalid simulator team key.', 401);
    if (response.status === 403) throw new SimulatorError(`Team key does not have access to this ${site} action.`, 403);
    throw new SimulatorError(data?.error || `Simulator returned HTTP ${response.status}.`, response.status >= 400 && response.status < 600 ? response.status : 502);
  }
  if (!data) throw new SimulatorError('Unexpected simulator response.');
  return data;
}

// A created message is only *queued*: NHS-SIM's patient-facing view lists an
// entry once its delivery is marked `delivered`, so without this second command
// the SMS exists in the GP mailbox but the patient never sees it. `entryId` is
// the outgoing entry inside the conversation, not the conversation's own id.
async function deliverMessage(key, conversation, idempotencyKey) {
  const outgoing = (conversation.data?.entries ?? []).find((entry) => entry.direction === 'outgoing');
  if (!outgoing) throw new SimulatorError('Simulator did not return an outgoing message entry to deliver.');
  await postAction(
    key,
    'gp',
    {
      type: 'messaging_action',
      resourceId: conversation.id,
      expectedVersion: conversation.version,
      messagingCommand: { kind: 'delivery', entryId: outgoing.id, status: 'delivered' },
    },
    idempotencyKey
  );
}

// The only write this tool performs: scheduling a community home visit via
// NHS-SIM's `schedule_visit` action — and only after a human has reviewed
// and confirmed the drafted title/text in the UI. As part of that same
// confirmed action (not a separate, independently-triggered write), it also
// sends the patient an SMS via the GP site's `messaging_action` — created,
// then explicitly delivered, since a created message is only queued — telling
// them when the visit is booked for. A failure at either step doesn't undo or
// fail the booking, which already succeeded — it's reported back via
// `notified: false` instead, so the UI can show it without risking a
// duplicate booking from a retry. `notified` means the patient can actually
// see the message, so a create that never delivers counts as false.
async function scheduleHomeVisit(key, { patientId, title, text }, idempotencyKey) {
  const resource = await postAction(key, 'community', { type: 'schedule_visit', patientId, title, ...(text ? { text } : {}) }, idempotencyKey);
  const booking = normalizeCommunityResource(resource);

  const when = Number.isFinite(resource.dueAt)
    ? new Date(resource.dueAt).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' })
    : null;
  const body = when
    ? `Your home visit has been booked for ${when}. Reply to this message if you have any questions.`
    : 'Your home visit has been booked. The community team will confirm a time separately. Reply to this message if you have any questions.';

  let notified = true;
  try {
    const conversation = await postAction(
      key,
      'gp',
      { type: 'messaging_action', patientId, messagingCommand: { kind: 'create', subject: 'Home visit booked', body, channel: 'sms', allowReply: true } },
      `${idempotencyKey}-notify`
    );
    await deliverMessage(key, conversation, `${idempotencyKey}-deliver`);
  } catch (err) {
    console.error('Home-visit SMS confirmation failed.');
    notified = false;
  }

  return { booking, notified };
}

const cachedDecision = createDecisionCache(evaluateDischargeNote);

async function runCheck(key, patientId, discharges, resources) {
  const doc = discharges.latest.get(patientId);
  const patient = discharges.patients.get(patientId) ?? (await findPatientById(key, patientId));

  if (!doc) {
    return { patientId, patientName: patient?.name ?? null, status: 'no-discharge-summary' };
  }

  const decision = await cachedDecision(key, { sections: doc.data?.sections, patient });
  const bookings = bookedCareFor(resources, patientId);
  const dischargeAt = doc.data?.sentAt ?? doc.createdAt;
  const toEvaluate = bookingsToEvaluate(decision, bookings, dischargeAt);
  const verdicts = await evaluateCareMatch({ careType: decision.careType, rationale: decision.rationale, bookings: toEvaluate });
  const matchVerdicts = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const reconciliation = reconcile(decision, bookings, dischargeAt, matchVerdicts);

  return {
    patientId,
    patientName: patient?.name ?? null,
    dischargeSummary: {
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      sentAt: doc.data?.sentAt,
      sentBy: doc.data?.sentBy,
      sections: doc.data?.sections,
    },
    decision,
    bookings,
    reconciliation,
  };
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      const error = new Error('Request too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Invalid request.');
    error.status = 400;
    throw error;
  }
}

function resolveKey(payload) {
  return (typeof payload === 'object' && payload !== null ? payload.key : null) || process.env.SIM_API_KEY || null;
}

async function withKey(req, res, handler) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.message });
  }

  const key = resolveKey(payload);
  if (!key) {
    return sendJson(res, 401, { error: 'Enter your NHS-SIM team API key, or set SIM_API_KEY in .env.' });
  }

  try {
    return await handler(key, payload);
  } catch (err) {
    // SimulatorError/AgentError messages are written to be shown to the user
    // (bad key, unreachable service, missing OPENAI_API_KEY). Anything else
    // is unexpected internal failure — rethrow so the outer handler logs it
    // and returns a generic 500 instead of leaking its message to the client.
    if (err instanceof SimulatorError || err instanceof AgentError) {
      // Distinct statuses (401 bad key, 403 no access, 504 unreachable, 502
      // upstream failure) so a real sim/network problem doesn't look
      // identical to a bad key in the network tab — log server-side too,
      // since the message names which dependency failed and never contains
      // a key or patient data.
      console.error(`${req.url}: ${err.message}`);
      return sendJson(res, err.status ?? 502, { error: err.message });
    }
    throw err;
  }
}

async function handleConnect(req, res) {
  return withKey(req, res, async (key) => {
    const team = await upstream(key, '/api/team');
    return sendJson(res, 200, { team });
  });
}

async function handleCheck(req, res) {
  return withKey(req, res, async (key, payload) => {
    const patientId = typeof payload.patientId === 'string' ? payload.patientId.trim() : '';
    if (!patientId) return sendJson(res, 400, { error: 'patientId is required.' });
    const discharges = await hospitalDischarges(key);
    const resources = await communityResources(key);
    const result = await runCheck(key, patientId, discharges, resources);
    return sendJson(res, 200, result);
  });
}

async function handleBookHomeVisit(req, res) {
  return withKey(req, res, async (key, payload) => {
    const patientId = typeof payload.patientId === 'string' ? payload.patientId.trim() : '';
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const idempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.trim() : '';
    if (!patientId || !title || !idempotencyKey) {
      return sendJson(res, 400, { error: 'patientId, title, and idempotencyKey are required.' });
    }
    if (title.length > 500) return sendJson(res, 400, { error: 'Booking title must be at most 500 characters.' });
    const { booking, notified } = await scheduleHomeVisit(key, { patientId, title, text }, idempotencyKey);
    return sendJson(res, 200, { booking, notified });
  });
}

async function handleSweep(req, res) {
  return withKey(req, res, async (key) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new AgentError('OPENAI_API_KEY is not set. Add it to .env to evaluate discharge notes.');
    }
    const [discharges, resources] = await Promise.all([
      hospitalDischarges(key),
      communityResources(key),
    ]);
    const patientIds = [...discharges.latest.keys()];
    securityHeaders(res);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.writeHead(200);
    res.write(`${JSON.stringify({ type: 'progress', done: 0, total: patientIds.length })}\n`);

    const results = await checkSweep(
      patientIds,
      (patientId) => runCheck(key, patientId, discharges, resources),
      (done, total) => res.write(`${JSON.stringify({ type: 'progress', done, total })}\n`)
    );
    res.end(`${JSON.stringify({ type: 'done', results })}\n`);
  });
}

async function handleStatic(req, res, pathname) {
  if (pathname.startsWith('/assets/')) {
    const relative = pathname.slice('/assets/'.length);
    const filePath = path.join(DIST, 'assets', relative);
    if (path.relative(path.join(DIST, 'assets'), filePath).startsWith('..')) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    try {
      const contentType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
      return await sendFile(res, filePath, contentType);
    } catch {
      return sendJson(res, 404, { error: 'Not found' });
    }
  }

  if (path.basename(pathname).includes('.')) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  try {
    return await sendFile(res, path.join(DIST, 'index.html'), 'text/html; charset=utf-8');
  } catch {
    return sendJson(res, 503, {
      error: 'Frontend build not found. Run `npm run build`, or use `npm run dev` for Vite development.',
    });
  }
}

const ROUTES = {
  '/api/connect': handleConnect,
  '/api/sweep': handleSweep,
  '/api/check': handleCheck,
  '/api/book-home-visit': handleBookHomeVisit,
};

const server = createServer(async (req, res) => {
  const hostname = (req.headers.host ?? '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(hostname)) {
    return sendJson(res, 403, { error: 'Local access only.' });
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Only a browser sends an Origin header — a same-machine script hitting this
  // API directly (curl, tests) has no origin to check and is already covered
  // by the loopback-only bind above. This blocks a *different* origin's page
  // from using the browser's fetch to reach these routes.
  if (pathname in ROUTES && req.headers.origin) {
    const port = req.socket.localPort;
    const allowedOrigins = new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    if (!allowedOrigins.has(req.headers.origin)) {
      return sendJson(res, 403, { error: 'Origin not allowed.' });
    }
  }

  try {
    if (pathname in ROUTES && req.method === 'POST') {
      await ROUTES[pathname](req, res);
    } else {
      await handleStatic(req, res, pathname);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  }
});

export { latestFiledDischarges, postAction, scheduleHomeVisit };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Careloop listening on http://127.0.0.1:${PORT}`);
  });
}
