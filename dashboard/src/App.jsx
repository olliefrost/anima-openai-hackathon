import { useRef, useState } from 'react';

const STATUS_META = {
  ok: { label: 'Matches', className: 'green' },
  flag: { label: 'Flagged', className: 'red' },
  review: { label: 'Needs review', className: 'amber' },
  'no-discharge-summary': { label: 'No discharge summary', className: '' },
};
const STATUS_SCORE = { flag: 3, review: 2, ok: 1, 'no-discharge-summary': 0 };

function formatDate(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
}

function formatCareType(type) {
  if (!type) return 'None identified';
  return type.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

async function postJson(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, className: '' };
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

function Sidebar({ view, setView }) {
  return <aside className="sidebar">
    <a className="brand" href="/"><span className="brandmark">c</span> careloop<span className="branddot">●</span></a>
    <div className="workspace">DISCHARGE RECONCILIATION</div>
    <nav aria-label="Main navigation">
      <button className={`nav ${view === 'single' ? 'active' : ''}`} onClick={() => setView('single')}><span>◎</span> Check one patient</button>
      <button className={`nav ${view === 'sweep' ? 'active' : ''}`} onClick={() => setView('sweep')}><span>▦</span> Full sweep</button>
    </nav>
    <div className="sidebar-note"><span className="connection-dot" /> Discharge decision meets booked care.<p>Reads hospital, then checks community — never writes back.</p></div>
    <div className="profile"><div className="avatar">DR</div><div>Discharge reviewer<small>Local workspace</small></div></div>
  </aside>;
}

function ConnectionDialog({ dialogRef, loading, error, onConnect }) {
  const [candidate, setCandidate] = useState('');
  return <dialog ref={dialogRef}>
    <form onSubmit={(event) => { event.preventDefault(); onConnect(candidate.trim()).then((ok) => ok && setCandidate('')); }}>
      <div className="dialog-top"><h2>Connect your team</h2><button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">×</button></div>
      <p>Use the team API key from <a href="https://sim.animahacks.com/control/" target="_blank" rel="noreferrer">NHS-SIM → Team &amp; API key</a>. The care-decision agent uses a separate OpenAI key set on the server.</p>
      <label htmlFor="key">Simulator team API key</label>
      <input id="key" type="password" autoComplete="off" value={candidate} onChange={(event) => setCandidate(event.target.value)} placeholder="Paste team key, or use SIM_API_KEY from .env" />
      <p className="hint">The key is kept in memory for this session and sent only through the local server to NHS-SIM.</p>
      <div className="error-text" role="alert">{error}</div>
      <button className="button primary" disabled={loading}>{loading ? 'Connecting…' : 'Connect workspace'}</button>
    </form>
  </dialog>;
}

function DischargeSections({ sections }) {
  const entries = Object.entries(sections || {}).filter(([, value]) => value);
  if (entries.length === 0) return <p className="hint">No sections recorded on this discharge note.</p>;
  return <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}

function BookingsList({ bookings }) {
  if (bookings.length === 0) return <p className="hint">No community records found for this patient.</p>;
  return <div className="timeline">{bookings.map((booking) => <div key={booking.id}><span className={`timeline-dot ${booking.status === 'completed' ? 'done' : ''}`} /><strong>{booking.title || booking.kind}</strong><small>{booking.kind} · {booking.status} · {formatDate(booking.startsAt)}</small></div>)}</div>;
}

function ResultDetail({ result }) {
  if (result.status === 'no-discharge-summary') {
    return <div className="empty">No discharge summary found for {result.patientName || result.patientId} in Hospital EPR documents.</div>;
  }
  return <>
    <div className="detail-alert"><StatusBadge status={result.reconciliation.status} /> <span style={{ marginLeft: 8 }}>{result.reconciliation.reason}</span></div>
    <h3>Care decision</h3>
    <dl>
      <div><dt>Care needed</dt><dd>{result.decision.careNeeded ? 'Yes' : 'No'}</dd></div>
      <div><dt>Care type</dt><dd>{formatCareType(result.decision.careType)}</dd></div>
      <div><dt>Urgency</dt><dd>{result.decision.urgency || '—'}</dd></div>
      <div><dt>Confidence</dt><dd>{result.decision.confidence}</dd></div>
    </dl>
    <p className="hint">{result.decision.rationale}</p>
    <h3>Discharge note</h3>
    <p><strong>{result.dischargeSummary.title}</strong><br /><small>Sent {formatDate(result.dischargeSummary.sentAt ?? result.dischargeSummary.createdAt)} by {result.dischargeSummary.sentBy || 'unknown'}</small></p>
    <details><summary>Discharge note sections</summary><DischargeSections sections={result.dischargeSummary.sections} /></details>
    <h3>Booked community care</h3>
    <BookingsList bookings={result.bookings} />
  </>;
}

function DetailDialog({ dialogRef, result }) {
  if (!result) return <dialog ref={dialogRef} />;
  return <dialog ref={dialogRef} id="detail"><div>
    <div className="dialog-top"><div><div className="eyebrow">PATIENT CHECK</div><h2>{result.patientName || result.patientId}</h2><p>{result.patientId}</p></div><button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">×</button></div>
    <ResultDetail result={result} />
  </div></dialog>;
}

export default function App() {
  const [view, setView] = useState('single');
  const [team, setTeam] = useState(null);
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [connectError, setConnectError] = useState('');
  const connectionDialog = useRef(null);
  const detailDialog = useRef(null);

  const [patientIdInput, setPatientIdInput] = useState('');
  const [singleResult, setSingleResult] = useState(null);
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleError, setSingleError] = useState('');

  const [sweepResults, setSweepResults] = useState(null);
  const [sweepLoading, setSweepLoading] = useState(false);
  const [sweepError, setSweepError] = useState('');
  const [sweepCheckedAt, setSweepCheckedAt] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  function showConnection() {
    if (!connectionDialog.current?.open) connectionDialog.current?.showModal();
  }

  function showDetail(result) {
    setSelected(result);
    if (!detailDialog.current?.open) detailDialog.current?.showModal();
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

  async function runSingleCheck(event) {
    event.preventDefault();
    const patientId = patientIdInput.trim();
    if (!patientId) return;
    setSingleLoading(true); setSingleError(''); setSingleResult(null);
    try {
      const result = await postJson('/api/check', { key, patientId });
      setSingleResult(result);
    } catch (error) {
      setSingleError(error.message);
    } finally { setSingleLoading(false); }
  }

  async function runSweep() {
    setSweepLoading(true); setSweepError(''); setSweepResults(null);
    try {
      const data = await postJson('/api/sweep', { key });
      setSweepResults(data.results);
      setSweepCheckedAt(data.checkedAt);
    } catch (error) {
      setSweepError(error.message);
    } finally { setSweepLoading(false); }
  }

  const counts = sweepResults ? {
    all: sweepResults.length,
    flag: sweepResults.filter((r) => r.reconciliation.status === 'flag').length,
    review: sweepResults.filter((r) => r.reconciliation.status === 'review').length,
    ok: sweepResults.filter((r) => r.reconciliation.status === 'ok').length,
  } : { all: 0, flag: 0, review: 0, ok: 0 };

  const filteredSweep = (sweepResults || [])
    .filter((r) => statusFilter === 'all' || r.reconciliation.status === statusFilter)
    .filter((r) => `${r.patientName || ''} ${r.patientId}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => STATUS_SCORE[b.reconciliation.status] - STATUS_SCORE[a.reconciliation.status]);

  const metrics = [
    ['Checked', counts.all, 'Patients with a discharge summary', 'all'],
    ['Flagged', counts.flag, 'Needed care not matched to a booking', 'flag'],
    ['Needs review', counts.review, 'Ambiguous decision or match', 'review'],
    ['Matches', counts.ok, 'Booked care lines up', 'ok'],
  ];

  return <>
    <Sidebar view={view} setView={setView} />
    <main>
      <header><div className="breadcrumb">Workspace <span>/</span> {view === 'single' ? 'Check one patient' : 'Full sweep'}</div><button className="button" onClick={showConnection}>{team ? `Connected · ${team.world}` : 'Connect simulator ↗'}</button></header>
      <section className="heading"><div><div className="eyebrow">DISCHARGE → COMMUNITY CARE</div><h1>Did the right care get booked?</h1><p>Extracts the discharge decision, then checks it against what community services actually booked.</p></div></section>
      <div className="notice" role="status">{team ? <><span className="connection-dot" /> Connected to <strong>{team.world}</strong></> : 'Not connected. Connect your NHS-SIM team to run a check.'}</div>

      {view === 'single' && <section className="worklist">
        <div className="section-title"><div><h2>Check one patient</h2><p>Looks up the latest hospital discharge summary for this patient ID.</p></div></div>
        <div className="controls">
          <form className="filters" onSubmit={runSingleCheck} style={{ width: '100%' }}>
            <input type="text" value={patientIdInput} onChange={(event) => setPatientIdInput(event.target.value)} placeholder="Patient ID, e.g. SIM-000001" aria-label="Patient ID" style={{ minWidth: 220 }} />
            <button className="button primary" disabled={!team || singleLoading}>{singleLoading ? 'Checking…' : 'Run check'}</button>
          </form>
        </div>
        {singleError && <div className="error-text" role="alert" style={{ padding: '0 22px 16px' }}>{singleError}</div>}
        {singleResult && <div style={{ padding: '0 22px 24px' }}><ResultDetail result={singleResult} /></div>}
        {!singleResult && !singleError && <div className="empty">{team ? 'Enter a patient ID above and run a check.' : 'Connect your NHS-SIM team first.'}</div>}
      </section>}

      {view === 'sweep' && <>
        <section className="metrics" aria-label="Sweep summary">{metrics.map(([label, count, subtitle, filterValue], index) => <button key={label} className={`metric m${index} ${statusFilter === filterValue ? 'selected' : ''}`} onClick={() => setStatusFilter(filterValue)}><span>{label}</span><strong>{count}</strong><small>{subtitle}</small></button>)}</section>
        <section className="worklist">
          <div className="section-title"><div><h2>Full sweep <span>{filteredSweep.length}</span></h2><p>{sweepCheckedAt ? `Checked ${formatDate(sweepCheckedAt)}` : 'Runs a check for every patient with a hospital discharge summary.'}</p></div><button className="button primary" disabled={!team || sweepLoading} onClick={runSweep}>{sweepLoading ? 'Checking all patients…' : 'Run full sweep'}</button></div>
          <div className="controls"><div className="filters"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patient…" aria-label="Search patient" /></div></div>
          {sweepError && <div className="error-text" role="alert" style={{ padding: '0 22px 16px' }}>{sweepError}</div>}
          {sweepResults && <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Discharge note</th><th>Decision</th><th>Booked care</th><th>Status</th></tr></thead><tbody>{filteredSweep.map((result) => { const name = result.patientName || result.patientId; const initials = name.split(' ').slice(0, 2).map((part) => part[0]).join(''); return <tr key={result.patientId}><td><button className="patient-button" onClick={() => showDetail(result)}><span className="avatar">{initials}</span><span><strong>{name}</strong><small>{result.patientId}</small></span></button></td><td><button className="task-button" onClick={() => showDetail(result)}>{result.dischargeSummary.title}</button><small>{formatDate(result.dischargeSummary.sentAt ?? result.dischargeSummary.createdAt)}</small></td><td>{formatCareType(result.decision.careType)}<small>{result.decision.careNeeded ? `${result.decision.confidence} confidence` : 'No care needed'}</small></td><td>{result.bookings.length} record{result.bookings.length === 1 ? '' : 's'}</td><td><StatusBadge status={result.reconciliation.status} /></td></tr>; })}</tbody></table></div>}
          {sweepResults && filteredSweep.length === 0 && <div className="empty">No matching patients.<p>Try a different filter or search.</p></div>}
          {!sweepResults && !sweepError && <div className="empty">{team ? 'Run a full sweep to check every discharged patient.' : 'Connect your NHS-SIM team first.'}</div>}
        </section>
      </>}

      <p className="footnote">NHS-SIM synthetic data · This tool reads discharge notes and community bookings only — it never books, cancels, or edits records. Flags and reviews are a starting point for a human check, not a confirmed care omission.</p>
    </main>
    <ConnectionDialog dialogRef={connectionDialog} loading={loading} error={connectError} onConnect={connect} />
    <DetailDialog dialogRef={detailDialog} result={selected} />
  </>;
}
