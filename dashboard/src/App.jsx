import { useEffect, useMemo, useRef, useState } from 'react';
import { aggregate, sites } from './model.js';

const names = { gp: 'GP practice', pharmacy: 'Pharmacy', community: 'Community care' };
const icons = { gp: '✚', pharmacy: '↗', community: '⌂' };
const demoNow = Date.UTC(2026, 8, 12, 12);
const patientNames = ['Margaret Wilson', 'James Bennett', 'Aisha Patel', 'Robert Clarke', 'Eleanor Hughes', 'David Thompson', 'Sarah O’Neill', 'Peter Evans'];
const demoPatients = patientNames.map((name, index) => ({ id: `SIM-${String(index + 1).padStart(6, '0')}`, name }));
const examples = [
  ['pharmacy', 'Repeat prescription · Amlodipine', 'awaiting-stock', 0, -26, 'prescription'],
  ['community', 'Post-discharge home visit', 'scheduled', 1, -19, 'visit'],
  ['gp', 'Medication review following discharge', 'pending', 2, -8, 'task'],
  ['pharmacy', 'Prescription ready for collection', 'ready', 3, -4, 'prescription'],
  ['community', 'Wound dressing visit', 'unassigned', 4, 3, 'visit'],
  ['gp', 'Blood test follow-up', 'pending', 5, 5, 'task'],
  ['pharmacy', 'Repeat prescription request', 'received', 6, 9, 'prescription'],
  ['community', 'Mobility assessment', 'awaiting-booking', 7, null, 'referral'],
  ['gp', 'Review community care update', 'pending', 1, 24, 'task'],
  ['gp', 'Repeat prescription authorised', 'completed', 0, -32, 'task'],
  ['community', 'Discharge handover received', 'completed', 2, -24, 'handover'],
  ['pharmacy', 'Antibiotic prescription', 'collected', 5, -18, 'prescription'],
];
const demoSources = sites.map(site => ({
  site,
  now: demoNow,
  patients: demoPatients,
  resources: examples.flatMap(([owner, title, status, patient, offset, kind], index) => owner === site ? [{
    id: `DEMO-${index}`, patientId: demoPatients[patient].id, title, status, owner, kind, version: 1,
    createdAt: demoNow - 72 * 3600000, ...(offset === null ? {} : { dueAt: demoNow + offset * 3600000 }),
    priority: index < 3 ? 'urgent' : 'routine', data: { note: 'Illustrative sample record, not fetched from your simulator.' }, visibleTo: [owner],
  }] : []),
}));

function formatDate(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
}

function recordStatus(record) {
  return record.done ? 'Completed' : record.overdue ? 'Overdue' : record.blocked ? 'Blocked' : record.attention ? 'Review needed' : 'Pending';
}

function dueLabel(record, now) {
  if (!record.dueAt) return 'No due time';
  const hours = Math.abs(record.dueAt - now) / 3600000;
  const duration = hours >= 24 ? `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h` : `${Math.max(1, Math.floor(hours))}h`;
  return record.done ? 'Closed' : record.overdue ? `${duration} overdue` : `In ${duration}`;
}

function readFlags(namespace) {
  try {
    const value = JSON.parse(localStorage.getItem(`careloop:flags:${namespace}`) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? [value, false] : [{}, false];
  } catch {
    return [{}, true];
  }
}

function Sidebar({ view, setView, attentionCount }) {
  return <aside className="sidebar">
    <a className="brand" href="/"><span className="brandmark">c</span> careloop<span className="branddot">●</span></a>
    <div className="workspace">NEIGHBOURHOOD WORKSPACE</div>
    <nav aria-label="Main navigation">
      <button className={`nav ${view === 'all' ? 'active' : ''}`} onClick={() => setView('all')}><span>▦</span> Care overview</button>
      <button className={`nav ${view === 'attention' ? 'active' : ''}`} onClick={() => setView('attention')}><span>◷</span> Needs attention <b>{attentionCount}</b></button>
      <button className={`nav ${view === 'flagged' ? 'active' : ''}`} onClick={() => setView('flagged')}><span>⚑</span> My flagged items</button>
    </nav>
    <div className="sidebar-note"><span className="connection-dot" /> One patient. One picture.<p>Connecting the gaps between services.</p></div>
    <div className="profile"><div className="avatar">CC</div><div>Care coordinator<small>Local workspace</small></div></div>
  </aside>;
}

function ConnectionDialog({ dialogRef, loading, error, onConnect }) {
  const [candidate, setCandidate] = useState('');
  return <dialog ref={dialogRef}>
    <form onSubmit={event => { event.preventDefault(); onConnect(candidate.trim()).then(ok => ok && setCandidate('')); }}>
      <div className="dialog-top"><h2>Connect your team</h2><button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">×</button></div>
      <p>Use the team API key from <a href="https://sim.animahacks.com/control/" target="_blank" rel="noreferrer">NHS-SIM → Team &amp; API key</a>. Your OpenAI key is separate.</p>
      <label htmlFor="key">Simulator team API key</label>
      <input id="key" type="password" autoComplete="off" value={candidate} onChange={event => setCandidate(event.target.value)} placeholder="Paste team key, or use SIM_API_KEY from .env" />
      <p className="hint">The key is kept in memory for this session and sent only through the local server to NHS-SIM.</p>
      <div id="connect-error" role="alert">{error}</div>
      <button className="button primary" disabled={loading}>{loading ? 'Connecting…' : 'Connect workspace'}</button>
    </form>
  </dialog>;
}

function DetailDialog({ dialogRef, record, patient, related, flags, onToggleFlag, onSaveNote, now }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(record ? flags[record.id]?.note || '' : ''), [record, flags]);
  if (!record) return <dialog ref={dialogRef} />;
  return <dialog ref={dialogRef} id="detail"><div>
    <div className="dialog-top"><div><div className="eyebrow">PATIENT CARE THREAD</div><h2>{patient?.name || record.patientId}</h2><p>{record.patientId}</p></div><button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close patient details">×</button></div>
    <h3>{record.title}</h3>
    <div className="detail-alert">{record.reason}<small>Source status: {record.status} · {names[record.owner] || record.owner}</small></div>
    <dl><div><dt>Created</dt><dd>{formatDate(record.createdAt)}</dd></div><div><dt>Due</dt><dd>{formatDate(record.dueAt)}</dd></div><div><dt>Source record</dt><dd>{record.id} · v{record.version}</dd></div><div><dt>Seen in</dt><dd>{record.seenIn.map(site => names[site]).join(', ')}</dd></div></dl>
    <h3>Your follow-up</h3><label htmlFor="note">Review note (saved in this browser)</label>
    <textarea id="note" rows="3" value={note} onChange={event => setNote(event.target.value)} placeholder="What needs chasing, and who should follow up?" />
    <div className="detail-actions"><button className="button primary" onClick={() => onSaveNote(record.id, note)}>Save note &amp; flag</button><button className="button" onClick={() => onToggleFlag(record.id)}>{flags[record.id] ? 'Remove flag' : 'Flag for follow-up'}</button></div>
    <h3>Across this patient’s services</h3><p className="hint">Records are linked by exact patient ID. This thread does not prove a handoff was completed.</p>
    <div className="timeline">{related.map(item => <button key={item.id} onClick={() => window.dispatchEvent(new CustomEvent('careloop:detail', { detail: item.id }))}><span className={`timeline-dot ${item.done ? 'done' : ''}`} /><strong>{item.title}</strong><small>{names[item.owner] || item.owner} · {item.status} · {formatDate(item.createdAt)}</small></button>)}</div>
    <details><summary>Inspect source payload</summary><pre>{JSON.stringify(record.data, null, 2)}</pre></details>
  </div></dialog>;
}

export default function App() {
  const [view, setView] = useState('all');
  const [service, setService] = useState('all');
  const [search, setSearch] = useState('');
  const [sources, setSources] = useState(demoSources);
  const [now, setNow] = useState(demoNow);
  const [live, setLive] = useState(false);
  const [namespace, setNamespace] = useState('demo');
  const [key, setKey] = useState('');
  const [flags, setFlags] = useState(() => readFlags('demo')[0]);
  const [storageWarning, setStorageWarning] = useState(() => readFlags('demo')[1]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [connectError, setConnectError] = useState('');
  const connectionDialog = useRef(null);
  const detailDialog = useRef(null);

  const records = useMemo(() => aggregate(sources, now), [sources, now]);
  const patientMap = useMemo(() => new Map(sources.flatMap(source => source.patients || []).map(patient => [patient.id, patient])), [sources]);
  const pending = records.filter(record => !record.done);
  const attention = pending.filter(record => record.attention);
  const overdue = pending.filter(record => record.overdue);
  const flagged = records.filter(record => flags[record.id]);
  const selected = records.find(record => record.id === selectedId);
  const related = selected ? records.filter(record => record.patientId === selected.patientId).sort((a, b) => a.createdAt - b.createdAt) : [];
  const filtered = records.filter(record =>
    (view === 'flagged' ? flags[record.id] : view === 'complete' ? record.done : view === 'attention' ? record.attention : view === 'overdue' ? record.overdue : !record.done)
    && (service === 'all' || record.seenIn.includes(service))
    && `${patientMap.get(record.patientId)?.name || ''} ${record.patientId} ${record.title} ${record.status}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => {
    const openDetail = event => { setSelectedId(event.detail); detailDialog.current?.showModal(); };
    window.addEventListener('careloop:detail', openDetail);
    return () => window.removeEventListener('careloop:detail', openDetail);
  }, []);

  function persistFlags(next) {
    setFlags(next);
    try { localStorage.setItem(`careloop:flags:${namespace}`, JSON.stringify(next)); }
    catch { setStorageWarning(true); }
  }

  function toggleFlag(id) {
    const next = { ...flags };
    if (next[id]) delete next[id]; else next[id] = { note: '', at: Date.now() };
    persistFlags(next);
  }

  async function connect(candidate) {
    if (loading) return false;
    setLoading(true); setConnectError('');
    try {
      const response = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: candidate }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Connection failed.');
      if (data.sources.every(source => source.error)) throw new Error(data.sources.map(source => `${names[source.site]}: ${source.error}`).join(' '));
      const simulatorNow = Math.max(...data.sources.filter(source => !source.error).map(source => source.now));
      if (!Number.isFinite(simulatorNow)) throw new Error('Simulator clock missing. Cannot determine overdue records.');
      const [savedFlags, warning] = readFlags(data.team.world);
      setSources(data.sources); setNow(simulatorNow); setKey(candidate); setNamespace(data.team.world); setLive(true); setFlags(savedFlags); setStorageWarning(warning);
      connectionDialog.current?.close();
      return true;
    } catch (error) {
      setConnectError(error.message);
      connectionDialog.current?.showModal();
      return false;
    } finally { setLoading(false); }
  }

  const metrics = [
    ['Pending items', pending.length, 'Across all three services', 'all'],
    ['Needs attention', attention.length, 'Potential gaps to review', 'attention'],
    ['Past due', overdue.length, 'Beyond recorded due time', 'overdue'],
    ['Flagged by you', flagged.length, 'Your follow-up shortlist', 'flagged'],
  ];

  return <>
    <Sidebar view={view} setView={setView} attentionCount={attention.length} />
    <main>
      <header><div className="breadcrumb">Workspace <span>/</span> Care overview</div><button className="button" onClick={() => connectionDialog.current?.showModal()}>{live ? 'Connected · change key' : 'Connect simulator ↗'}</button></header>
      <section className="heading"><div><div className="eyebrow">CONTINUITY OF CARE</div><h1>Nothing slips through.</h1><p>One place to spot pending care and close the loop.</p></div><button className="button" disabled={loading} onClick={() => live ? connect(key) : connectionDialog.current?.showModal()}>{loading ? '↻ Syncing…' : '↻ Refresh data'}</button></section>
      <div className="notice" role="status">{live ? <><span className="connection-dot" /> Connected to <strong>{namespace}</strong> · Simulator time {formatDate(now)}{sources.some(source => source.error || source.truncated) && <> · <strong>Partial data — check service status below</strong></>}</> : <><span className="demo-pill">DEMO</span> Exploring sample data. Connect your NHS-SIM team to see your own care records.</>}{storageWarning && ' · Browser storage unavailable; flags may not persist.'}</div>
      <section className="metrics" aria-label="Worklist summary">{metrics.map(([label, count, subtitle, metricView], index) => <button key={label} className={`metric m${index} ${view === metricView ? 'selected' : ''}`} onClick={() => setView(metricView)}><span>{label}<b>{['↗', '◷', '!', '⚑'][index]}</b></span><strong>{count}</strong><small>{subtitle}</small></button>)}</section>
      <section className="sources" aria-label="Service sources">{sources.map(source => <button key={source.site} className={`source ${service === source.site ? 'chosen' : ''}`} onClick={() => setService(service === source.site ? 'all' : source.site)}><span className={`source-icon ${source.site}`}>{icons[source.site]}</span><div><strong>{names[source.site]}</strong><small>{source.error || `${pending.filter(record => record.seenIn.includes(source.site)).length} pending · ${live ? source.truncated ? `Latest ${source.resources.length} of ${source.resourceTotal}` : 'Synced' : 'Sample data'}`}</small></div><span className={`source-status ${source.error ? 'failed' : ''}`}>{source.error ? '!' : '●'}</span></button>)}</section>
      <section className="worklist">
        <div className="section-title"><div><h2>Care worklist <span>{filtered.length}</span></h2><p>Follow the handoff. Find what needs a nudge.</p></div><div className="legend"><i /> Potential gap, for review</div></div>
        <div className="controls"><div className="tabs" role="group" aria-label="Worklist status">{[['all', 'All pending'], ['attention', 'Needs attention'], ['flagged', 'Flagged'], ['complete', 'Completed']].map(([value, label]) => <button key={value} className={view === value ? 'selected' : ''} onClick={() => setView(value)}>{label}</button>)}</div><div className="filters"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search patient or task…" aria-label="Search patient or task" /><select value={service} onChange={event => setService(event.target.value)} aria-label="Filter service"><option value="all">All services</option>{sites.map(site => <option key={site} value={site}>{names[site]}</option>)}</select></div></div>
        <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Task &amp; handoff</th><th>Service</th><th>Status</th><th>Due</th><th><span className="sr-only">Review</span></th></tr></thead><tbody>{filtered.map(record => { const patient = patientMap.get(record.patientId); const name = patient?.name || record.patientId; const initials = name.split(' ').slice(0, 2).map(part => part[0]).join(''); return <tr key={record.id}><td><button className="patient-button" onClick={() => { setSelectedId(record.id); detailDialog.current?.showModal(); }}><span className="avatar">{initials}</span><span><strong>{name}</strong><small>{record.patientId}</small></span></button></td><td><button className="task-button" onClick={() => { setSelectedId(record.id); detailDialog.current?.showModal(); }}>{record.title}</button><small>{record.reason}</small></td><td><span className="service-label">{names[record.owner] || record.owner || 'Unassigned'}</span><small>{record.seenIn.length > 1 ? `Visible in ${record.seenIn.length} services` : record.kind.replaceAll('_', ' ')}</small></td><td><span className={`badge ${record.done ? 'green' : record.attention ? 'amber' : ''}`}>{recordStatus(record)}</span></td><td className={`due ${record.overdue ? 'late' : ''}`}>{dueLabel(record, now)}</td><td><button className={`flag ${flags[record.id] ? 'is-flagged' : ''}`} onClick={() => toggleFlag(record.id)} aria-label={`${flags[record.id] ? 'Unflag' : 'Flag'} ${record.title}`} aria-pressed={Boolean(flags[record.id])}>⚑</button></td></tr>; })}</tbody></table></div>
        {filtered.length === 0 && <div className="empty">No matching items.<p>Try a different filter or search.</p></div>}
        <footer className="table-footer"><span>Showing {filtered.length} of {records.length} patient-linked records</span><span>Flags are saved on this browser · source records stay unchanged</span></footer>
      </section>
      <p className="footnote">NHS-SIM synthetic data · Overdue uses the simulator clock. An open item without a due time is highlighted after 48 hours. These signals suggest review, not a confirmed care omission.</p>
    </main>
    <ConnectionDialog dialogRef={connectionDialog} loading={loading} error={connectError} onConnect={connect} />
    <DetailDialog dialogRef={detailDialog} record={selected} patient={selected && patientMap.get(selected.patientId)} related={related} flags={flags} now={now} onToggleFlag={toggleFlag} onSaveNote={(id, note) => persistFlags({ ...flags, [id]: { note, at: Date.now() } })} />
  </>;
}
