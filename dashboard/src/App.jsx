import { useEffect, useRef, useState } from 'react';
import { urgencyLabel } from './model.js';

const STATUS_META = {
  ok: { label: 'Matches', className: 'green' },
  flag: { label: 'Flagged', className: 'red' },
  review: { label: 'Needs review', className: 'amber' },
  'no-discharge-summary': { label: 'No discharge summary', className: '' },
  'check-failed': { label: 'Check failed', className: 'red' },
};

// Same score bands as urgencyLabel() in model.js, just mapped to a badge
// color instead of text.
function urgencyBadgeClass(score) {
  if (score >= 80) return 'red';
  if (score >= 30) return 'amber';
  return 'green';
}

function formatDate(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
}

// Readable headings for the discharge note's raw section keys — falls back to
// a generic camelCase-to-words split for any key not listed here.
const SECTION_LABELS = {
  reason: 'Reason for admission',
  course: 'Hospital course',
  results: 'Results',
  diagnoses: 'Diagnoses',
  medicationChanges: 'Medication changes',
  followUp: 'Follow-up',
  gpActions: 'GP actions',
};

function sectionLabel(key) {
  return SECTION_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
}

async function postJson(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function newIdempotencyKey(patientId) {
  return `home-visit-${patientId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, className: '' };
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

function UrgencyBadge({ score }) {
  if (!score) return null;
  return <span className={`badge ${urgencyBadgeClass(score)}`}>{urgencyLabel(score)} · {score}</span>;
}

function Sidebar({ activePage, onPageChange }) {
  return <aside className="sidebar">
    <a className="brand" href="/"><span className="brandmark">c</span> careloop<span className="branddot">●</span></a>
    <div className="workspace">HOME VISIT BOOKING</div>
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '16px 0' }}>
      <button
        onClick={() => onPageChange('sweep')}
        style={{
          padding: '8px 12px',
          textAlign: 'left',
          backgroundColor: activePage === 'sweep' ? '#f3f4f6' : 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontWeight: activePage === 'sweep' ? 600 : 400,
        }}
      >
        Full sweep
      </button>
      <button
        onClick={() => onPageChange('check')}
        style={{
          padding: '8px 12px',
          textAlign: 'left',
          backgroundColor: activePage === 'check' ? '#f3f4f6' : 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontWeight: activePage === 'check' ? 600 : 400,
        }}
      >
        Check a patient
      </button>
    </nav>
  </aside>;
}

function ConnectionDialog({ dialogRef, loading, error, onConnect }) {
  const [candidate, setCandidate] = useState('');
  return <dialog ref={dialogRef}>
    <form onSubmit={(event) => { event.preventDefault(); onConnect(candidate.trim()).then((ok) => ok && setCandidate('')); }}>
      <div className="dialog-top"><h2>Connect your team</h2><button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">×</button></div>
      <p>Use the team API key from <a href="https://sim.animahacks.com/control/" target="_blank" rel="noreferrer">NHS-SIM → Team &amp; API key</a>. The care-decision agent uses a separate OpenAI key set on the server.</p>
      <label htmlFor="key">Simulator team API key</label>
      <input id="key" type="password" autoComplete="off" value={candidate} onChange={(event) => setCandidate(event.target.value)} placeholder="Paste team key (leave empty to use SIM_API_KEY from .env)" />
      <p className="hint">The key is kept in memory for this session and sent only through the local server to NHS-SIM.</p>
      <div className="error-text" role="alert">{error}</div>
      <button className="button primary" disabled={loading}>{loading ? 'Connecting…' : 'Connect workspace'}</button>
    </form>
  </dialog>;
}

// Keep the raw discharge letter out of the way until it is needed, then show
// every recorded section with the upstream keys reformatted for people.
function DischargeLetter({ sections }) {
  const entries = Object.entries(sections || {}).filter(([, value]) => value);
  return <details className="discharge-letter">
    <summary>Full discharge summary letter</summary>
    <div className="discharge-letter-content">
      {entries.length === 0
        ? <p className="hint">No sections recorded on this discharge note.</p>
        : entries.map(([key, value]) => <section key={key}>
          <h4>{sectionLabel(key)}</h4>
          <p>{value}</p>
        </section>)}
    </div>
  </details>;
}

// The centerpiece: a home visit that's needed but not yet booked gets a
// drafted, editable form the reviewer confirms before anything is sent.
// Careloop's one write (see AGENTS.md) only ever fires from this explicit
// click — never automatically, and never for any other care type. Booking
// also sends the patient an SMS confirming the date/time, as part of that
// same confirmed action rather than a separate step.
function HomeVisitBooking({ patientId, decision, reconciliation, onBooked }) {
  const draft = decision.homeVisitBooking;
  const [title, setTitle] = useState(draft?.title ?? 'Post-discharge home visit');
  const [text, setText] = useState(draft?.text ?? '');
  const [idempotencyKey] = useState(() => newIdempotencyKey(patientId));
  const [status, setStatus] = useState('review'); // review | sending | booked | error | dismissed
  const [notified, setNotified] = useState(true);
  const [error, setError] = useState('');

  if (decision.careType !== 'home-visit' || !decision.careNeeded || decision.ambiguous) return null;

  if (reconciliation.status === 'ok') {
    return <div className="booking-card booked"><strong>Home visit already booked</strong><p className="hint">A matching community booking was found after discharge — nothing to do here.</p></div>;
  }
  if (reconciliation.status === 'review') {
    return <div className="booking-card"><strong>Needs a human read before booking</strong><p className="hint">{reconciliation.reason}</p></div>;
  }
  if (status === 'dismissed') {
    return <div className="booking-card"><strong>Not booked</strong><p className="hint">You chose not to book this visit right now.</p></div>;
  }
  if (status === 'booked') {
    return <div className="booking-card booked">
      <strong>Home visit booked</strong>
      <p className="hint">Community care already has it. {notified ? 'The patient has been sent an SMS with the date and time.' : "The patient's SMS confirmation could not be sent — let them know the appointment time another way."}</p>
    </div>;
  }

  async function confirmBooking() {
    setStatus('sending'); setError('');
    try {
      const data = await postJson('/api/book-home-visit', { patientId, title: title.trim(), text: text.trim(), idempotencyKey });
      setNotified(data.notified);
      setStatus('booked');
      onBooked(data.booking);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  return <div className="booking-card">
    <strong>Home visit needed — not yet booked</strong>
    <p className="hint">No matching community booking was found after discharge. Review and edit this booking, then confirm — community care will have it immediately.</p>
    <label htmlFor="visit-title">Title</label>
    <input id="visit-title" value={title} onChange={(event) => setTitle(event.target.value)} />
    <label htmlFor="visit-text">Note for the community team</label>
    <textarea id="visit-text" rows={3} value={text} onChange={(event) => setText(event.target.value)} />
    {error && <div className="error-text" role="alert">{error}</div>}
    <div className="detail-actions">
      <button className="button primary" disabled={status === 'sending' || !title.trim()} onClick={confirmBooking}>{status === 'sending' ? 'Booking…' : 'Book this visit'}</button>
      <button className="button" type="button" disabled={status === 'sending'} onClick={() => setStatus('dismissed')}>Not now</button>
    </div>
  </div>;
}

function BookingsList({ bookings }) {
  if (bookings.length === 0) return <p className="hint">No community bookings found for this patient.</p>;
  return <div className="timeline">{bookings.map((booking) => (
    <div key={booking.id}>
      <span className={`timeline-dot ${booking.status === 'completed' ? 'done' : ''}`} />
      <strong>{booking.title || booking.kind}</strong>
      <small>{booking.kind} · {booking.status} · {formatDate(booking.startsAt)}</small>
    </div>
  ))}</div>;
}

function SweepResults({ results }) {
  if (!results || results.length === 0) return <p className="hint">No discharge summaries found.</p>;
  const flagged = results.filter((r) => r.reconciliation?.status === 'flag');
  const review = results.filter((r) => r.reconciliation?.status === 'review');
  const ok = results.filter((r) => r.reconciliation?.status === 'ok');
  const failed = results.filter((r) => r.status === 'check-failed' || r.status === 'no-discharge-summary');

  return <div>
    <p className="hint">{results.length - failed.length} of {results.length} patient checks completed successfully.</p>
    {failed.length > 0 && <div role="alert">
      <h3>Could not check {failed.length} {failed.length === 1 ? 'patient' : 'patients'}</h3>
      <p>These checks did not establish whether care matches. Retry the patient ID in the individual check.</p>
      {failed.map((r) => <p key={r.patientId} className="error-text">
        <strong>{r.patientId}</strong>: {r.error || 'No discharge summary found.'}
      </p>)}
    </div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
      <div className="summary-card">
        <div style={{ fontSize: 24, fontWeight: 'bold', color: '#dc2626' }}>{flagged.length}</div>
        <p className="hint">Flagged gaps</p>
      </div>
      <div className="summary-card">
        <div style={{ fontSize: 24, fontWeight: 'bold', color: '#f59e0b' }}>{review.length}</div>
        <p className="hint">Need review</p>
      </div>
      <div className="summary-card">
        <div style={{ fontSize: 24, fontWeight: 'bold', color: '#16a34a' }}>{ok.length}</div>
        <p className="hint">Matches</p>
      </div>
    </div>
    {flagged.length > 0 && <div>
      <h3 style={{ color: '#dc2626', marginBottom: 12 }}>Flagged</h3>
      <div style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
        {flagged.map((r) => (
          <div key={r.patientId} style={{ padding: 12, border: '1px solid #fecaca', borderRadius: 4, backgroundColor: '#fef2f2' }}>
            <strong>{r.patientName || r.patientId}</strong>
            <p className="hint">{r.reconciliation.reason}</p>
            <small><UrgencyBadge score={r.reconciliation.urgencyScore} /></small>
          </div>
        ))}
      </div>
    </div>}
    {review.length > 0 && <div>
      <h3 style={{ color: '#f59e0b', marginBottom: 12 }}>Need review</h3>
      <div style={{ display: 'grid', gap: 12, marginBottom: 24 }}>
        {review.map((r) => (
          <div key={r.patientId} style={{ padding: 12, border: '1px solid #fde68a', borderRadius: 4, backgroundColor: '#fffbeb' }}>
            <strong>{r.patientName || r.patientId}</strong>
            <p className="hint">{r.reconciliation.reason}</p>
            <small><UrgencyBadge score={r.reconciliation.urgencyScore} /></small>
          </div>
        ))}
      </div>
    </div>}
  </div>;
}

function ResultDetail({ result, onBooked }) {
  if (result.status === 'no-discharge-summary') {
    return <div className="empty">No discharge summary found for {result.patientName || result.patientId} in Hospital EPR documents.</div>;
  }
  if (result.status === 'check-failed') {
    return <div className="error-text" role="alert">Couldn't complete this check: {result.error}. Try running it again.</div>;
  }
  return <>
    <div className="summary-card">
      <div className="eyebrow">DISCHARGE SUMMARY</div>
      <p>{result.decision.summary}</p>
      <small>{result.dischargeSummary.title} · Sent {formatDate(result.dischargeSummary.sentAt ?? result.dischargeSummary.createdAt)}</small>
    </div>
    <div className="detail-alert">
      <StatusBadge status={result.reconciliation.status} /> <UrgencyBadge score={result.reconciliation.urgencyScore} />
      <span style={{ marginLeft: 8 }}>{result.reconciliation.reason}</span>
    </div>
    <HomeVisitBooking patientId={result.patientId} decision={result.decision} reconciliation={result.reconciliation} onBooked={onBooked} />
    <DischargeLetter sections={result.dischargeSummary.sections} />
    <h3>Booked community care</h3>
    <BookingsList bookings={result.bookings} />
  </>;
}

export default function App() {
  const [activePage, setActivePage] = useState('sweep');
  const [team, setTeam] = useState(null);
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [connectError, setConnectError] = useState('');
  const connectionDialog = useRef(null);
  const autoConnectStarted = useRef(false);

  const [sweepResults, setSweepResults] = useState(null);
  const [sweepLoading, setSweepLoading] = useState(false);
  const [sweepError, setSweepError] = useState('');

  const [patientIdInput, setPatientIdInput] = useState('');
  const [result, setResult] = useState(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [checkError, setCheckError] = useState('');

  function showConnection() {
    if (!connectionDialog.current?.open) connectionDialog.current?.showModal();
  }

  async function connect(candidate) {
    if (loading) return false;
    setLoading(true); setConnectError('');
    try {
      const data = await postJson('/api/connect', { key: candidate });
      setTeam(data.team); setKey(candidate);
      connectionDialog.current?.close();
      return true;
    } catch (error) {
      setConnectError(error.message);
      showConnection();
      return false;
    } finally { setLoading(false); }
  }

  // Try SIM_API_KEY from .env on load so a configured key never requires
  // opening the dialog by hand. A ref guards this (rather than an empty
  // dependency array alone) because StrictMode intentionally double-invokes
  // effects in development, which would otherwise fire /api/connect twice.
  useEffect(() => {
    if (autoConnectStarted.current) return;
    autoConnectStarted.current = true;
    connect('').finally(() => setConnecting(false));
  }, []);

  async function runSweep() {
    setSweepLoading(true); setSweepError(''); setSweepResults(null);
    try {
      const data = await postJson('/api/sweep', { key });
      setSweepResults(data.results);
    } catch (error) {
      setSweepError(error.message);
    } finally { setSweepLoading(false); }
  }

  async function runCheck(event) {
    event.preventDefault();
    const patientId = patientIdInput.trim();
    if (!patientId) return;
    setCheckLoading(true); setCheckError(''); setResult(null);
    try {
      const data = await postJson('/api/check', { key, patientId });
      setResult(data);
    } catch (error) {
      setCheckError(error.message);
    } finally { setCheckLoading(false); }
  }

  // Reflect a freshly confirmed booking in the list below immediately,
  // rather than re-running the whole check against NHS-SIM again.
  function handleBooked(booking) {
    setResult((prev) => (prev ? { ...prev, bookings: [...prev.bookings, booking] } : prev));
  }

  return <>
    <Sidebar activePage={activePage} onPageChange={setActivePage} />
    <main>
      <header><div className="breadcrumb">Careloop</div><button className="button" onClick={showConnection}>{team ? `Connected · ${team.world}` : connecting ? 'Connecting…' : 'Connect simulator ↗'}</button></header>
      <section className="heading"><div><div className="eyebrow">DISCHARGE → HOME VISIT</div><h1>Does this patient need a home visit booked?</h1><p>Reads the discharge note, decides if a home visit is needed, and books it in NHS-SIM once you confirm.</p></div></section>
      {!team && <div className="notice" role="status">{connecting ? 'Connecting to NHS-SIM…' : 'Not connected. Connect your NHS-SIM team to run a check.'}</div>}

      {activePage === 'sweep' && <section className="worklist">
        <div className="section-title"><div><h2>Full sweep</h2><p>Check all discharge summaries for care gaps in one run.</p></div></div>
        <div className="controls">
          <button className="button primary" disabled={!team || sweepLoading} onClick={runSweep}>{sweepLoading ? 'Running sweep…' : 'Run full sweep'}</button>
        </div>
        {sweepError && <div className="error-text" role="alert" style={{ padding: '0 22px 16px' }}>{sweepError}</div>}
        {sweepResults && <div style={{ padding: '0 22px 24px' }}><SweepResults results={sweepResults} /></div>}
        {!sweepResults && !sweepError && <div className="empty">{sweepLoading ? 'Checking discharge summaries. This can take several minutes; results appear when all checks finish.' : team ? 'Click "Run full sweep" to check all discharge summaries.' : 'Connect your NHS-SIM team first.'}</div>}
      </section>}

      {activePage === 'check' && <section className="worklist">
        <div className="section-title"><div><h2>Check a patient</h2><p>Looks up the latest hospital discharge summary for this patient ID.</p></div></div>
        <div className="controls">
          <form className="filters" onSubmit={runCheck} style={{ width: '100%' }}>
            <input type="text" value={patientIdInput} onChange={(event) => setPatientIdInput(event.target.value)} placeholder="Patient ID, e.g. SIM-000001" aria-label="Patient ID" style={{ minWidth: 220 }} />
            <button className="button primary" disabled={!team || checkLoading}>{checkLoading ? 'Checking…' : 'Run check'}</button>
          </form>
        </div>
        {checkError && <div className="error-text" role="alert" style={{ padding: '0 22px 16px' }}>{checkError}</div>}
        {result && <div style={{ padding: '0 22px 24px' }}><ResultDetail result={result} onBooked={handleBooked} /></div>}
        {!result && !checkError && <div className="empty">{team ? 'Enter a patient ID above and run a check.' : 'Connect your NHS-SIM team first.'}</div>}
      </section>}

      <p className="footnote">NHS-SIM synthetic data · Careloop only ever writes to NHS-SIM when you explicitly confirm a drafted home-visit booking — every other read stays read-only. A flag is a starting point for a human check, not a confirmed care omission.</p>
    </main>
    <ConnectionDialog dialogRef={connectionDialog} loading={loading} error={connectError} onConnect={connect} />
  </>;
}
