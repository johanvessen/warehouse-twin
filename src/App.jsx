import { memo, useCallback, useEffect, useRef, useState } from 'react'
import Scene from './Scene.jsx'
import { useDark, THEMES } from './theme.js'
import { sim, workerById, PICKERS, RUNNERS, queued, dockStatus, truckSeconds, triggerReplen, upsizeFace, upsizeAll, moveTruckToFreeDock } from './sim.js'
import { pickFaces, bulkBays, byId, DOCKS, dockById, WEEK_REPL, WINS, TOUR, VIEWS, SITES, SITE, UPSIZED, computeOpt, toWorld } from './data.js'

const MemoScene = memo(Scene)
const pad = (n) => String(n).padStart(2, '0')
const clock = (t) => { const s = 14 * 3600 + 32 * 60 + Math.floor(t); return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` }
const MODES = [['fill', 'Fill'], ['heat', 'Pick heat'], ['repl', 'Replenishment'], ['slot', 'Slot fit']]
const VIEW_BTNS = [['overview', 'Overview'], ['top', 'Top'], ['pick', 'Pick'], ['bulk', 'Bulk'], ['docks', 'Docks'], ['yard', 'Yard']]
const VIEW_KEYS = ['overview', 'top', 'pick', 'bulk', 'docks', 'yard']
const HINTS = {
  fill: 'Block height is how full a pick face is. Beacons mark faces waiting for replenishment: orange waiting, blue a runner on the way.',
  heat: 'Bars show daily demand per pick face. Tall bars far from the outbound wall (west) are walking time you pay for.',
  repl: 'Bars show replenishment tasks per week. Tall bars are faces that run empty often.',
  slot: 'Orange cones: needs a bigger slot (empties at least 2.5 times a day). Blue cones: slot larger than needed.',
}
const LEG = { fill: ['0%', '100%', 'face fill'], heat: ['0', '160', 'units/day'], repl: ['0', '42+', 'tasks/week'] }

function useTick(ms) {
  const [n, set] = useState(0)
  useEffect(() => { const i = setInterval(() => set((v) => v + 1), ms); return () => clearInterval(i) }, [ms])
  return [n, () => set((v) => v + 1)]
}

function alertsNow() {
  const out = [], so = pickFaces.filter((f) => f.qty === 0), q = queued(), opt = computeOpt()
  const wait = sim.trucks.find((t) => t.st === 'waiting')
  if (so.length) out.push({ sev: 'crit', t: `${so.length} pick face${so.length > 1 ? 's' : ''} empty`, d: `${so.slice(0, 3).map((f) => f.id).join(', ')}: pickers skip these lines until a runner arrives`, tg: { type: 'pick', id: so[0].id } })
  if (q >= 4) out.push({ sev: 'warn', t: `${q} replenishment tasks waiting`, d: `All ${RUNNERS} runners are busy. A sixth runner at peak would clear it.`, tg: null })
  if (wait) out.push({ sev: 'warn', t: `Truck waiting at ${wait.dock}`, d: `${wait.id}, ${Math.round(wait.waited / 60)} min past appointment. Select it and move it to a free dock.`, tg: { type: 'truck', id: wait.id }, view: 'docks' })
  if (opt.up.length) out.push({ sev: 'info', t: `${opt.up.length} items need a bigger slot`, d: `Saves about ${opt.saved} replenishment tasks per week`, tg: { type: 'pick', id: opt.up[0].id }, win: 0 })
  return out
}

/* ---------- minimap ---------- */
const MW = 240, MH = 190, MX0 = -24, MY0 = -24, MSX = 94, MSY = 74
function Minimap({ T, sel, onJump }) {
  const ref = useRef()
  useEffect(() => {
    const c = ref.current, x = c.getContext('2d'), d = window.devicePixelRatio || 1
    c.width = MW * d; c.height = MH * d
    const px = (v) => ((v - MX0) / MSX) * MW, py = (v) => ((v - MY0) / MSY) * MH, sx = MW / MSX
    const rect = (a, b, w, h, col, al = 1) => { x.globalAlpha = al; x.fillStyle = col; x.fillRect(px(a), py(b), w * sx, h * sx); x.globalAlpha = 1 }
    function draw() {
      x.setTransform(d, 0, 0, d, 0, 0)
      x.fillStyle = T.yard; x.fillRect(0, 0, MW, MH)
      rect(-23, -20, 105, 6, T.road); rect(-20, -20, 6, 82, T.road)
      rect(0, 0, 60, 40, T.floor)
      rect(5, 4.5, 26, 33.5, T.pickZone, 0.14); rect(33, 4.5, 26.5, 33.5, T.bulkZone, 0.14); rect(30.4, 2, 3.2, 36, T.lane, 0.25); rect(0.4, 4, 3.2, 32, T.stage, 0.2)
      DOCKS.forEach((dk) => {
        const col = { ok: T.ok, warn: T.warn, mut: T.neutral }[dockStatus(dk).cls]
        if (dk.wall === 'y') rect(dk.a, -0.4, dk.b - dk.a, 1.2, col); else rect(-0.4, dk.a, 1.2, dk.b - dk.a, col)
      })
      bulkBays.forEach((b) => rect(b.x0, b.y0, 2, 2, T.beam, 0.55))
      pickFaces.forEach((f) => rect(f.x0, f.y0 + 0.3, 1.5, 1.4, f.qty === 0 ? T.crit : f.task ? T.warn : T.shelf, f.qty === 0 || f.task ? 1 : 0.9))
      sim.trucks.forEach((t) => {
        x.save(); x.translate(px(t.x), py(t.y)); x.rotate(t.h)
        x.fillStyle = t.st === 'waiting' ? T.warn : T.truck; x.strokeStyle = T.muted; x.lineWidth = 0.5
        x.fillRect(-6 * sx, -1.3 * sx, 12 * sx, 2.6 * sx); x.strokeRect(-6 * sx, -1.3 * sx, 12 * sx, 2.6 * sx); x.restore()
      })
      sim.workers.forEach((w) => { x.beginPath(); x.arc(px(w.x), py(w.y), w.role === 'runner' ? 3.2 : 2.2, 0, 7); x.fillStyle = w.role === 'runner' ? T.runner : T.picker; x.fill(); if (w.role === 'runner') { x.strokeStyle = '#000'; x.lineWidth = 0.8; x.stroke() } })
      let s = null
      if (sel.type === 'pick' || sel.type === 'bulk') { const b = byId[sel.id]; s = [b.cx, b.cy] }
      else if (sel.type === 'worker') { const w = workerById[sel.id]; s = [w.x, w.y] }
      else if (sel.type === 'truck') { const t = sim.trucks.find((q) => q.id === sel.id); if (t) s = [t.x, t.y] }
      if (s) { x.beginPath(); x.arc(px(s[0]), py(s[1]), 8, 0, 7); x.strokeStyle = T.accent; x.lineWidth = 2; x.stroke() }
    }
    draw()
    const i = setInterval(draw, 200)
    return () => clearInterval(i)
  }, [T, sel])
  const click = (e) => { const r = e.currentTarget.getBoundingClientRect(); onJump(((e.clientX - r.left) / r.width) * MSX + MX0, ((e.clientY - r.top) / r.height) * MSY + MY0) }
  return <canvas ref={ref} className="minimap" style={{ width: MW, height: MH }} onClick={click} aria-label="Minimap. Click to move the camera." />
}

/* ---------- unit card ---------- */
const Row = ({ k, children }) => (<><dt>{k}</dt><dd>{children}</dd></>)
function UnitCard({ sel, follow, setFollow, apply, bump }) {
  const act = (fn) => () => { fn(); bump() }
  if (sel.type === 'pick') {
    const f = byId[sel.id], pct = Math.round((f.qty / f.cap) * 100)
    return (<>
      <div className="uhead"><b>{f.id}</b><span className="chip" style={{ color: 'var(--accent)' }}>Pick face</span>
        {f.qty === 0 ? <span className="chip crit">Empty</span> : f.task ? <span className="chip warnc">{f.task.st === 'queued' ? 'Replen waiting' : 'Runner on the way'}</span> : null}</div>
      <div className="prog" title="Stock"><i style={{ width: pct + '%', background: pct < 35 ? 'var(--warn)' : 'var(--ok)' }} /></div>
      <dl>
        <Row k="Product">{f.prod}</Row>
        <Row k="Stock"><span className="num">{f.qty} / {f.cap} units ({pct}%)</span></Row>
        <Row k="Slot, trigger"><span className="num">{f.size}, replen at {f.min}</span></Row>
        <Row k="Demand"><span className="num">{f.demand}/day, empties {f.fills.toFixed(1)}×/day</span></Row>
        <Row k="Replen tasks"><span className="num">{f.repl7} per week, {f.replToday} today</span></Row>
        <Row k="Reserve bay"><span className="num">{f.reserve}</span></Row>
        <Row k="Bigger slot?">{f.fit === 'up' ? <b className="warnc">Yes, {f.size} to {f.nextSize}, saves about {f.saved} tasks/week</b> : f.fit === 'down' ? 'No, slot is larger than needed' : 'No'}</Row>
      </dl>
      <div className="cmds">
        <button type="button" className="btn" disabled={!!f.task} onClick={act(() => triggerReplen(f.id))}>Replenish now</button>
        {f.fit === 'up' && <button type="button" className="btn primary" onClick={act(() => upsizeFace(f.id))}>Upsize to {f.nextSize}</button>}
      </div></>)
  }
  if (sel.type === 'bulk') {
    const b = byId[sel.id], feeds = pickFaces.filter((f) => f.reserve === b.id)
    return (<>
      <div className="uhead"><b>{b.id}</b><span className="chip" style={{ color: 'var(--muted)' }}>Bulk bay</span></div>
      <dl>
        <Row k="Product">{b.prod}</Row><Row k="SKU"><span className="num">{b.sku}</span></Row>
        <Row k="Pallets"><span className="num">{b.levels} / 4</span></Row>
        <Row k="Feeds">{feeds.length ? <span className="num">{feeds.map((f) => f.id).join(', ')}</span> : 'No pick face'}</Row>
      </dl>
      <div className="cmds">{feeds.length > 0 && <button type="button" className="btn" onClick={() => apply({ mode: 'fill', sel: { type: 'bulk', id: b.id }, focus: feeds.map((f) => f.id), view: 'overview', note: `${b.id} feeds ${feeds.map((f) => f.id).join(', ')}.` })}>Show pick faces it feeds</button>}</div></>)
  }
  if (sel.type === 'worker') {
    const w = workerById[sel.id], run = w.role === 'runner'
    return (<>
      <div className="uhead"><b>{w.id}</b><span className="chip infoc">{run ? 'Bulk runner' : 'Order picker'}</span></div>
      <dl>
        <Row k="Doing">{w.status}</Row>
        <Row k="Speed"><span className="num">{w.path.length ? (w.speed * 3.6).toFixed(1) : '0.0'} km/h</span></Row>
        {run ? <Row k="Replenishments"><span className="num">{w.trips} this shift</span></Row>
          : <><Row k="Order lines"><span className="num">{w.lines} this shift</span></Row><Row k="Orders"><span className="num">{w.orders}</span></Row></>}
        {run && <Row k="Carrying">{w.carrying ? `1 pallet to ${w.task.face}` : 'Nothing'}</Row>}
      </dl>
      <div className="cmds"><button type="button" className="btn primary" onClick={() => setFollow(follow === w.id ? null : w.id)}>{follow === w.id ? 'Stop following' : 'Follow'}</button></div></>)
  }
  if (sel.type === 'truck') {
    const t = sim.trucks.find((x) => x.id === sel.id)
    if (!t) return <p className="note">{sel.id} has left the site.</p>
    const eta = Math.max(0, Math.ceil(((1 - t.progress) * truckSeconds(t)) / 60)), pct = Math.round(t.progress * 100)
    const st = { waiting: 'Waiting at door', queue: 'In yard queue', arriving: 'Arriving', leaving: 'Leaving', docked: t.dir === 'in' ? 'Unloading' : 'Loading' }[t.st]
    return (<>
      <div className="uhead"><b>{t.id}</b><span className={'chip ' + (t.st === 'waiting' ? 'warnc' : 'okc')}>{st}</span></div>
      <div className="prog"><i style={{ width: (t.st === 'docked' || t.st === 'leaving' ? pct : 0) + '%', background: 'var(--ok)' }} /></div>
      <dl>
        <Row k="Carrier">{t.car}</Row>
        <Row k="Direction">{t.dir === 'in' ? 'Inbound' : 'Outbound'}</Row>
        <Row k="Dock"><span className="num">{t.dock || 'none'}</span></Row>
        <Row k="Pallets"><span className="num">{t.p}</span></Row>
        {t.st === 'docked' && <Row k="ETA"><span className="num">{eta} min ({pct}%)</span></Row>}
        {t.st === 'waiting' && <Row k="Waited"><span className="num">{Math.round(t.waited / 60)} min</span></Row>}
      </dl>
      <div className="cmds">
        {t.st === 'waiting' && <button type="button" className="btn primary" onClick={act(() => moveTruckToFreeDock(t.id))}>Move to free dock</button>}
        <button type="button" className="btn" onClick={() => setFollow(follow === t.id ? null : t.id)}>{follow === t.id ? 'Stop following' : 'Follow'}</button>
      </div></>)
  }
  const d = dockById[sel.id], s = dockStatus(d)
  return (<>
    <div className="uhead"><b>{d.id}</b><span className={'chip ' + (s.cls === 'ok' ? 'okc' : s.cls === 'warn' ? 'warnc' : '')}>{s.label}</span></div>
    <dl><Row k="Direction">{d.dir === 'in' ? 'Inbound' : 'Outbound'}</Row><Row k="Truck">{s.truck ? s.truck.id : 'None'}</Row></dl>
    <div className="cmds">{s.truck && <button type="button" className="btn" onClick={() => apply({ mode: null, sel: { type: 'truck', id: s.truck.id }, view: 'docks' })}>Select truck</button>}</div></>)
}

export default function App() {
  const dark = useDark()
  const T = THEMES[dark ? 'dark' : 'light']
  const [mode, setMode] = useState('fill')
  const [sel, setSel] = useState({ type: 'pick', id: computeOpt().up[0].id })
  const [focus, setFocus] = useState(null)
  const [hover, setHover] = useState(null)
  const [view, setView] = useState({ name: 'overview', n: 0 })
  const [follow, setFollow] = useState(null)
  const [override, setOverride] = useState(null)
  const [tourI, setTourI] = useState(-1)
  const [tab, setTab] = useState('alerts')
  const [paused, setPaused] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [open, setOpen] = useState(true)
  const [, bump] = useTick(500)

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  useEffect(() => { sim.paused = paused }, [paused])
  useEffect(() => { sim.speed = speed }, [speed])

  const goView = useCallback((name) => { setFollow(null); setView((v) => ({ name, n: v.n + 1 })) }, [])
  const pick = useCallback((t) => { setSel(t); setFocus(null); setOverride(null) }, [])
  const apply = useCallback((o) => {
    if (o.mode) setMode(o.mode)
    setSel(o.sel); setFocus(o.focus || null); setOverride(o.note || null)
    setFollow(o.follow || null)
    setView((v) => ({ name: o.view || 'overview', n: v.n + 1 }))
  }, [])
  const goTour = (i) => { if (i < 0 || i >= TOUR.length) { setTourI(-1); setFocus(null); setFollow(null); return } setTourI(i); apply(TOUR[i]) }
  const jump = useCallback((hx, hy) => {
    const [x, z] = toWorld(hx, hy)
    setFollow(null); setView((v) => ({ name: 'custom', custom: { pos: [x + 14, 20, z + 22], target: [x, 0, z] }, n: v.n + 1 }))
  }, [])

  const selRef = useRef(sel); selRef.current = sel
  useEffect(() => {
    const h = (e) => {
      if (e.target.closest && e.target.closest('input,select,textarea')) return
      const i = Number(e.key) - 1
      if (i >= 0 && i < VIEW_KEYS.length) goView(VIEW_KEYS[i])
      else if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p) }
      else if (e.key === 'f' || e.key === 'F') { const s = selRef.current; if (s.type === 'worker' || s.type === 'truck') setFollow((f) => (f === s.id ? null : s.id)) }
      else if (e.key === 'Escape') { setFollow(null); setFocus(null); setOverride(null) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [goView])

  const st = sim.stats, opt = computeOpt(), alerts = alertsNow(), waiting = queued()
  const busyRunners = sim.workers.filter((w) => w.role === 'runner' && w.state !== 'idle').length
  const busyDocks = DOCKS.filter((d) => dockStatus(d).truck).length
  const yardQ = sim.trucks.filter((t) => t.st === 'queue').length
  const leg = LEG[mode], stops = T[mode === 'fill' ? 'stock' : mode]
  const tabs = [['alerts', 'Alerts', alerts.length], ['replen', 'Replenishment', sim.tasks.length], ['slots', 'Slots', opt.up.length], ['wins', 'Quick wins', WINS.length]]

  return (
    <div className="game">
      <div className="stage">
        <MemoScene dark={dark} mode={mode} sel={sel} focus={focus} hover={hover} setHover={setHover} onPick={pick} view={view} follow={follow} views={VIEWS} />
      </div>

      <div className="hud">
        <header className="topbar">
          <div className="brand">
            <svg width="26" height="26" viewBox="0 0 34 34" fill="none" aria-hidden="true">
              <path d="M17 3 30 10.5v13L17 31 4 23.5v-13L17 3Z" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
              <path d="M4 10.5 17 18l13-7.5M17 18v13" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
            </svg>
            <select id="site" aria-label="Site" value={SITE.id} onChange={(e) => { location.search = '?site=' + e.target.value }}>
              {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span className="badge">Mock-up</span>
          </div>
          <div className="chips">
            <div className="chip2"><span>Replen today</span><b>{st.replToday}</b></div>
            <div className="chip2"><span>Open tasks</span><b>{sim.tasks.length}<small> {waiting} wait</small></b></div>
            <div className="chip2"><span>Empty hits</span><b className={st.stockouts > 0 ? 'warnc' : ''}>{st.stockouts}</b></div>
            <div className="chip2"><span>Orders shipped</span><b>{st.orders}</b></div>
            <div className="chip2"><span>Docks busy</span><b>{busyDocks}/8<small> yard {yardQ}</small></b></div>
            <div className="chip2"><span>Pickers · runners</span><b>{PICKERS} · {busyRunners}/{RUNNERS}</b></div>
          </div>
          <div className="ctrl">
            <span className="clock"><b>{clock(sim.t)}</b></span>
            <div className="seg" role="group" aria-label="Speed">{[1, 4].map((v) => <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v}×</button>)}</div>
            <div className="seg"><button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button></div>
          </div>
        </header>

        <div className="tour">
          {tourI < 0 ? (
            <button type="button" className="btn primary" onClick={() => goTour(0)}>Start guided tour</button>
          ) : (<div className="tourbox card">
            <div className="txt"><h2>{tourI + 1} of {TOUR.length} · {TOUR[tourI].t}</h2><p>{TOUR[tourI].x}</p></div>
            <div className="btns">
              <button type="button" className="btn" disabled={tourI === 0} onClick={() => goTour(tourI - 1)}>Back</button>
              <button type="button" className="btn primary" onClick={() => goTour(tourI + 1)}>{tourI === TOUR.length - 1 ? 'Finish' : 'Next'}</button>
            </div>
          </div>)}
        </div>

        <div className="views">
          <div className="seg" role="group" aria-label="Camera">
            {VIEW_BTNS.map(([v, l], i) => <button key={v} type="button" title={`Key ${i + 1}`} aria-pressed={!follow && view.name === v} onClick={() => goView(v)}>{l}</button>)}
          </div>
          <div className="seg" role="group" aria-label="Map layer">
            {MODES.map(([m, l]) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setOverride(null) }}>{l}</button>)}
          </div>
          <div className="legend card">
            {leg ? (<><span>{leg[0]}</span><i style={{ background: `linear-gradient(90deg,${stops.join(',')})` }} /><span>{leg[1]} {leg[2]}</span></>)
              : (<><span className="sw" style={{ background: T.slot.up }} />Bigger slot<span className="sw" style={{ background: T.slot.down }} />Too big<span className="sw" style={{ background: T.slot.ok }} />OK</>)}
          </div>
          {follow && <button type="button" className="btn primary" onClick={() => setFollow(null)}>Stop following {follow}</button>}
        </div>

        <aside className={'left card' + (open ? '' : ' shut')}>
          <div className="lhead">
            <div className="tabs" role="tablist">
              {tabs.map(([k, l, n]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setOpen(true) }}>{l}<small>{n}</small></button>)}
            </div>
            <button type="button" className="fold" aria-label={open ? 'Collapse panel' : 'Expand panel'} onClick={() => setOpen(!open)}>{open ? '–' : '+'}</button>
          </div>
          {open && <div className="lbody">
            {tab === 'alerts' && <div className="alerts">
              {alerts.map((a, i) => {
                const l = { crit: ['▲ Critical', 'crit'], warn: ['◆ Warning', 'warnc'], info: ['● Info', 'infoc'] }[a.sev]
                return (<button key={i} type="button" className="alert" disabled={!a.tg} onClick={() => (a.win != null ? apply(WINS[a.win]) : (pick(a.tg), a.view && goView(a.view)))}>
                  <span className={'sev ' + l[1]}>{l[0]}</span><strong>{a.t}</strong><small>{a.d}</small></button>)
              })}
              {alerts.length === 0 && <p className="note">Nothing needs attention.</p>}
            </div>}
            {tab === 'replen' && <>
              <div className="kpis">
                <div className="kpi"><span>Tasks today</span><b>{st.replToday}</b><small>{WEEK_REPL} last 7 days</small></div>
                <div className="kpi"><span>Open now</span><b>{sim.tasks.length}</b><small>{waiting} waiting</small></div>
                <div className="kpi"><span>Avg replen time</span><b>{Math.round(st.cycleAvg)} s</b><small>task to full face</small></div>
                <div className="kpi"><span>Empty-face hits</span><b>{st.stockouts}</b><small>lines skipped</small></div>
              </div>
              <div className="tasks">
                {sim.tasks.slice(0, 7).map((t) => (
                  <button key={t.id} type="button" className="task" onClick={() => pick({ type: 'pick', id: t.face })}>
                    <span className="num">{t.id}</span><span className="num">{t.from} → {t.face}</span>
                    <span className={t.st === 'queued' ? 'warnc' : 'infoc'}>{t.st === 'queued' ? 'Waiting' : t.runner}</span>
                  </button>))}
                {sim.tasks.length === 0 && <p className="note">No open tasks.</p>}
                {sim.log.slice(0, 3).map((l) => (<div key={l.id} className="task done"><span className="num">{l.id}</span><span className="num">{l.from} → {l.face}</span><span className="okc">Done {Math.round(l.cycle)} s</span></div>))}
              </div>
            </>}
            {tab === 'slots' && <>
              <p className="big"><b className="warnc">{opt.up.length} of {pickFaces.length}</b> pick faces: bigger slot yes. Saves about <b>{opt.saved}</b> replenishment tasks per week.</p>
              <p className="note" style={{ margin: '0 0 8px' }}>Yes when a face empties 2.5 times a day or more and a larger size exists. {opt.down.length} faces could shrink.{UPSIZED.faces > 0 && <> Applied so far: <b>{UPSIZED.faces}</b> upsized, about <b>{UPSIZED.saved}</b> tasks per week saved.</>}</p>
              <div className="cmds" style={{ marginBottom: 8 }}>
                <button type="button" className="btn primary" disabled={!opt.up.length} onClick={() => { upsizeAll(); bump() }}>Upsize all {opt.up.length}</button>
                <button type="button" className="btn" disabled={!opt.up.length} onClick={() => apply({ mode: 'slot', sel: { type: 'pick', id: opt.up[0].id }, focus: opt.up.map((f) => f.id), view: 'pick' })}>Show on map</button>
              </div>
              <table className="opt">
                <thead><tr><th>Face</th><th>Size</th><th>Empties/day</th><th>Saves/wk</th></tr></thead>
                <tbody>{opt.up.slice(0, 8).map((f) => (
                  <tr key={f.id} onClick={() => apply({ mode: 'slot', sel: { type: 'pick', id: f.id }, focus: opt.up.map((x) => x.id), view: 'pick' })}>
                    <td><button type="button">{f.id}</button></td><td className="num">{f.size} → {f.nextSize}</td><td className="num">{f.fills.toFixed(1)}</td><td className="num">{f.saved}</td>
                  </tr>))}</tbody>
              </table>
            </>}
            {tab === 'wins' && <><div className="wins">
              {WINS.map((w, i) => <button key={i} type="button" className="win" onClick={() => apply(w)}><strong>{w.t}</strong><small>{w.d}</small></button>)}
            </div><p className="note">Click one to see where on the floor. Gains are rough estimates from simulated data.</p></>}
          </div>}
        </aside>

        <section className="feed card" aria-label="Events">
          <h2>Events</h2>
          {sim.feed.slice(0, 6).map((e, i) => (
            <div key={e.t + e.txt + i} className="ev"><span className="num">{clock(e.t)}</span><i className={e.sev} /><span>{e.txt}</span></div>))}
          {sim.feed.length === 0 && <p className="note">Waiting for the first event.</p>}
        </section>

        <section className="unit card" aria-label="Selected">
          <UnitCard sel={sel} follow={follow} setFollow={setFollow} apply={apply} bump={bump} />
        </section>

        <div className="mini card">
          <Minimap T={T} sel={sel} onJump={jump} />
        </div>

        <p className="hint">{override || HINTS[mode]}<span className="keys"> Keys: 1 to 6 views, space pause, F follow, Esc clear.</span></p>
      </div>
    </div>
  )
}
