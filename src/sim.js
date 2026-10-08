// Mutable simulation state, advanced once per frame by <Sim/> in Scene.jsx and read by the 3D scene and the HUD.
// 20 order pickers work the pick zone, 5 bulk runners replenish pick faces from bulk, trucks dock, load and unload.
import { pickFaces, bulkBays, byId, A, XW, XM, STAGE_X, SEED, SITE, DOCKS, dockById, INIT_TRUCKS, UPSIZED, recalcFit, computeOpt } from './data.js'

let seed = 5 + SITE.seed
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const PICKERS = 20
export const RUNNERS = 5
const HOME_A = [1, 2, 3, 4, 5]
const CARRIERS = ['Noordvaart Freight', 'Lek & Maas Transport', 'Brabant Cargo', 'Eurolijn Distribution', 'Zuid-Express', 'Delta Haulage']
const IN_SECONDS = 420, OUT_SECONDS = 900   // dock time at 1x for a full unload / load

const weights = pickFaces.map((f) => Math.pow(f.heat, 1.2) + 0.05)
const wSum = weights.reduce((s, v) => s + v, 0)
function pickWeighted() {
  let r = rnd() * wSum
  for (let i = 0; i < pickFaces.length; i++) { r -= weights[i]; if (r <= 0) return pickFaces[i] }
  return pickFaces[0]
}

// Route along the aisle network: aisle a1 at x1 -> aisle a2 at x2, through the nearest cross lane.
function route(x1, a1, x2, a2) {
  const y1 = A[a1], y2 = A[a2]
  if (a1 === a2) return [[x2, y2]]
  const cost = (lx) => Math.abs(x1 - lx) + Math.abs(y1 - y2) + Math.abs(x2 - lx)
  const lx = cost(XW) <= cost(XM) ? XW : XM
  return [[lx, y1], [lx, y2], [x2, y2]]
}
const go = (w, x2, a2) => { w.path = route(w.x, w.a, x2, a2); w.a = a2 }

export const sim = {
  t: 0, speed: 1, paused: false, workers: [], trucks: [], truckVersion: 0,
  tasks: [], log: [], feed: [], nextId: 400 + SEED.replToday, nextTruck: 5300, nextSpawn: 70,
  stats: { replToday: SEED.replToday, stockouts: SEED.stockouts, picksToday: SEED.picksToday, cycleAvg: 96, orders: 412, trucks: 9 },
}
export function feed(txt, sev = 'info') {
  sim.feed.unshift({ t: sim.t, txt, sev })
  sim.feed.length = Math.min(sim.feed.length, 30)
}

sim.feed.push(
  { t: -35, txt: 'TR-5107 waiting at IN-2, no crew assigned', sev: 'warn' },
  { t: -95, txt: 'PK-07 found P-D14 empty, line skipped', sev: 'crit' },
  { t: -180, txt: 'TR-4906 docked at IN-4, unloading 30 pallets', sev: 'ok' },
  { t: -250, txt: 'RN-3 delivered R-398 to P-C09 in 74 s', sev: 'ok' },
  { t: -330, txt: 'Pick wave 12 released, 148 order lines', sev: 'info' },
)
const workers = sim.workers
for (let i = 0; i < PICKERS; i++) {
  const a = Math.floor(rnd() * 5) + 1
  workers.push({ id: 'PK-' + String(i + 1).padStart(2, '0'), role: 'picker', x: 7 + rnd() * 22, y: A[a], a, h: 0, path: [], state: 'idle', dwell: rnd() * 2,
    speed: 1.35 + rnd() * 0.3, carrying: false, order: [], idx: 0, target: null, lines: 0, orders: 0, status: 'Starting order' })
}
for (let i = 0; i < RUNNERS; i++) {
  const a = HOME_A[i]
  workers.push({ id: 'RN-' + (i + 1), role: 'runner', x: XM + 1.2, y: A[a], a, h: 0, path: [], state: 'idle', dwell: 0, home: a,
    speed: 1.7 + rnd() * 0.2, carrying: false, task: null, trips: 0, status: 'Waiting for task' })
}
export const workerById = Object.fromEntries(workers.map((w) => [w.id, w]))

/* ---------- trucks ---------- */
export const dockPos = (d) => d.wall === 'y' ? { x: (d.a + d.b) / 2, y: -6.8, h: -Math.PI / 2 } : { x: -6.8, y: (d.a + d.b) / 2, h: Math.PI }
const LANE = -17
const isFree = (d) => !sim.trucks.some((t) => t.dock === d.id && t.st !== 'leaving')
const approach = (d) => {
  const p = dockPos(d)
  return d.wall === 'y' ? [[p.x, LANE, Math.PI], [p.x, p.y, -Math.PI / 2]] : [[LANE, p.y, -Math.PI / 2], [p.x, p.y, Math.PI]]
}
const departure = (d) => {
  const p = dockPos(d)
  return d.wall === 'y' ? [[p.x, LANE, -Math.PI / 2], [78, LANE, 0]] : [[LANE, p.y, Math.PI], [LANE, 58, Math.PI / 2]]
}
for (const i of INIT_TRUCKS) {
  const p = dockPos(dockById[i.dock])
  sim.trucks.push({ id: i.id, dir: i.dir, dock: i.dock, car: i.car, p: i.p, st: i.wait ? 'waiting' : 'docked', progress: i.progress, x: p.x, y: p.y, h: p.h, path: [], speed: 4.5, waited: i.wait ? 38 * 60 : 0 })
}

export const truckSeconds = (t) => (t.dir === 'in' ? IN_SECONDS : OUT_SECONDS)
export function dockStatus(d) {
  const t = sim.trucks.find((x) => x.dock === d.id && x.st !== 'leaving')
  if (!t) return { label: 'Free', cls: 'mut', truck: null }
  if (t.st === 'waiting') return { label: 'Waiting', cls: 'warn', truck: t }
  if (t.st === 'arriving') return { label: 'Arriving', cls: 'ok', truck: t }
  return { label: t.dir === 'in' ? 'Unloading' : 'Loading', cls: 'ok', truck: t }
}
const freeDock = (dir) => DOCKS.find((d) => d.dir === dir && isFree(d) && !(d.id === 'IN-3' && sim.trucks.some((t) => t.st === 'waiting')))

function spawnTruck() {
  const dir = rnd() < 0.5 ? 'in' : 'out'
  const t = { id: 'TR-' + sim.nextTruck++, dir, dock: null, car: CARRIERS[Math.floor(rnd() * CARRIERS.length)], p: 12 + Math.floor(rnd() * 20), st: 'queue', progress: 0, path: [], speed: 4.5, waited: 0 }
  const q = sim.trucks.filter((x) => x.st === 'queue' && x.dir === dir).length
  if (dir === 'in') { t.x = 40 + 6 * q; t.y = -26; t.h = Math.PI / 2 } else { t.x = -26; t.y = 8 + 6 * q; t.h = 0 }
  sim.trucks.push(t); sim.truckVersion++
  feed(`${t.id} (${t.car}) arrived in the yard`, 'info')
}
function moveAlong(w, s) {
  while (w.path.length && s > 0) {
    const [tx, ty, th] = w.path[0], dx = tx - w.x, dy = ty - w.y, d = Math.hypot(dx, dy)
    if (th !== undefined) w.h = th
    else if (d > 0.001) w.h = Math.atan2(dy, dx)
    if (d <= s) { w.x = tx; w.y = ty; s -= d; w.path.shift() }
    else { w.x += (dx / d) * s; w.y += (dy / d) * s; s = 0 }
  }
  return w.path.length === 0
}

function stepTruck(t, k) {
  if (t.st === 'queue') {
    const d = freeDock(t.dir)
    if (d) {
      t.dock = d.id; t.st = 'arriving'
      t.path = [t.dir === 'in' ? [t.x, LANE] : [LANE, t.y], ...approach(d)]
    }
    return
  }
  if (t.st === 'arriving' || t.st === 'leaving') {
    if (moveAlong(t, t.speed * k)) {
      if (t.st === 'arriving') {
        t.st = 'docked'; t.progress = 0
        feed(`${t.id} docked at ${t.dock}, ${t.dir === 'in' ? 'unloading' : 'loading'} ${t.p} pallets`, 'ok')
        sim.truckVersion++
      } else { sim.trucks.splice(sim.trucks.indexOf(t), 1); sim.truckVersion++ }
    }
    return
  }
  if (t.st === 'waiting') { t.waited += k; return }
  t.progress = Math.min(1, t.progress + k / truckSeconds(t))
  if (t.progress >= 1) {
    const d = dockById[t.dock]
    t.st = 'leaving'; t.path = departure(d); sim.stats.trucks++
    if (t.dir === 'in') {
      for (let i = 0; i < t.p; i++) { const b = bulkBays[Math.floor(rnd() * bulkBays.length)]; if (b.levels < 4) b.levels++ }
      feed(`${t.id} unloaded ${t.p} pallets at ${t.dock}, putaway to bulk`, 'ok')
    } else feed(`${t.id} left ${t.dock} with ${t.p} pallets`, 'ok')
    t.dock = null
  }
}

/* ---------- order pickers ---------- */
function newOrder(w) {
  const lines = []
  for (let i = 0; i < 3 + Math.floor(rnd() * 3); i++) lines.push(pickWeighted())
  lines.sort((a, b) => a.aisle - b.aisle || a.cx - b.cx)
  w.order = lines; w.idx = 0; w.target = lines[0]; w.state = 'toFace'
  w.status = `Picking line 1 of ${lines.length}`
  go(w, lines[0].cx, lines[0].aisle)
}

function stepPicker(w, dt, k) {
  if (w.state === 'idle') { if ((w.dwell -= k) <= 0) newOrder(w); return }
  if (w.state === 'pick' || w.state === 'pack') {
    if ((w.dwell -= k) > 0) return
    if (w.state === 'pack') {
      w.orders++; sim.stats.orders++
      const out = sim.trucks.filter((t) => t.dir === 'out' && t.st === 'docked')
      if (out.length) { const t = out[Math.floor(rnd() * out.length)]; t.progress = Math.min(1, t.progress + 0.035) }
      newOrder(w); return
    }
    const f = w.target, units = 1 + Math.floor(rnd() * 3)
    if (f.qty <= 0) {
      sim.stats.stockouts++
      if (!f.soT || sim.t - f.soT > 90) { f.soT = sim.t; feed(`${w.id} found ${f.id} empty, line skipped`, 'crit') }
    } else { f.qty = Math.max(0, f.qty - units); sim.stats.picksToday++; w.lines++ }
    w.idx++
    if (w.idx < w.order.length) {
      w.target = w.order[w.idx]; w.state = 'toFace'; w.status = `Picking line ${w.idx + 1} of ${w.order.length}`
      go(w, w.target.cx, w.target.aisle)
    } else { w.state = 'toStage'; w.status = 'Taking order to outbound staging'; go(w, STAGE_X, 1 + Math.floor(rnd() * 4)) }
    return
  }
  if (moveAlong(w, w.speed * k)) {
    if (w.state === 'toFace') { w.state = 'pick'; w.dwell = 1.2 + rnd() * 1.2; w.status = `Picking ${w.target.id}` }
    else if (w.state === 'toStage') { w.state = 'pack'; w.dwell = 2; w.status = 'Dropping order at staging' }
  }
}

/* ---------- bulk runners ---------- */
function stepRunner(w, k) {
  if (w.state === 'idle') {
    const t = sim.tasks.find((x) => x.st === 'queued')
    if (!t) return
    t.st = 'fetch'; t.runner = w.id; w.task = t; w.state = 'fetch'
    const b = byId[t.from]
    w.status = `To ${b.id} for ${t.face}`
    go(w, b.cx, b.aisle); return
  }
  if (w.state === 'load' || w.state === 'drop') {
    if ((w.dwell -= k) > 0) return
    const t = w.task
    if (w.state === 'load') {
      w.carrying = true; t.st = 'deliver'; w.state = 'deliver'
      const f = byId[t.face]; w.status = `Delivering to ${f.id}`; go(w, f.cx, f.aisle)
    } else {
      const f = byId[t.face], b = byId[t.from]
      f.qty = f.cap; f.task = null; f.replToday++
      if (rnd() < 0.25) b.levels = Math.max(1, b.levels - 1)
      else if (b.levels < 4 && rnd() < 0.3) b.levels++
      const cycle = sim.t - t.t0
      sim.stats.replToday++; sim.stats.cycleAvg = sim.stats.cycleAvg * 0.85 + cycle * 0.15
      sim.log.unshift({ id: t.id, face: f.id, from: b.id, runner: w.id, cycle }); sim.log.length = Math.min(sim.log.length, 8)
      feed(`${w.id} delivered ${t.id} to ${f.id} in ${Math.round(cycle)} s`, 'ok')
      sim.tasks.splice(sim.tasks.indexOf(t), 1)
      w.carrying = false; w.task = null; w.trips++; w.state = 'home'; w.status = 'Returning to replenishment lane'
      go(w, XM + 1.2, w.home)
    }
    return
  }
  if (moveAlong(w, w.speed * k)) {
    if (w.state === 'fetch') { w.state = 'load'; w.dwell = 2.2; w.status = `Loading at ${w.task.from}` }
    else if (w.state === 'deliver') { w.state = 'drop'; w.dwell = 2.2; w.status = `Dropping at ${w.task.face}` }
    else if (w.state === 'home') { w.state = 'idle'; w.status = 'Waiting for task' }
  }
}

export function stepSim(dt) {
  if (sim.paused) return
  const k = dt * sim.speed
  sim.t += k
  for (const f of pickFaces)
    if (!f.task && f.qty <= f.min) {
      const t = { id: 'R-' + sim.nextId++, face: f.id, from: f.reserve, st: 'queued', runner: null, t0: sim.t }
      f.task = t; sim.tasks.push(t)
    }
  for (const w of workers) w.role === 'picker' ? stepPicker(w, dt, k) : stepRunner(w, k)
  if (sim.t >= sim.nextSpawn) { sim.nextSpawn = sim.t + 90 + rnd() * 70; if (sim.trucks.filter((t) => t.st === 'queue').length < 4) spawnTruck() }
  for (const t of [...sim.trucks]) stepTruck(t, k)
}

export const queued = () => sim.tasks.filter((t) => t.st === 'queued').length

/* ---------- commands (what the player can do) ---------- */
export function triggerReplen(id) {
  const f = byId[id]
  if (f.task) return false
  const t = { id: 'R-' + sim.nextId++, face: f.id, from: f.reserve, st: 'queued', runner: null, t0: sim.t }
  f.task = t; sim.tasks.push(t); feed(`Replenishment ${t.id} started by hand for ${f.id}`, 'info')
  return true
}
export function upsizeFace(id) {
  const f = byId[id]
  if (f.fit !== 'up') return false
  const from = f.size, saved = f.saved, ratio = f.qty / f.cap
  f.size = f.nextSize; recalcFit(f)
  f.qty = Math.round(f.cap * Math.max(ratio, 0.5)) // the new slot is filled to at least half on the next delivery
  UPSIZED.faces++; UPSIZED.saved += saved
  feed(`${f.id} upsized ${from} to ${f.size}, saves about ${saved} tasks per week`, 'ok')
  return true
}
export function upsizeAll() {
  let n = 0
  for (const f of computeOpt().up) if (upsizeFace(f.id)) n++
  return n
}
export function moveTruckToFreeDock(id) {
  const t = sim.trucks.find((x) => x.id === id)
  if (!t || !t.dock) return false
  const from = dockById[t.dock], to = DOCKS.find((d) => d.dir === t.dir && isFree(d))
  if (!to) return false
  const a = dockPos(from), b = dockPos(to)
  t.dock = to.id; t.st = 'arriving'; t.progress = 0; t.waited = 0
  t.path = from.wall === 'y'
    ? [[a.x, LANE, -Math.PI / 2], [b.x, LANE], [b.x, b.y, -Math.PI / 2]]
    : [[LANE, a.y, Math.PI], [LANE, b.y], [b.x, b.y, Math.PI]]
  feed(`${t.id} moved from ${from.id} to ${to.id}`, 'ok')
  return true
}
