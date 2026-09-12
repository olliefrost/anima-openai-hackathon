import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DASHBOARD = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DASHBOARD);
const DIST = path.join(DASHBOARD, 'dist');
const SITES = ['gp', 'pharmacy', 'community'];
const MAX_REQUEST_BYTES = 4096;
const SIMULATOR_URL = 'https://sim.animahacks.com';
const PORT = Number(process.env.PORT) || 8000;

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env is optional; SIM_API_KEY may already be present in the environment.
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

class SimulatorError extends Error {}

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

async function upstream(key, apiPath, params = {}) {
  const url = new URL(apiPath, SIMULATOR_URL);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SimulatorError('Cannot reach NHS-SIM. Check your network and retry.');
  }

  if (!response.ok) {
    if (response.status === 401) throw new SimulatorError('Invalid simulator team key.');
    if (response.status === 403) throw new SimulatorError('Team key does not have access to this service.');
    throw new SimulatorError(`Simulator returned HTTP ${response.status}.`);
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

async function patientsFor(site, resources, key) {
  const patientIds = [...new Set(resources.map((resource) => resource.patientId).filter(Boolean))];

  async function findPatient(patientId) {
    const page = await upstream(key, `/api/sites/${site}/patients`, { q: patientId, offset: 0 });
    if (!Array.isArray(page.items)) {
      throw new SimulatorError('Unexpected simulator patient response.');
    }
    return page.items.find((patient) => patient.id === patientId) ?? null;
  }

  const patients = [];
  for (let offset = 0; offset < patientIds.length; offset += 10) {
    const batch = await Promise.all(patientIds.slice(offset, offset + 10).map(findPatient));
    patients.push(...batch.filter((patient) => patient !== null));
  }
  return patients;
}

async function siteData(site, key) {
  const view = await upstream(key, `/api/sites/${site}/view`, { offset: 0, limit: 500 });
  if (!Array.isArray(view.resources)) {
    throw new SimulatorError('Unexpected simulator response.');
  }
  const patients = await patientsFor(site, view.resources, key);
  const resourceTotal = view.resourceTotal ?? view.resources.length;
  if (typeof resourceTotal !== 'number') {
    throw new SimulatorError('Unexpected simulator response.');
  }
  return { ...view, patients, truncated: view.resources.length < resourceTotal };
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

async function handleGetData(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, err.status ?? 400, { error: err.message });
  }

  let payload = {};
  if (body.length > 0) {
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Invalid request.' });
    }
  }

  const key = (typeof payload === 'object' && payload !== null ? payload.key : null) || process.env.SIM_API_KEY;
  if (typeof key !== 'string' || !key) {
    return sendJson(res, 401, { error: 'Enter your NHS-SIM team API key, or set SIM_API_KEY in .env.' });
  }

  try {
    const team = await upstream(key, '/api/team');

    const sources = await Promise.all(
      SITES.map(async (site) => {
        try {
          return { site, ...(await siteData(site, key)) };
        } catch (err) {
          return { site, error: err.message, resources: [], patients: [] };
        }
      })
    );

    return sendJson(res, 200, { team, sources, fetchedAt: Date.now() });
  } catch (err) {
    if (err instanceof SimulatorError) {
      return sendJson(res, 502, { error: err.message });
    }
    throw err;
  }
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

const server = createServer(async (req, res) => {
  const hostname = (req.headers.host ?? '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(hostname)) {
    return sendJson(res, 403, { error: 'Local access only.' });
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/api/data' && req.headers.origin) {
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
    if (pathname === '/api/data' && req.method === 'POST') {
      await handleGetData(req, res);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Careloop listening on http://127.0.0.1:${PORT}`);
});
