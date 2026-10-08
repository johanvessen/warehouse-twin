// Mutable simulation state, advanced once per frame by <Sim/> in Scene.jsx and read by the 3D scene and the HUD.
//   pick zone : 20 order pickers  -> 6 pack benches -> outbound staging -> outbound trucks
//   bulk zone : 5 bulk runners replenish pick faces (on foot); 4 forklifts put pallets away and bring pallets to bulk staging
//   safety    : forklifts and pedestrians share the bulk aisles under right-of-way locks, gate lights and slow/stop zones
//   transfers : shuttle trucks move pallets between the main hall and the sub-warehouse across the road
import {
  pickFaces, bulkBays, subBays, byId, A, XW, XM, XE, FORK_X, ROAD_Y, slotX, SA, SX, SEED, SITE, DOCKS, dockById, INIT_TRUCKS, UPSIZED, recalcFit, computeOpt, PACK_BENCHES,
} from './data.js'

let seed = 5 + SITE.seed
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pickOne = (arr) => arr[Math.floor(rnd() * arr.length)]

export const PICKERS = 20
export const RUNNERS = 5
export const FORKLIFTS = 4
const HOME_A = [1, 2, 3, 4, 5]
const CARRIERS = ['Noordvaart Freight', 'Lek & Maas Transport', 'Brabant Cargo', 'Eurolijn Distribution', 'Zuid-Express', 'Delta Haulage']
const IN_SECONDS = 420, OUT_SECONDS = 900
export const STOP_R = 3.5, SLOW_R = 8, NEAR_R = 2.0
const GATE_X = 33.6, EAST_X = 60.5

export const sim = {
  t: 0, speed: 1, paused: false, workers: [], forklifts: [], subWorkers: [], subForks: [], trucks: [], truckVersion: 0,
  tasks: [], log: [], feed: [], ftasks: [], orders: [], nextId: 400 + SEED.replToday, nextF: 700, nextTruck: 5300, nextSpawn: 70, nextTO: 2050,
  staging: { cust: 7, in: 5, bulkOut: 2 },
  benches: PACK_BENCHES.map((b) => ({ ...b, queue: 1, busy: false, timer: 0, dur: 24, packed: 0 })),
  safety: { on: true, nearMiss: 0, stops: 0, holds: 0, avoidedBase: 31 },
  locks: A.map(() => ({ type: null, ids: new Set() })),
  stats: { replToday: SEED.replToday, stockouts: SEED.stockouts, picksToday: SEED.picksToday, cycleAvg: 96, orders: 412, packed: 438, trucks: 9, putaways: 41, retrievals: 27 },
}
export function feed(txt, sev = 'info') {
  sim.feed.unshift({ t: sim.t, txt, sev })
  sim.feed.length = Math.min(sim.feed.length, 40)
}
sim.feed.push(
  { t: -35, txt: 'TR-5107 waiting at IN-2, no crew assigned', sev: 'warn' },
  { t: -95, txt: 'PK-07 found P-D14 empty, line skipped', sev: 'crit' },
  { t: -180, txt: 'TR-4906 docked at IN-4, unloading 30 pallets', sev: 'ok' },
  { t: -250, txt: 'FK-2 stopped for a pedestrian at the gate of aisle 3', sev: 'info' },
  { t: -330, txt: 'Pick wave 12 released, 148 order lines', sev: 'info' },
)

/* ---------- routing on the walking / driving network ---------- */
function routeG(x1, a1, x2, a2, aisles, lanes) {
  const y1 = aisles[a1], y2 = aisles[a2]
  if (a1 === a2) return [[x2, y2]]
  const lx = lanes.reduce((best, l) => (Math.abs(x1 - l) + Math.abs(x2 - l) < Math.abs(x1 - best) + Math.abs(x2 - best) ? l : best), lanes[0])
  return [[lx, y1], [lx, y2], [x2, y2]]
}
const walk = (w, x2, a2) => { w.path = routeG(w.x, w.a, x2, a2, A, [XW, XM]); w.a = a2 }
const drive = (f, x2, a2) => { f.path = routeG(f.x, f.a, x2, a2, A, [XE]); f.a = a2 }

/* ---------- safety: right-of-way locks on the bulk aisles ---------- */
export function aisleOf(x, y) {
  if (x < GATE_X || x > EAST_X) return -1
  for (let a = 0; a < A.length; a++) if (Math.abs(y - A[a]) <= 1.3) return a
  return -1
}
function tryAcquire(a, type, id) {
  const L = sim.locks[a]
  if (L.ids.has(id)) return true
  // people share an aisle with people, forklifts with forklifts, never both
  if (!sim.safety.on || L.ids.size === 0 || L.type === type) { L.type = L.ids.size ? L.type : type; L.ids.add(id); return true }
  return false
}
function release(a, id) {
  const L = sim.locks[a]
  L.ids.delete(id)
  if (!L.ids.size) L.type = null
}
const typeOf = (w) => (w.role === 'forklift' ? 'fork' : 'ped')
function gate(w, nx, ny) {
  const a = aisleOf(nx, ny)
  if (a < 0 || a === w.lockA) return true
  const ok = tryAcquire(a, typeOf(w), w.id)
  if (!ok) {
    w.held = true
    if (!w.holding) {
      w.holding = true; sim.safety.holds++
      if (!w.gateT || sim.t - w.gateT > 20) { w.gateT = sim.t; feed(`${w.id} held at the gate of aisle ${a}: ${sim.locks[a].type === 'fork' ? 'forklift' : 'pedestrian'} in the aisle`, 'info') }
    }
    w.waitMsg = `Waiting at gate of aisle ${a}`
  }
  return ok
}
function afterMove(w) {
  const a = aisleOf(w.x, w.y)
  if (a !== w.lockA) {
    if (w.lockA >= 0) release(w.lockA, w.id)
    if (a >= 0) tryAcquire(a, typeOf(w), w.id)
    w.lockA = a
  }
}

function moveAlong(w, s, useGate) {
  w.held = false
  while (w.path.length && s > 0) {
    const [tx, ty, th] = w.path[0], dx = tx - w.x, dy = ty - w.y, d = Math.hypot(dx, dy)
    const step = Math.min(s, d), nx = d > 0 ? w.x + (dx / d) * step : tx, ny = d > 0 ? w.y + (dy / d) * step : ty
    if (useGate && !gate(w, nx, ny)) { if (d > 0.001) w.h = Math.atan2(dy, dx); return false }
    if (th !== undefined) w.h = th
    else if (d > 0.001) w.h = Math.atan2(dy, dx)
    w.holding = false
    w.x = nx; w.y = ny; s -= step
    if (d <= step + 1e-9) w.path.shift()
  }
  if (useGate) afterMove(w)
  return w.path.length === 0
}

/* ---------- people ---------- */
const workers = sim.workers
for (let i = 0; i < PICKERS; i++) {
  const a = Math.floor(rnd() * 5) + 1
  workers.push({ id: 'PK-' + String(i + 1).padStart(2, '0'), role: 'picker', x: 7 + rnd() * 22, y: A[a], a, h: 0, path: [], state: 'idle', dwell: rnd() * 2,
    speed: 1.35 + rnd() * 0.3, carrying: false, order: [], idx: 0, target: null, lines: 0, orders: 0, status: 'Starting order', lockA: -1 })
}
for (let i = 0; i < RUNNERS; i++) {
  const a = HOME_A[i]
  workers.push({ id: 'RN-' + (i + 1), role: 'runner', x: XM + 1.2, y: A[a], a, h: 0, path: [], state: 'idle', dwell: 0, home: a,
    speed: 1.7 + rnd() * 0.2, carrying: false, task: null, trips: 0, status: 'Waiting for task', lockA: -1 })
}
export const workerById = Object.fromEntries(workers.map((w) => [w.id, w]))

const weights = pickFaces.map((f) => Math.pow(f.heat, 1.2) + 0.05)
const wSum = weights.reduce((s, v) => s + v, 0)
function pickWeighted() {
  let r = rnd() * wSum
  for (let i = 0; i < pickFaces.length; i++) { r -= weights[i]; if (r <= 0) return pickFaces[i] }
  return pickFaces[0]
}

function newOrder(w) {
  const lines = []
  for (let i = 0; i < 3 + Math.floor(rnd() * 3); i++) lines.push(pickWeighted())
  lines.sort((a, b) => a.aisle - b.aisle || a.cx - b.cx)
  w.order = lines; w.idx = 0; w.target = lines[0]; w.state = 'toFace'
  w.status = `Picking line 1 of ${lines.length}`
  walk(w, lines[0].cx, lines[0].aisle)
}

function stepPicker(w, k) {
  if (w.state === 'idle') { if ((w.dwell -= k) <= 0) newOrder(w); return }
  if (w.state === 'pick' || w.state === 'pack') {
    if ((w.dwell -= k) > 0) return
    if (w.state === 'pack') { w.orders++; w.bench.queue++; newOrder(w); return }
    const f = w.target, units = 1 + Math.floor(rnd() * 3)
    if (f.qty <= 0) {
      sim.stats.stockouts++
      if (!f.soT || sim.t - f.soT > 90) { f.soT = sim.t; feed(`${w.id} found ${f.id} empty, line skipped`, 'crit') }
    } else { f.qty = Math.max(0, f.qty - units); sim.stats.picksToday++; w.lines++ }
    w.idx++
    if (w.idx < w.order.length) {
      w.target = w.order[w.idx]; w.state = 'toFace'; w.status = `Picking line ${w.idx + 1} of ${w.order.length}`
      walk(w, w.target.cx, w.target.aisle)
    } else {
      w.bench = sim.benches.reduce((b, c) => (c.queue + (c.busy ? 1 : 0) < b.queue + (b.busy ? 1 : 0) ? c : b), sim.benches[Math.floor(rnd() * 6)])
      w.state = 'toPack'; w.status = `Taking order to ${w.bench.id}`; walk(w, w.bench.x, 5)
    }
    return
  }
  if (moveAlong(w, w.speed * k, false)) {
    if (w.state === 'toFace') { w.state = 'pick'; w.dwell = 1.2 + rnd() * 1.2; w.status = `Picking ${w.target.id}` }
    else if (w.state === 'toPack') { w.state = 'pack'; w.dwell = 2; w.status = `Handing order to ${w.bench.id}` }
  }
}

function stepRunner(w, k) {
  if (w.state === 'idle') {
    const t = sim.tasks.find((x) => x.st === 'queued')
    if (!t) return
    t.st = 'fetch'; t.runner = w.id; w.task = t; w.state = 'fetch'
    const b = byId[t.from]
    w.status = `To ${b.id} for ${t.face}`
    walk(w, b.cx, b.aisle); return
  }
  if (w.state === 'load' || w.state === 'drop') {
    if ((w.dwell -= k) > 0) return
    const t = w.task
    if (w.state === 'load') {
      w.carrying = true; t.st = 'deliver'; w.state = 'deliver'
      const f = byId[t.face]; w.status = `Delivering to ${f.id}`; walk(w, f.cx, f.aisle)
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
      walk(w, XM + 1.2, w.home)
    }
    return
  }
  const done = moveAlong(w, w.speed * k, true)
  if (!done) { if (w.held) w.status = w.waitMsg; return }
  if (w.state === 'fetch') { w.state = 'load'; w.dwell = 2.2; w.status = `Loading at ${w.task.from}` }
  else if (w.state === 'deliver') { w.state = 'drop'; w.dwell = 2.2; w.status = `Dropping at ${w.task.face}` }
  else if (w.state === 'home') { w.state = 'idle'; w.status = 'Waiting for task' }
}

/* ---------- forklifts (bulk) ---------- */
const FORK_HOME = [0, 1, 4, 5]
for (let i = 0; i < FORKLIFTS; i++) {
  const a = FORK_HOME[i]
  sim.forklifts.push({ id: 'FK-' + (i + 1), role: 'forklift', x: XE, y: A[a], a, h: Math.PI, path: [], state: 'idle', home: a, speed: 2.8, carrying: false, task: null,
    moves: 0, status: 'Waiting for task', lockA: -1, factor: 1, nearest: 99, bat: 60 + Math.floor(rnd() * 35) })
}
export const forkById = Object.fromEntries(sim.forklifts.map((f) => [f.id, f]))

function stepForklift(f, k) {
  // proximity zones: slow inside SLOW_R, stop inside STOP_R of any pedestrian
  let dmin = 99
  for (const p of workers) { if (p.held) continue; const d = Math.hypot(p.x - f.x, p.y - f.y); if (d < dmin) dmin = d } // people held at a gate are behind it
  f.nearest = dmin
  const prev = f.factor
  f.factor = !sim.safety.on ? 1 : dmin < STOP_R ? 0 : dmin < SLOW_R ? 0.4 : 1
  if (prev !== 0 && f.factor === 0 && f.path.length) {
    sim.safety.stops++
    if (!f.stopT || sim.t - f.stopT > 25) { f.stopT = sim.t; feed(`${f.id} stopped: pedestrian within ${STOP_R} m`, 'info') }
  }
  if (dmin < NEAR_R && f.path.length && f.factor > 0 && (!f.nmT || sim.t - f.nmT > 25)) {
    f.nmT = sim.t; sim.safety.nearMiss++
    feed(`NEAR MISS: ${f.id} passed a pedestrian at ${dmin.toFixed(1)} m`, 'crit')
  }

  if (f.state === 'idle') {
    const t = sim.ftasks.find((x) => x.st === 'queued' && x.type === 'retrieve') || sim.ftasks.find((x) => x.st === 'queued')
    if (!t) return
    t.st = 'active'; t.fk = f.id; f.task = t; f.state = 'fetch'
    if (t.type === 'putaway') {
      const slot = Math.max(0, Math.min(15, sim.staging.in - 1)); t.slot = slot
      f.status = `To inbound staging for ${t.bay}`; drive(f, slotX(slot), 0)
    } else { const b = byId[t.bay]; f.status = `To ${b.id} for ${t.order.id}`; drive(f, b.cx, b.aisle) }
    return
  }
  if (f.state === 'load' || f.state === 'drop') {
    if ((f.dwell -= k) > 0) return
    const t = f.task, b = byId[t.bay]
    if (f.state === 'load') {
      f.carrying = true; f.state = 'carry'
      if (t.type === 'putaway') { sim.staging.in = Math.max(0, sim.staging.in - 1); f.status = `Putaway to ${b.id}`; drive(f, b.cx, b.aisle) }
      else { b.levels = Math.max(0, b.levels - 1); f.status = 'Bringing pallet to bulk staging'; t.slot = Math.min(15, sim.staging.bulkOut); drive(f, slotX(t.slot), 5) }
    } else {
      if (t.type === 'putaway') { b.levels = Math.min(4, b.levels + 1); sim.stats.putaways++ }
      else { sim.staging.bulkOut++; t.order.picked++; sim.stats.retrievals++; if (t.order.picked >= t.order.n) t.order.st = 'Staged' }
      f.carrying = false; f.moves++; f.state = 'home'; f.status = 'Returning to the east lane'
      sim.ftasks.splice(sim.ftasks.indexOf(t), 1); f.task = null
      drive(f, XE, f.home)
    }
    return
  }
  const speedBase = f.a >= 1 && f.a <= 4 && f.x < EAST_X ? 1.7 : 2.8
  f.speed = speedBase * f.factor
  const done = f.speed > 0 ? moveAlong(f, f.speed * k, true) : false
  if (f.factor === 0) { f.status = `Stopped: pedestrian within ${STOP_R} m`; return }
  if (!done) { if (f.held) f.status = f.waitMsg; return }
  if (f.state === 'fetch') { f.state = 'load'; f.dwell = 2.4; f.status = 'Picking up pallet' }
  else if (f.state === 'carry') { f.state = 'drop'; f.dwell = 2.4; f.status = 'Setting pallet down' }
  else if (f.state === 'home') { f.state = 'idle'; f.status = 'Waiting for task' }
}

function makePutaways() {
  const open = sim.ftasks.filter((t) => t.type === 'putaway').length
  for (let i = open; i < sim.staging.in && i < 6; i++) {
    const free = bulkBays.filter((b) => b.levels < 4 && (b.x0 >= FORK_X || rnd() < 0.1))
    if (!free.length) return
    sim.ftasks.push({ id: 'F-' + sim.nextF++, type: 'putaway', bay: pickOne(free).id, st: 'queued' })
  }
}

/* ---------- sub-warehouse ambience: 4 people and 2 forklifts ---------- */
for (let i = 0; i < 4; i++) {
  sim.subWorkers.push({ id: 'SP-' + (i + 1), role: 'picker', x: 28 + i * 5, y: SA[i], a: i, h: 0, path: [], speed: 1.4, dwell: rnd() * 3, status: 'Picking in sub-warehouse', lockA: -1 })
}
for (let i = 0; i < 2; i++) {
  sim.subForks.push({ id: 'SF-' + (i + 1), role: 'forklift', x: 30 + i * 10, y: SA[1 + i], a: 1 + i, h: 0, path: [], speed: 2.2, dwell: rnd() * 3, carrying: i === 0, status: 'Moving pallets in sub-warehouse', lockA: -1, factor: 1, nearest: 99 })
}
function stepWander(w, k) {
  if (w.path.length) { moveAlong(w, w.speed * k, false); return }
  if ((w.dwell -= k) > 0) return
  w.dwell = 1 + rnd() * 3
  const a = Math.floor(rnd() * SA.length)
  w.path = routeG(w.x, w.a, 26 + rnd() * 22, a, SA, SX); w.a = a
}

/* ---------- trucks: inbound, outbound ---------- */
export const dockPos = (d) => d.wall === 'y' ? { x: (d.a + d.b) / 2, y: -6.8, h: -Math.PI / 2 }
  : d.wall === 'x' ? { x: -6.8, y: (d.a + d.b) / 2, h: Math.PI }
  : d.wall === 's' ? { x: (d.a + d.b) / 2, y: 46.8, h: Math.PI / 2 }
  : { x: (d.a + d.b) / 2, y: 63.2, h: -Math.PI / 2 }
const LANE = -17
const isFree = (d) => !sim.trucks.some((t) => t.dock === d.id && t.st !== 'leaving')
const approach = (d) => {
  const p = dockPos(d)
  return d.wall === 'y' ? [[p.x, LANE, Math.PI], [p.x, p.y, -Math.PI / 2]] : [[LANE, p.y, -Math.PI / 2], [p.x, p.y, Math.PI]]
}
const departure = (d) => {
  const p = dockPos(d)
  return d.wall === 'y' ? [[p.x, LANE, -Math.PI / 2], [84, LANE, 0]] : [[LANE, p.y, Math.PI], [LANE, 58, Math.PI / 2]]
}
for (const i of INIT_TRUCKS) {
  const p = dockPos(dockById[i.dock])
  sim.trucks.push({ id: i.id, dir: i.dir, dock: i.dock, car: i.car, p: i.p, st: i.wait ? 'waiting' : 'docked', progress: i.progress, x: p.x, y: p.y, h: p.h, path: [], speed: 4.5, waited: i.wait ? 38 * 60 : 0, loadT: 0 })
}

export const truckSeconds = (t) => (t.dir === 'in' ? IN_SECONDS : t.dir === 'out' ? OUT_SECONDS : 240)
export function dockStatus(d) {
  const t = sim.trucks.find((x) => x.dock === d.id && x.st !== 'leaving')
  if (!t) return { label: 'Free', cls: 'mut', truck: null }
  if (t.st === 'waiting') return { label: 'Waiting', cls: 'warn', truck: t }
  if (t.st === 'arriving') return { label: 'Arriving', cls: 'ok', truck: t }
  if (t.dir === 'xfer') return { label: t.leg === 'main-load' ? 'Loading' : 'Unloading', cls: 'ok', truck: t }
  return { label: t.dir === 'in' ? 'Unloading' : 'Loading', cls: 'ok', truck: t }
}
const freeDock = (dir) => DOCKS.find((d) => d.dir === dir && isFree(d) && !(d.id === 'IN-3' && sim.trucks.some((t) => t.st === 'waiting')))

function spawnTruck() {
  const dir = rnd() < 0.4 ? 'in' : 'out'
  const t = { id: 'TR-' + sim.nextTruck++, dir, dock: null, car: pickOne(CARRIERS), p: dir === 'in' ? 6 + Math.floor(rnd() * 9) : 12 + Math.floor(rnd() * 20), st: 'queue', progress: 0, path: [], speed: 4.5, waited: 0, loadT: 0 }
  const q = sim.trucks.filter((x) => x.st === 'queue' && x.dir === dir).length
  if (dir === 'in') { t.x = 40 + 6 * q; t.y = -26; t.h = Math.PI / 2 } else { t.x = -26; t.y = 8 + 6 * q; t.h = 0 }
  sim.trucks.push(t); sim.truckVersion++
  feed(`${t.id} (${t.car}) arrived in the yard`, 'info')
}

function stepTruck(t, k) {
  if (t.dir === 'xfer') return stepShuttle(t, k)
  if (t.st === 'queue') {
    const d = freeDock(t.dir)
    if (d) { t.dock = d.id; t.st = 'arriving'; t.path = [t.dir === 'in' ? [t.x, LANE] : [LANE, t.y], ...approach(d)] }
    return
  }
  if (t.st === 'arriving' || t.st === 'leaving') {
    if (moveAlong(t, t.speed * k, false)) {
      if (t.st === 'arriving') {
        t.st = 'docked'; t.progress = 0
        feed(`${t.id} docked at ${t.dock}, ${t.dir === 'in' ? 'unloading' : 'loading'} ${t.p} pallets`, 'ok')
        sim.truckVersion++
      } else { sim.trucks.splice(sim.trucks.indexOf(t), 1); sim.truckVersion++ }
    }
    return
  }
  if (t.st === 'waiting') { t.waited += k; return }
  if (t.dir === 'in') t.progress = Math.min(1, t.progress + k / IN_SECONDS)
  else {
    // outbound trucks are loaded from the packed orders waiting in outbound staging
    t.loadT -= k
    t.progress = Math.min(1, t.progress + k / 2400)
    if (t.loadT <= 0 && sim.staging.cust > 0) { sim.staging.cust--; sim.stats.orders++; t.progress = Math.min(1, t.progress + 0.04); t.loadT = 4 }
  }
  if (t.progress >= 1) {
    const d = dockById[t.dock]
    t.st = 'leaving'; t.path = departure(d); sim.stats.trucks++
    if (t.dir === 'in') {
      sim.staging.in += t.p
      feed(`${t.id} unloaded ${t.p} pallets at ${t.dock}, staged for putaway`, 'ok')
    } else feed(`${t.id} left ${t.dock} with ${t.p} pallets`, 'ok')
    t.dock = null
  }
}

/* ---------- transfers: shuttle trucks between the main hall and the sub-warehouse ---------- */
const MAIN_XF = DOCKS.filter((d) => d.wall === 's'), SUB_SD = DOCKS.filter((d) => d.wall === 'n2')
const REST = [{ x: 76, y: 46 }, { x: 76, y: 36 }]
for (let i = 0; i < 2; i++) {
  sim.trucks.push({ id: 'TX-' + (i + 1), dir: 'xfer', leg: 'rest', st: 'rest', car: 'Transfer shuttle', p: 0, progress: 0, x: REST[i].x, y: REST[i].y, h: Math.PI, path: [], speed: 4.5,
    waited: 0, dock: null, timer: 8 + i * 70, order: null, ret: null, loaded: 0, loadT: 0, label: 'Resting in yard', rest: i })
}
function newTO(dir, n, t) {
  const o = { id: 'TO-' + sim.nextTO++, dir, n, picked: 0, st: dir === 'main→sub' ? 'Picking' : 'Loading', truck: t.id, t0: sim.t }
  sim.orders.unshift(o); sim.orders.length = Math.min(sim.orders.length, 12)
  return o
}
sim.orders.push(
  { id: 'TO-2047', dir: 'sub→main', n: 4, picked: 4, st: 'Received', truck: 'TX-2', t0: -900 },
  { id: 'TO-2046', dir: 'main→sub', n: 12, picked: 12, st: 'Received', truck: 'TX-2', t0: -1500 },
  { id: 'TO-2045', dir: 'sub→main', n: 6, picked: 6, st: 'Received', truck: 'TX-1', t0: -2300 },
)
function goTo(t, path, leg, label) { t.path = path; t.leg = leg; t.st = 'arriving'; t.label = label }
function stepShuttle(t, k) {
  const sp = t.speed * k
  switch (t.leg) {
    case 'rest':
      t.st = 'rest'; t.label = 'Resting in yard'
      if ((t.timer -= k) <= 0) {
        const d = MAIN_XF.find(isFree)
        if (!d) return
        const n = 8 + Math.floor(rnd() * 7), o = newTO('main→sub', n, t)
        t.order = o; t.loaded = 0; t.p = n; t.dock = d.id
        for (let i = 0; i < n; i++) sim.ftasks.push({ id: 'F-' + sim.nextF++, type: 'retrieve', bay: pickOne(bulkBays.filter((b) => b.levels >= 2 && b.x0 >= FORK_X)).id, st: 'queued', order: o })
        const p = dockPos(d)
        goTo(t, [[REST[t.rest].x, ROAD_Y, Math.PI], [p.x, ROAD_Y], [p.x, p.y, Math.PI / 2]], 'to-main', `${o.id} · heading to ${d.id}`)
        feed(`${o.id}: ${n} pallets from bulk to the sub-warehouse, ${t.id} sent to ${d.id}`, 'info')
      }
      break
    case 'to-main':
      if (moveAlong(t, sp, false)) { t.leg = 'main-load'; t.st = 'docked'; t.progress = t.loaded / t.p; t.loadT = 4; t.label = `${t.order.id} · loading` }
      break
    case 'main-load':
      t.loadT -= k
      if (t.loadT <= 0 && sim.staging.bulkOut > 0 && t.loaded < t.p) { sim.staging.bulkOut--; t.loaded++; t.loadT = 8; t.order.st = 'Loading' }
      t.progress = t.loaded / t.p
      t.label = `${t.order.id} · loading ${t.loaded}/${t.p}`
      if (t.loaded >= t.p) {
        const d = SUB_SD.find(isFree)
        if (!d) { t.label = 'Waiting for a free sub-warehouse dock'; return }
        const from = dockPos(dockById[t.dock]), to = dockPos(d)
        t.dock = d.id; t.order.st = 'In transit'
        goTo(t, [[from.x, ROAD_Y, Math.PI / 2], [to.x, ROAD_Y], [to.x, to.y, -Math.PI / 2]], 'to-sub', `${t.order.id} · in transit`)
        feed(`${t.id} left for the sub-warehouse with ${t.p} pallets`, 'ok')
      }
      break
    case 'to-sub':
      if (moveAlong(t, sp, false)) { t.leg = 'sub-unload'; t.st = 'docked'; t.progress = 0; t.order.st = 'Unloading'; t.label = `${t.order.id} · unloading at sub` }
      break
    case 'sub-unload':
      t.progress = Math.min(1, t.progress + k / 240)
      if (t.progress >= 1) {
        for (let i = 0; i < t.p; i++) { const b = pickOne(subBays); if (b.levels < 4) b.levels++ }
        t.order.st = 'Received'; t.order.t1 = sim.t
        feed(`${t.order.id} received at the sub-warehouse, ${t.p} pallets`, 'ok')
        const r = Math.floor(rnd() * 7)
        if (r > 0) { t.ret = newTO('sub→main', r, t); t.p = r; t.leg = 'sub-load'; t.progress = 0; t.label = `${t.ret.id} · loading at sub` }
        else { t.ret = null; t.p = 0; t.leg = 'sub-wait'; t.label = 'No returns, heading back' }
      }
      break
    case 'sub-load':
      t.progress = Math.min(1, t.progress + k / (t.p * 16))
      if (t.progress >= 1) { for (let i = 0; i < t.p; i++) { const b = pickOne(subBays); b.levels = Math.max(1, b.levels - 1) } t.ret.st = 'In transit'; t.leg = 'sub-wait' }
      break
    case 'sub-wait': {
      const d = MAIN_XF.find(isFree)
      if (!d) { t.label = 'Waiting for a free transfer dock'; return }
      const from = dockPos(dockById[t.dock]), to = dockPos(d)
      t.dock = d.id
      goTo(t, [[from.x, ROAD_Y, -Math.PI / 2], [to.x, ROAD_Y], [to.x, to.y, Math.PI / 2]], 'to-main-back', t.ret ? `${t.ret.id} · in transit` : 'Returning empty')
      break
    }
    case 'to-main-back':
      if (moveAlong(t, sp, false)) { t.leg = 'main-unload'; t.st = 'docked'; t.progress = 0; if (t.ret) t.ret.st = 'Unloading'; t.label = t.ret ? `${t.ret.id} · unloading at main` : 'Docked' }
      break
    case 'main-unload':
      t.progress = Math.min(1, t.progress + k / (12 + t.p * 14))
      if (t.progress >= 1) {
        if (t.ret) { sim.staging.in += t.p; t.ret.st = 'Received'; t.ret.t1 = sim.t; feed(`${t.ret.id} received at main, ${t.p} pallets staged for putaway`, 'ok') }
        const p = dockPos(dockById[t.dock])
        t.dock = null; t.order = null; t.ret = null; t.p = 0; t.timer = 80 + rnd() * 60
        goTo(t, [[p.x, ROAD_Y, Math.PI / 2], [REST[t.rest].x, ROAD_Y], [REST[t.rest].x, REST[t.rest].y]], 'to-rest', 'Returning to the yard')
      }
      break
    case 'to-rest':
      if (moveAlong(t, sp, false)) { t.leg = 'rest'; t.st = 'rest'; t.label = 'Resting in yard' }
      break
    default: break
  }
}

/* ---------- main loop ---------- */
export function stepSim(dt) {
  if (sim.paused) return
  const k = dt * sim.speed
  sim.t += k
  for (const f of pickFaces)
    if (!f.task && f.qty <= f.min) {
      const t = { id: 'R-' + sim.nextId++, face: f.id, from: f.reserve, st: 'queued', runner: null, t0: sim.t }
      f.task = t; sim.tasks.push(t)
    }
  for (const w of workers) w.role === 'picker' ? stepPicker(w, k) : stepRunner(w, k)
  for (const f of sim.forklifts) stepForklift(f, k)
  for (const w of sim.subWorkers) stepWander(w, k)
  for (const f of sim.subForks) stepWander(f, k)
  for (const b of sim.benches) {
    if (b.busy) { b.timer -= k; if (b.timer <= 0) { b.busy = false; b.packed++; sim.stats.packed++; sim.staging.cust++ } }
    else if (b.queue > 0) { b.queue--; b.busy = true; b.dur = 20 + rnd() * 14; b.timer = b.dur }
  }
  makePutaways()
  if (sim.t >= sim.nextSpawn) { sim.nextSpawn = sim.t + 60 + rnd() * 60; if (sim.trucks.filter((t) => t.st === 'queue').length < 4) spawnTruck() }
  for (const t of [...sim.trucks]) stepTruck(t, k)
}

export const queued = () => sim.tasks.filter((t) => t.st === 'queued').length
export const safetyScore = () => Math.max(0, 100 - sim.safety.nearMiss * 12)
export const conflictsAvoided = () => sim.safety.avoidedBase + sim.safety.holds + sim.safety.stops

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
  f.qty = Math.round(f.cap * Math.max(ratio, 0.5))
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
  if (!t || !t.dock || t.dir === 'xfer') return false
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
export function setSafety(on) {
  sim.safety.on = on
  feed(on ? 'Safety system switched ON' : 'Safety system switched OFF: locks and zones disabled', on ? 'ok' : 'crit')
}
