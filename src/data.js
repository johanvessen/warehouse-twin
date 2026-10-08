// Simulated warehouse data. Coordinates are hall metres: x runs west to east (outbound wall at x = 0),
// y runs north to south (inbound wall at y = 0). Replace the generators with WMS / IoT feeds; the rest reads these shapes.

function rng(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = rng(21)
const pad = (n) => String(n).padStart(2, '0')
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

export const HALL = { w: 60, d: 40, wallH: 5 }
export const toWorld = (x, y) => [x - HALL.w / 2, y - HALL.d / 2] // hall metres -> scene x/z, centred on origin

// Walking network: six east-west aisles (centre line y), a west lane next to outbound staging and a replenishment lane between the zones.
export const A = [3, 10, 16, 22, 28, 36]
export const XW = 4.5
export const XM = 32
export const STAGE_X = 2.4

export const SIZES = { S: 24, M: 48, L: 96 } // units a pick face holds
const NEXT = { S: 'M', M: 'L' }
const PRODUCTS = [
  ['Sparkling water 6-pack', 'SKU-10482'], ['Oat drink 1 L', 'SKU-10733'], ['Pasta penne 500 g', 'SKU-11208'],
  ['Cooking oil 1 L', 'SKU-11590'], ['Laundry pods 40 ct', 'SKU-20411'], ['Paper towels 8 rolls', 'SKU-20876'],
  ['Coffee beans 1 kg', 'SKU-12044'], ['Dish soap 750 ml', 'SKU-20119'], ['Canned tomatoes 400 g', 'SKU-11877'],
  ['Cereal muesli 750 g', 'SKU-12390'], ['Rice basmati 1 kg', 'SKU-11340'], ['Shampoo 300 ml', 'SKU-20602'],
]

// ---- bulk zone (east): pallet racking, 5 rows x 12 bays, 4 levels ----
export const bulkBays = []
for (let r = 0; r < 5; r++)
  for (let i = 0; i < 12; i++) {
    const x0 = 34 + i * 2, y0 = 6 + r * 6, p = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)]
    const lv = rnd()
    bulkBays.push({
      kind: 'bulk', id: 'B-' + 'ABCDE'[r] + pad(i + 1), x0, y0, cx: x0 + 1, cy: y0 + 1, w: 2, d: 2,
      aisle: r + (i % 2), levels: lv < 0.05 ? 1 : lv < 0.2 ? 2 : lv < 0.5 ? 3 : 4, prod: p[0], sku: p[1],
    })
  }

// ---- pick zone (west): shelving, 5 rows x 16 faces, one SKU per face ----
export const pickFaces = []
for (let r = 0; r < 5; r++)
  for (let i = 0; i < 16; i++) {
    const x0 = 6 + i * 1.5, y0 = 6 + r * 6, p = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)]
    const heat = clamp(0.8 * Math.exp(-(x0 - 6) / 16) * (0.5 + 0.5 * rnd()) + (r === 1 || r === 3 ? 0.12 : 0) + 0.06 * rnd(), 0.03, 1)
    const sr = rnd()
    pickFaces.push({
      kind: 'pick', id: 'P-' + 'ABCDE'[r] + pad(i + 1), x0, y0, cx: x0 + 0.75, cy: y0 + 1, w: 1.5, d: 1.4,
      aisle: r + (i % 2), heat, size: sr < 0.45 ? 'S' : sr < 0.85 ? 'M' : 'L', prod: p[0], sku: p[1],
    })
  }
export const byId = Object.fromEntries([...pickFaces, ...bulkBays].map((b) => [b.id, b]))

// Story data: promo SKUs sitting far from the outbound wall, slow SKUs holding prime spots next to it.
;['P-B15', 'P-D14', 'P-B16', 'P-D16', 'P-D13', 'P-C15'].forEach((id, i) => { byId[id].heat = 0.95 - i * 0.04 })
;['P-A02', 'P-C02', 'P-E03', 'P-A04', 'P-E04', 'P-C03'].forEach((id, i) => { byId[id].heat = 0.05 + i * 0.012 })

pickFaces.forEach((f) => {
  f.demand = Math.round(6 + Math.pow(f.heat, 1.4) * 150)            // units picked per day
  f.cap = SIZES[f.size]
  f.min = Math.round(f.cap * 0.35)                                   // replenishment trigger level
  f.qty = Math.max(0, Math.round(f.cap * (0.25 + 0.75 * rnd())))     // current stock in the face
  f.fills = f.demand / f.cap                                         // how many times a day the face empties
  f.repl7 = Math.max(0, Math.round(f.fills * 7 * (0.9 + 0.2 * rnd()))) // replenishment tasks in the last 7 days
  f.replToday = Math.round(f.fills * 0.62)                           // tasks since 06:00
  f.reserve = (bulkBays.filter((b) => b.sku === f.sku)[0] || bulkBays[Math.floor(rnd() * bulkBays.length)]).id
  f.task = null
  if (f.fills >= 2.5 && f.size !== 'L') {
    f.fit = 'up'; f.nextSize = NEXT[f.size]
    f.saved = Math.round(f.demand * 7 / f.cap - (f.demand * 7) / SIZES[f.nextSize])
  } else if (f.size === 'L' && f.fills < 0.3) f.fit = 'down'
  else f.fit = 'ok'
})
pickFaces.forEach((f) => { if (f.id === 'P-D14') f.qty = 0 }) // one empty face to start with

export const OPT = {
  up: pickFaces.filter((f) => f.fit === 'up').sort((a, b) => b.saved - a.saved),
  down: pickFaces.filter((f) => f.fit === 'down'),
}
OPT.saved = OPT.up.reduce((s, f) => s + f.saved, 0)

export const SEED = {
  replToday: pickFaces.reduce((s, f) => s + f.replToday, 0),
  stockouts: 4,
  picksToday: pickFaces.reduce((s, f) => s + Math.round((f.demand * 0.62) / 2), 0),
}
export const WEEK_REPL = pickFaces.reduce((s, f) => s + f.repl7, 0)

export const DOCKS = [
  { id: 'IN-1', wall: 'y', a: 36, b: 40, st: 'Unloading', cls: 'ok', truck: true, tr: 'TR-4821', car: 'Noordvaart Freight', p: 24, note: 'Started 14:05' },
  { id: 'IN-2', wall: 'y', a: 42, b: 46, st: 'Waiting', cls: 'warn', truck: true, tr: 'TR-5107', car: 'Lek & Maas Transport', p: 18, note: '38 min past appointment' },
  { id: 'IN-3', wall: 'y', a: 48, b: 52, st: 'Free', cls: 'mut', truck: false, note: 'Next booking 15:20' },
  { id: 'IN-4', wall: 'y', a: 54, b: 58, st: 'Unloading', cls: 'ok', truck: true, tr: 'TR-4906', car: 'Brabant Cargo', p: 30, note: 'Started 14:19' },
  { id: 'OUT-1', wall: 'x', a: 10, b: 14, st: 'Loading', cls: 'ok', truck: true, tr: 'TR-7730', car: 'Eurolijn Distribution', p: 26, note: 'Departs 14:50' },
  { id: 'OUT-2', wall: 'x', a: 16, b: 20, st: 'Free', cls: 'mut', truck: false, note: 'Next booking 15:10' },
  { id: 'OUT-3', wall: 'x', a: 22, b: 26, st: 'Loading', cls: 'ok', truck: true, tr: 'TR-7741', car: 'Zuid-Express', p: 14, note: 'Departs 15:05' },
  { id: 'OUT-4', wall: 'x', a: 28, b: 32, st: 'Free', cls: 'mut', truck: false, note: 'Next booking 16:00' },
]
export const dockById = Object.fromEntries(DOCKS.map((d) => [d.id, d]))

// ---- quick wins, derived from the data above ----
export const hotFar = pickFaces.slice().sort((a, b) => b.demand * (b.x0 - 6) - a.demand * (a.x0 - 6)).slice(0, 6)
export const slowNear = pickFaces.filter((f) => f.x0 <= 14 && !hotFar.includes(f)).sort((a, b) => a.demand - b.demand).slice(0, 6)
const km = Math.max(1, Math.round(hotFar.reduce((s, f, i) => s + (Math.max(0, f.x0 - slowNear[i].x0) * f.demand * 7) / 1000, 0)))
export const hottest = pickFaces.filter((f) => f.fills >= 2.5).sort((a, b) => b.fills - a.fills).slice(0, 8)

export const WINS = [
  { t: `Upsize ${OPT.up.length} pick faces to the next slot size`, d: `Saves about ${OPT.saved} replenishment tasks per week`,
    mode: 'slot', focus: OPT.up.map((f) => f.id), sel: { type: 'pick', id: OPT.up[0].id }, view: 'pick',
    note: `Highlighted faces empty 2.5 times a day or more. One size up halves the trips. The top candidate is ${OPT.up[0].id} (${OPT.up[0].size} to ${OPT.up[0].nextSize}).` },
  { t: `Swap ${hotFar.length} fast movers with slow movers by the outbound wall`, d: `About ${km} km less picker walking per week`,
    mode: 'heat', focus: hotFar.concat(slowNear).map((f) => f.id), sel: { type: 'pick', id: hotFar[0].id }, view: 'overview',
    note: `Highlighted: the ${hotFar.length} costliest fast movers on the east side of the pick zone and ${slowNear.length} slow movers in the best spots next to the outbound wall.` },
  { t: `Raise the replenishment trigger on ${hottest.length} fast faces`, d: 'Fewer empty faces and short picks at peak',
    mode: 'repl', focus: hottest.map((f) => f.id), sel: { type: 'pick', id: hottest[0].id }, view: 'pick',
    note: `These faces trigger replenishment at 35% and still run empty before the runner arrives. Trigger at 50% instead.` },
  { t: 'Move TR-5107 to free dock IN-3', d: 'Ends a 38 min wait at no cost',
    mode: 'fill', sel: { type: 'dock', id: 'IN-2' }, view: 'docks',
    note: 'IN-2 holds a truck 38 min past its slot while IN-3 is empty until 15:20.' },
]

export const TOUR = [
  { t: 'One hall, two zones', x: 'Bulk storage with pallet racking sits on the east side, close to the inbound docks. The pick zone with shelving sits on the west side, close to outbound. The purple lane between them is where replenishment crosses over. Drag to orbit, scroll to zoom.', mode: 'fill', sel: { type: 'pick', id: 'P-C08' }, view: 'overview' },
  { t: 'Bulk zone', x: 'Pallets in four-level racking. Five bulk runners work here and take pallets to the pick zone when a face needs refilling.', mode: 'fill', sel: { type: 'bulk', id: 'B-C06' }, view: 'bulk' },
  { t: 'Pick zone', x: 'Twenty order pickers walk the aisles collecting order lines. The block in each face shows how full it is. Faces below their trigger level get an orange beacon.', mode: 'fill', sel: { type: 'pick', id: 'P-B09' }, view: 'pick' },
  { t: 'Replenishment', x: 'The camera now rides behind runner RN-1. A beacon turns blue once a runner is on the way. When the pallet arrives the face is full again and the counter on the right goes up.', mode: 'fill', sel: { type: 'worker', id: 'RN-1' }, follow: 'RN-1', view: 'overview' },
  { t: 'Pick heat', x: 'Bars above the faces show daily demand. Fast movers belong next to the outbound wall on the west side. The highlighted tall bars on the east side cost pickers the longest walk.', mode: 'heat', sel: { type: 'pick', id: hotFar[0].id }, focus: hotFar.map((f) => f.id), view: 'overview' },
  { t: 'Bigger slot: yes or no', x: 'Orange faces empty at least 2.5 times a day. A bigger slot means fewer replenishment tasks. Click a face to see the advice and the estimated saving.', mode: 'slot', sel: { type: 'pick', id: OPT.up[0].id }, focus: OPT.up.map((f) => f.id), view: 'pick' },
]

// camera presets in scene coordinates
export const VIEWS = {
  overview: { pos: [50, 40, 54], target: [0, 0, 0] },
  top: { pos: [0.1, 78, 0.1], target: [0, 0, 0] },
  pick: { pos: [-14, 20, 34], target: [-12, 0, 2] },
  bulk: { pos: [46, 20, 34], target: [16, 0, 2] },
  docks: { pos: [-10, 16, 24], target: [-28, 1, -4] },
}
