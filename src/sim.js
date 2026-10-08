// Mutable simulation state, advanced once per frame by <Sim/> in Scene.jsx and read by the 3D scene and the panels.
// 20 order pickers work the pick zone, 5 bulk runners replenish pick faces from bulk.
import { pickFaces, bulkBays, byId, A, XW, XM, STAGE_X, SEED } from './data.js'

let seed = 5
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const PICKERS = 20
export const RUNNERS = 5
const HOME_A = [1, 2, 3, 4, 5]

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

const workers = []
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

export const sim = {
  t: 0, speed: 1, paused: false, workers,
  tasks: [], log: [], nextId: 400 + SEED.replToday,
  stats: { replToday: SEED.replToday, stockouts: SEED.stockouts, picksToday: SEED.picksToday, cycleAvg: 96 },
}
export const workerById = Object.fromEntries(workers.map((w) => [w.id, w]))

function newOrder(w) {
  const lines = []
  for (let i = 0; i < 3 + Math.floor(rnd() * 3); i++) lines.push(pickWeighted())
  lines.sort((a, b) => a.aisle - b.aisle || a.cx - b.cx)
  w.order = lines; w.idx = 0; w.target = lines[0]; w.state = 'toFace'
  w.status = `Picking line 1 of ${lines.length}`
  go(w, lines[0].cx, lines[0].aisle)
}

function moveAlong(w, s) {
  while (w.path.length && s > 0) {
    const [tx, ty] = w.path[0], dx = tx - w.x, dy = ty - w.y, d = Math.hypot(dx, dy)
    if (d > 0.001) w.h = Math.atan2(dy, dx)
    if (d <= s) { w.x = tx; w.y = ty; s -= d; w.path.shift() }
    else { w.x += (dx / d) * s; w.y += (dy / d) * s; s = 0 }
  }
  return w.path.length === 0
}

function stepPicker(w, dt, k) {
  if (w.state === 'idle') { if ((w.dwell -= k) <= 0) newOrder(w); return }
  if (w.state === 'pick' || w.state === 'pack') {
    if ((w.dwell -= k) > 0) return
    if (w.state === 'pack') { w.orders++; newOrder(w); return }
    const f = w.target, units = 1 + Math.floor(rnd() * 3)
    if (f.qty <= 0) sim.stats.stockouts++
    else { f.qty = Math.max(0, f.qty - units); sim.stats.picksToday++; w.lines++ }
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
}

export const openTasks = () => sim.tasks.length
export const queued = () => sim.tasks.filter((t) => t.st === 'queued').length
