import { memo, useCallback, useEffect, useState } from 'react'
import Scene from './Scene.jsx'
import { useDark, THEMES } from './theme.js'
import { sim, workerById, PICKERS, RUNNERS, queued } from './sim.js'
import { pickFaces, byId, bulkBays, DOCKS, dockById, OPT, WEEK_REPL, WINS, TOUR, VIEWS, SIZES } from './data.js'

const MemoScene = memo(Scene)
const pad = (n) => String(n).padStart(2, '0')
const MODES = [['fill', 'Fill'], ['heat', 'Pick heat'], ['repl', 'Replenishment'], ['slot', 'Slot fit']]
const VIEW_BTNS = [['overview', 'Overview'], ['top', 'Top'], ['pick', 'Pick zone'], ['bulk', 'Bulk zone'], ['docks', 'Docks']]
const HINTS = {
  fill: 'Block height is how full a pick face is. Bulk cartons show pallets per bay. Beacons mark faces waiting for replenishment: orange waiting, blue runner on the way.',
  heat: 'Bars above the pick faces show daily demand. Tall bars far from the outbound wall (west) are walking time you pay for.',
  repl: 'Bars above the pick faces show replenishment tasks in the last 7 days. Tall bars are faces that run empty often.',
  slot: 'Orange cones: this item needs a bigger slot (it empties at least 2.5 times a day). Blue cones: slot larger than needed.',
}
const LEG = {
  fill: ['0%', '100%', 'face fill'], heat: ['0', '160', 'units picked per day'], repl: ['0', '42+', 'replenishment tasks, 7 days'],
}

function useTick(ms) {
  const [, set] = useState(0)
  useEffect(() => { const i = setInterval(() => set((v) => v + 1), ms); return () => clearInterval(i) }, [ms])
}

function alertsNow() {
  const out = [], so = pickFaces.filter((f) => f.qty === 0), q = queued()
  if (so.length) out.push({ sev: 'crit', t: `${so.length} pick face${so.length > 1 ? 's' : ''} empty`, d: `${so.slice(0, 3).map((f) => f.id).join(', ')}: pickers skip these lines until a runner arrives`, tg: { type: 'pick', id: so[0].id } })
  if (q >= 4) out.push({ sev: 'warn', t: `${q} replenishment tasks waiting`, d: `All ${RUNNERS} runners are busy. A sixth runner at peak would clear it.`, tg: null })
  out.push({ sev: 'warn', t: 'Truck waiting at IN-2', d: '38 min past appointment, TR-5107', tg: { type: 'dock', id: 'IN-2' } })
  out.push({ sev: 'info', t: `${OPT.up.length} items need a bigger slot`, d: `Saves about ${OPT.saved} replenishment tasks per week`, tg: { type: 'pick', id: OPT.up[0].id }, win: 0 })
  return out
}

const Row = ({ k, children }) => (<><dt>{k}</dt><dd>{children}</dd></>)

function Inspector({ sel }) {
  if (sel.type === 'pick') {
    const f = byId[sel.id], pct = Math.round((f.qty / f.cap) * 100)
    return (<>
      <div className="insp-head"><b>{f.id}</b><span className="chip" style={{ color: 'var(--accent)' }}>Pick face</span>
        {f.qty === 0 ? <span className="chip crit">Empty</span> : f.task ? <span className="chip warnc">{f.task.st === 'queued' ? 'Replen waiting' : 'Runner on the way'}</span> : null}</div>
      <dl>
        <Row k="Product">{f.prod}</Row>
        <Row k="SKU"><span className="num">{f.sku}</span></Row>
        <Row k="Stock"><span className="num">{f.qty} / {f.cap} units ({pct}%)</span></Row>
        <Row k="Slot size"><span className="num">{f.size}, {f.cap} units</span></Row>
        <Row k="Replen trigger"><span className="num">at {f.min} units</span></Row>
        <Row k="Demand"><span className="num">{f.demand} units/day</span></Row>
        <Row k="Empties"><span className="num">{f.fills.toFixed(1)} times/day</span></Row>
        <Row k="Replen tasks"><span className="num">{f.repl7} last 7 days, {f.replToday} today</span></Row>
        <Row k="Reserve bay"><span className="num">{f.reserve}</span></Row>
        <Row k="Bigger slot?">{f.fit === 'up'
          ? <b className="warnc">Yes, {f.size} to {f.nextSize}. Saves about {f.saved} tasks/week</b>
          : f.fit === 'down' ? <span>No. Slot is larger than needed</span> : <span>No</span>}</Row>
      </dl></>)
  }
  if (sel.type === 'bulk') {
    const b = byId[sel.id], feeds = pickFaces.filter((f) => f.reserve === b.id)
    return (<>
      <div className="insp-head"><b>{b.id}</b><span className="chip" style={{ color: 'var(--muted)' }}>Bulk bay</span></div>
      <dl>
        <Row k="Product">{b.prod}</Row><Row k="SKU"><span className="num">{b.sku}</span></Row>
        <Row k="Pallets"><span className="num">{b.levels} / 4</span></Row>
        <Row k="Feeds pick faces">{feeds.length ? <span className="num">{feeds.map((f) => f.id).join(', ')}</span> : 'None right now'}</Row>
      </dl></>)
  }
  if (sel.type === 'worker') {
    const w = workerById[sel.id], run = w.role === 'runner'
    return (<>
      <div className="insp-head"><b>{w.id}</b><span className="chip infoc">{run ? 'Bulk runner' : 'Order picker'}</span></div>
      <dl>
        <Row k="Doing">{w.status}</Row>
        <Row k="Speed"><span className="num">{w.path.length ? (w.speed * 3.6).toFixed(1) : '0.0'} km/h</span></Row>
        {run ? <Row k="Replenishments"><span className="num">{w.trips} this shift</span></Row>
          : <><Row k="Order lines"><span className="num">{w.lines} this shift</span></Row><Row k="Orders"><span className="num">{w.orders}</span></Row></>}
        {run && <Row k="Carrying">{w.carrying ? `1 pallet to ${w.task.face}` : 'Nothing'}</Row>}
        <Row k="Position"><span className="num">{w.x.toFixed(1)} m, {w.y.toFixed(1)} m</span></Row>
      </dl></>)
  }
  const d = dockById[sel.id]
  return (<>
    <div className="insp-head"><b>{d.id}</b><span className={'chip ' + (d.cls === 'ok' ? 'okc' : d.cls === 'warn' ? 'warnc' : '')}>{d.st}</span></div>
    <dl>
      <Row k="Direction">{d.id.startsWith('IN') ? 'Inbound' : 'Outbound'}</Row>
      {d.truck && <><Row k="Truck"><span className="num">{d.tr}</span></Row><Row k="Carrier">{d.car}</Row><Row k="Pallets"><span className="num">{d.p}</span></Row></>}
      <Row k="Note">{d.note}</Row>
    </dl></>)
}

export default function App() {
  const dark = useDark()
  const T = THEMES[dark ? 'dark' : 'light']
  const [mode, setMode] = useState('fill')
  const [sel, setSel] = useState({ type: 'pick', id: OPT.up[0].id })
  const [focus, setFocus] = useState(null)
  const [hover, setHover] = useState(null)
  const [view, setView] = useState({ name: 'overview', n: 0 })
  const [follow, setFollow] = useState(null)
  const [override, setOverride] = useState(null)
  const [tourI, setTourI] = useState(-1)
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState(1)
  useTick(500)

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  useEffect(() => { sim.paused = paused }, [paused])
  useEffect(() => { sim.speed = speed }, [speed])

  const goView = (name) => { setFollow(null); setView((v) => ({ name, n: v.n + 1 })) }
  const pick = useCallback((t) => { setSel(t); setFocus(null); setOverride(null) }, [])
  const apply = (o) => {
    setMode(o.mode); setSel(o.sel); setFocus(o.focus || null); setOverride(o.note || null)
    if (o.follow) setFollow(o.follow); else setFollow(null)
    setView((v) => ({ name: o.view || 'overview', n: v.n + 1 }))
  }
  const goTour = (i) => { if (i < 0 || i >= TOUR.length) { setTourI(-1); setFocus(null); setFollow(null); return } setTourI(i); apply(TOUR[i]) }

  const s = sim.stats, open = sim.tasks.length, waiting = queued()
  const busyRunners = sim.workers.filter((w) => w.role === 'runner' && w.state !== 'idle').length
  const sec = 14 * 3600 + 32 * 60 + Math.floor(sim.t)
  const alerts = alertsNow()
  const leg = LEG[mode]
  const stops = T[mode === 'fill' ? 'stock' : mode]

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
            <path d="M17 3 30 10.5v13L17 31 4 23.5v-13L17 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M4 10.5 17 18l13-7.5M17 18v13" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <div>
            <h1>Hub 07 Venlo<span className="badge">Mock-up · simulated data</span></h1>
            <p className="sub">Warehouse digital twin · bulk and pick in one hall · {PICKERS} pickers, {RUNNERS} bulk runners</p>
          </div>
        </div>
        <div className="ctrl">
          <span className="clock">Thu 8 Oct · <b>{pad(Math.floor(sec / 3600) % 24)}:{pad(Math.floor(sec / 60) % 60)}:{pad(sec % 60)}</b> · Shift 2</span>
          <div className="seg" role="group" aria-label="Simulation speed">
            {[1, 4].map((v) => <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v}×</button>)}
          </div>
          <div className="seg"><button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button></div>
        </div>
      </header>

      <div className="grid">
        <section className="main" aria-label="Warehouse 3D view">
          <div className="card tour">
            {tourI < 0 ? (<>
              <div className="txt"><h2>Guided tour</h2><p>Six steps through the hall: zones, bulk, pick, a replenishment run, pick heat and slot sizes.</p></div>
              <div className="btns"><button type="button" className="btn primary" onClick={() => goTour(0)}>Start tour</button></div>
            </>) : (<>
              <div className="txt"><h2>{tourI + 1} of {TOUR.length} · {TOUR[tourI].t}</h2><p>{TOUR[tourI].x}</p></div>
              <div className="btns">
                <button type="button" className="btn" disabled={tourI === 0} onClick={() => goTour(tourI - 1)}>Back</button>
                <button type="button" className="btn primary" onClick={() => goTour(tourI + 1)}>{tourI === TOUR.length - 1 ? 'Finish' : 'Next'}</button>
              </div>
            </>)}
          </div>

          <div className="bar">
            <div className="seg" role="group" aria-label="Map layer">
              {MODES.map(([m, l]) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setOverride(null) }}>{l}</button>)}
            </div>
            <div className="legend">
              {leg ? (<><span>{leg[0]}</span><i style={{ background: `linear-gradient(90deg,${stops.join(',')})` }} /><span>{leg[1]}</span><span>{leg[2]}</span></>)
                : (<><span className="sw" style={{ background: T.slot.up }} />Bigger slot: yes<span className="sw" style={{ background: T.slot.down }} />Larger than needed<span className="sw" style={{ background: T.slot.ok }} />No</>)}
            </div>
          </div>

          <div className="bar">
            <div className="seg" role="group" aria-label="Camera">
              {VIEW_BTNS.map(([v, l]) => <button key={v} type="button" aria-pressed={!follow && view.name === v} onClick={() => goView(v)}>{l}</button>)}
            </div>
            {follow && <button type="button" className="btn" onClick={() => setFollow(null)}>Stop following {follow}</button>}
          </div>

          <div className="stage">
            <MemoScene dark={dark} mode={mode} sel={sel} focus={focus} hover={hover} setHover={setHover} onPick={pick} view={view} follow={follow} views={VIEWS} />
          </div>
          <p className="hint">{override || HINTS[mode]} Drag to orbit, scroll to zoom, right-drag to pan. Click a face, bay or person to inspect.</p>
        </section>

        <aside className="side">
          <div className="card">
            <h2>Replenishment right now</h2>
            <div className="kpis">
              <div className="kpi"><span>Tasks today</span><b>{s.replToday}</b> <small>{WEEK_REPL} last 7 days</small></div>
              <div className="kpi"><span>Open tasks</span><b>{open}</b> <small>{waiting} waiting</small></div>
              <div className="kpi"><span>Avg replen time</span><b>{Math.round(s.cycleAvg)} s</b> <small>task to full face</small></div>
              <div className="kpi"><span>Empty-face hits</span><b>{s.stockouts}</b> <small>lines skipped today</small></div>
              <div className="kpi"><span>Pickers</span><b>{PICKERS}</b> <small>{s.picksToday} lines today</small></div>
              <div className="kpi"><span>Bulk runners</span><b>{busyRunners} / {RUNNERS}</b> <small>busy</small></div>
            </div>
            <div className="tasks">
              {sim.tasks.slice(0, 5).map((t) => (
                <button key={t.id} type="button" className="task" onClick={() => pick({ type: 'pick', id: t.face })}>
                  <span className="num">{t.id}</span><span className="num">{t.from} → {t.face}</span>
                  <span className={t.st === 'queued' ? 'warnc' : 'infoc'}>{t.st === 'queued' ? 'Waiting' : t.runner}</span>
                </button>))}
              {sim.tasks.length === 0 && <p className="note">No open tasks.</p>}
              {sim.log.slice(0, 3).map((l) => (
                <div key={l.id} className="task done"><span className="num">{l.id}</span><span className="num">{l.from} → {l.face}</span><span className="okc">Done {Math.round(l.cycle)} s</span></div>))}
            </div>
          </div>

          <div className="card">
            <h2>Bigger slot: yes or no</h2>
            <p className="big"><b className="warnc">{OPT.up.length} of {pickFaces.length}</b> pick faces: yes. Saves about <b>{OPT.saved}</b> replenishment tasks per week.</p>
            <p className="note" style={{ marginTop: 0 }}>A face qualifies when it empties 2.5 times a day or more and a bigger slot exists. {OPT.down.length} faces could shrink instead.</p>
            <table className="opt">
              <thead><tr><th>Face</th><th>Size</th><th>Empties/day</th><th>Saves/wk</th></tr></thead>
              <tbody>
                {OPT.up.slice(0, 6).map((f) => (
                  <tr key={f.id} onClick={() => apply({ mode: 'slot', sel: { type: 'pick', id: f.id }, focus: OPT.up.map((x) => x.id), view: 'pick' })}>
                    <td><button type="button">{f.id}</button></td><td className="num">{f.size} → {f.nextSize}</td><td className="num">{f.fills.toFixed(1)}</td><td className="num">{f.saved}</td>
                  </tr>))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Quick wins</h2>
            <div className="wins">
              {WINS.map((w, i) => <button key={i} type="button" className="win" onClick={() => apply(w)}><strong>{w.t}</strong><small>{w.d}</small></button>)}
            </div>
            <p className="note">Click one to see where on the floor. Gains are rough estimates from simulated data.</p>
          </div>

          <div className="card">
            <h2>Alerts</h2>
            <div className="alerts">
              {alerts.map((a, i) => {
                const l = { crit: ['▲ Critical', 'crit'], warn: ['◆ Warning', 'warnc'], info: ['● Info', 'infoc'] }[a.sev]
                return (<button key={i} type="button" className="alert" disabled={!a.tg} onClick={() => (a.win != null ? apply(WINS[a.win]) : pick(a.tg))}>
                  <span className={'sev ' + l[1]}>{l[0]}</span><strong>{a.t}</strong><small>{a.d}</small></button>)
              })}
            </div>
          </div>

          <div className="card"><h2>Inspector</h2><Inspector sel={sel} /></div>

          <div className="card">
            <h2>Dock doors</h2>
            <div className="docks">
              {DOCKS.map((d) => (
                <button key={d.id} type="button" className="dock" aria-current={sel.type === 'dock' && sel.id === d.id} onClick={() => { pick({ type: 'dock', id: d.id }); goView('docks') }}>
                  <b>{d.id}</b><span className={d.cls === 'ok' ? 'okc' : d.cls === 'warn' ? 'warnc' : ''}><i />{d.st}</span>
                </button>))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
