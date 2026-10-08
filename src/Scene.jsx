import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import { HALL, SUBHALL, DOCKS, A, XE, FORK_X, ROAD_Y, slotX, INSTAGE_Y, OUTSTAGE_Y, pickFaces, bulkBays, subBays, byId, toWorld } from './data.js'
import { sim, stepSim, workerById, forkById, dockStatus, truckSeconds, STOP_R, SLOW_R } from './sim.js'
import { THEMES, ramp } from './theme.js'

/* ---------- small helpers ---------- */
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }
const put = (m, i, o, x, y, z, sx = 1, sy = 1, sz = 1) => { o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.updateMatrix(); m.setMatrixAt(i, o.matrix) }
const box = <boxGeometry args={[1, 1, 1]} />
const RACK_H = 3.0, BULK_H = 6.4, LEVEL = 1.55
const W = (x, y) => toWorld(x, y)
const PALETTE = ['#c8a06a', '#b8895a', '#d9bd8c', '#e6e1d6', '#7ea6d1', '#e0a84a', '#8bb779', '#d27a63'] // packaging: kraft, white, blue, orange, green, red
const palOf = (key) => PALETTE[hash(String(key)) % PALETTE.length]
const SKIN = ['#f0c8a0', '#e0ac85', '#c68b60', '#a06a44', '#7a4c2e']
const PANTS = ['#2c3946', '#3b4a5c', '#4a4038', '#22262b']
const CAR_COLORS = ['#b9302a', '#26384d', '#e8ecef', '#7c8a94', '#2f78b7', '#2e8b57', '#e9a23b', '#6c4a9a', '#1f9e9a', '#b9c0c6']
const LIV = {
  'Noordvaart Freight': { body: '#f4f6f7', stripe: '#1f5fa8', cab: '#1f5fa8' },
  'Lek & Maas Transport': { body: '#f4f6f7', stripe: '#c0392b', cab: '#c0392b' },
  'Brabant Cargo': { body: '#eceff1', stripe: '#e8a21c', cab: '#e8a21c' },
  'Eurolijn Distribution': { body: '#f4f6f7', stripe: '#2f8a4d', cab: '#2f8a4d' },
  'Zuid-Express': { body: '#e4eaee', stripe: '#6b3fa0', cab: '#6b3fa0' },
  'Delta Haulage': { body: '#f4f6f7', stripe: '#1c1f22', cab: '#3d4b57' },
}

/* ---------- procedural textures (made once, tinted by material colour) ---------- */
let TEX = null
function canvasTex(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size
  draw(c.getContext('2d'), size)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  return t
}
function noise(g, s, n, lo, hi, alpha, sz) {
  for (let i = 0; i < n; i++) { const v = (lo + Math.random() * (hi - lo)) | 0; g.fillStyle = `rgba(${v},${v},${v},${alpha})`; g.fillRect(Math.random() * s, Math.random() * s, sz * (0.5 + Math.random()), sz * (0.5 + Math.random())) }
}
function getTex() {
  if (TEX) return TEX
  TEX = {
    concrete: canvasTex(512, (g, s) => {
      g.fillStyle = '#dcdcdc'; g.fillRect(0, 0, s, s)
      noise(g, s, 16000, 180, 245, 0.5, 2)
      for (let i = 0; i < 30; i++) { const x = Math.random() * s, y = Math.random() * s, r = 30 + Math.random() * 90, gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(70,70,70,0.07)'); gr.addColorStop(1, 'rgba(70,70,70,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r) }
      g.strokeStyle = 'rgba(40,40,40,0.28)'; g.lineWidth = 3; g.strokeRect(1, 1, s - 2, s - 2)
    }),
    asphalt: canvasTex(512, (g, s) => { g.fillStyle = '#bcbcbc'; g.fillRect(0, 0, s, s); noise(g, s, 24000, 120, 230, 0.55, 2) }),
    grass: canvasTex(512, (g, s) => { g.fillStyle = '#d2d2d2'; g.fillRect(0, 0, s, s); noise(g, s, 30000, 150, 255, 0.5, 3) }),
    corr: canvasTex(256, (g, s) => { for (let x = 0; x < s; x += 8) { g.fillStyle = x % 16 ? '#e4e4e4' : '#fafafa'; g.fillRect(x, 0, 8, s) } }),
    hazard: canvasTex(256, (g, s) => {
      g.fillStyle = '#f4c20d'; g.fillRect(0, 0, s, s); g.fillStyle = '#1c1c1c'
      for (let i = -s; i < 2 * s; i += 64) { g.beginPath(); g.moveTo(i, s); g.lineTo(i + 32, s); g.lineTo(i + 32 + s, 0); g.lineTo(i + s, 0); g.fill() }
    }),
    slots: canvasTex(1024, (g, s) => {
      g.clearRect(0, 0, s, s); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 6
      for (let i = 0; i < 16; i++) g.strokeRect(i * 64 + 7, 14, 50, s - 28)
    }),
  }
  TEX.slots.repeat.set(1, 1)
  return TEX
}
const tile = (name, rx, ry) => { const t = getTex()[name].clone(); t.repeat.set(rx, ry); t.needsUpdate = true; return t }

/* ---------- instancing helper: fills an InstancedMesh on change, and every 250 ms when `live` ---------- */
function Inst({ count, fill, deps = [], live = false, children, ...rest }) {
  const ref = useRef()
  const o = useMemo(() => new THREE.Object3D(), [])
  const c = useMemo(() => new THREE.Color(), [])
  const acc = useRef(0)
  const run = () => {
    const m = ref.current
    if (!m) return
    fill(m, o, c)
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }
  useLayoutEffect(run, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    if (!live) return
    acc.current += dt
    if (acc.current > 0.25) { acc.current = 0; run() }
  })
  return (
    <instancedMesh ref={ref} args={[null, null, Math.max(1, count)]} frustumCulled={false} {...rest}>
      {children}
    </instancedMesh>
  )
}

/* ---------- colour per layer ---------- */
function faceColor(f, mode, T, out) {
  if (mode === 'real') return out.set(palOf(f.sku))
  if (mode === 'fill') return ramp(T.stock, f.qty / f.cap, out)
  if (mode === 'heat') return ramp(T.heat, f.heat, out)
  if (mode === 'repl') return ramp(T.repl, f.repl7 / 42, out)
  if (mode === 'slot') return out.set(f.fit === 'up' ? T.slot.up : f.fit === 'down' ? T.slot.down : T.slot.ok)
  return out.set(T.neutral)
}
const bulkColor = (b, l, mode, T, out) => mode === 'real' ? out.set(palOf(b.sku + l)) : mode === 'fill' ? ramp(T.stock, b.levels / 4, out) : out.set(mode === 'safety' ? T.neutral : T.carton)

/* ---------- pick zone ---------- */
function PickZone({ mode, T, onPick, setHover }) {
  const n = pickFaces.length
  const frame = (m, o) => pickFaces.forEach((f, i) => {
    const [x, z] = W(f.cx, f.cy)
    ;[[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b], k) => put(m, i * 4 + k, o, x + a * (f.w / 2 - 0.04), RACK_H / 2, z + b * (f.d / 2 - 0.04), 0.07, RACK_H, 0.07))
  })
  const shelves = (m, o) => pickFaces.forEach((f, i) => {
    const [x, z] = W(f.cx, f.cy)
    for (let l = 0; l < 4; l++) put(m, i * 4 + l, o, x, 0.08 + l * 0.98, z, f.w, 0.06, f.d)
  })
  const stock = (m, o, c) => pickFaces.forEach((f, i) => {
    const [x, z] = W(f.cx, f.cy), h = 0.08 + (f.qty / f.cap) * 2.6
    put(m, i, o, x, h / 2 + 0.1, z, f.w - 0.2, h, f.d - 0.25)
    m.setColorAt(i, faceColor(f, mode, T, c))
  })
  const bars = (m, o, c) => pickFaces.forEach((f, i) => {
    const [x, z] = W(f.cx, f.cy)
    const t = mode === 'heat' ? f.heat : mode === 'repl' ? Math.min(1, f.repl7 / 42) : 0
    const h = mode === 'heat' || mode === 'repl' ? Math.max(0.1, t * 6) : 0.0001
    put(m, i, o, x, RACK_H + 0.3 + h / 2, z, 1.0, h, 0.9)
    m.setColorAt(i, faceColor(f, mode, T, c))
  })
  const beacons = (m, o, c) => pickFaces.forEach((f, i) => {
    const [x, z] = W(f.cx, f.cy), t = f.task
    put(m, i, o, x, RACK_H + 0.55, z, t ? 1 : 0.0001, t ? 1 : 0.0001, t ? 1 : 0.0001)
    m.setColorAt(i, c.set(t && t.st !== 'queued' ? T.accent : t && f.qty === 0 ? T.crit : T.warn))
  })
  const flags = (m, o, c) => {
    pickFaces.forEach((f, i) => {
      const [x, z] = W(f.cx, f.cy), on = mode === 'slot' && f.fit !== 'ok', s = on ? 1 : 0.0001
      o.rotation.x = f.fit === 'down' ? Math.PI : 0
      put(m, i, o, x, RACK_H + 0.9, z, s, s, s)
      m.setColorAt(i, c.set(f.fit === 'up' ? T.slot.up : T.slot.down))
    })
    o.rotation.x = 0
  }
  const hits = (m, o) => pickFaces.forEach((f, i) => { const [x, z] = W(f.cx, f.cy); put(m, i, o, x, 1.6, z, f.w, 3.2, f.d) })
  const D = [mode, T]
  return (
    <group>
      <Inst count={n * 4} fill={frame} receiveShadow castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.post} roughness={0.5} metalness={0.3} /></Inst>
      <Inst count={n * 4} fill={shelves} receiveShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.shelf} roughness={0.6} metalness={0.2} /></Inst>
      <Inst count={n} fill={stock} deps={D} live castShadow>{box}<meshStandardMaterial roughness={0.8} /></Inst>
      <Inst count={n} fill={bars} deps={D} live>{box}<meshStandardMaterial roughness={0.5} transparent opacity={0.85} /></Inst>
      <Inst count={n} fill={beacons} deps={D} live><sphereGeometry args={[0.2, 12, 12]} /><meshBasicMaterial /></Inst>
      <Inst count={n} fill={flags} deps={D} live><coneGeometry args={[0.32, 0.7, 12]} /><meshStandardMaterial roughness={0.5} /></Inst>
      <Inst count={n} fill={hits}
        onClick={(e) => { e.stopPropagation(); onPick({ type: 'pick', id: pickFaces[e.instanceId].id }) }}
        onPointerMove={(e) => { e.stopPropagation(); setHover({ type: 'pick', id: pickFaces[e.instanceId].id }) }}
        onPointerOut={() => setHover(null)}>
        {box}<meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </Inst>
    </group>
  )
}

/* ---------- pallet racking (bulk zone and sub-warehouse) ---------- */
function RackBlock({ bays, type, mode, T, onPick, setHover }) {
  const n = bays.length
  const posts = (m, o) => bays.forEach((b, i) => {
    const [x, z] = W(b.cx, b.cy)
    ;[[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, c], k) => put(m, i * 4 + k, o, x + a * 0.96, BULK_H / 2, z + c * 0.9, 0.1, BULK_H, 0.1))
  })
  const beams = (m, o) => bays.forEach((b, i) => {
    const [x, z] = W(b.cx, b.cy)
    for (let l = 0; l < 4; l++) { put(m, (i * 4 + l) * 2, o, x, 0.2 + l * LEVEL, z - 0.88, 2, 0.14, 0.09); put(m, (i * 4 + l) * 2 + 1, o, x, 0.2 + l * LEVEL, z + 0.88, 2, 0.14, 0.09) }
  })
  const wood = (m, o) => bays.forEach((b, i) => {
    const [x, z] = W(b.cx, b.cy)
    for (let l = 0; l < 4; l++) { const on = l < b.levels; put(m, i * 4 + l, o, x, 0.2 + l * LEVEL + 0.14, z, on ? 1.7 : 0.0001, on ? 0.14 : 0.0001, on ? 1.6 : 0.0001) }
  })
  const cartons = (m, o, c) => bays.forEach((b, i) => {
    const [x, z] = W(b.cx, b.cy)
    for (let l = 0; l < 4; l++) {
      const on = l < b.levels
      put(m, i * 4 + l, o, x, 0.2 + l * LEVEL + 0.21 + 0.55, z, on ? 1.6 : 0.0001, on ? 1.1 : 0.0001, on ? 1.5 : 0.0001)
      m.setColorAt(i * 4 + l, bulkColor(b, l, mode, T, c))
    }
  })
  const wrap = (m, o) => bays.forEach((b, i) => {
    const [x, z] = W(b.cx, b.cy)
    for (let l = 0; l < 4; l++) { const on = l < b.levels && mode === 'real'; put(m, i * 4 + l, o, x, 0.2 + l * LEVEL + 0.21 + 0.57, z, on ? 1.68 : 0.0001, on ? 1.18 : 0.0001, on ? 1.58 : 0.0001) }
  })
  const hits = (m, o) => bays.forEach((b, i) => { const [x, z] = W(b.cx, b.cy); put(m, i, o, x, BULK_H / 2, z, 2, BULK_H, 2) })
  return (
    <group>
      <Inst count={n * 4} fill={posts} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.post} roughness={0.45} metalness={0.35} /></Inst>
      <Inst count={n * 8} fill={beams} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.beam} roughness={0.45} metalness={0.2} /></Inst>
      <Inst count={n * 4} fill={wood} live castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.wood} roughness={0.9} /></Inst>
      <Inst count={n * 4} fill={cartons} deps={[mode, T]} live castShadow receiveShadow>{box}<meshStandardMaterial roughness={0.8} /></Inst>
      <Inst count={n * 4} fill={wrap} deps={[mode]} live>{box}<meshStandardMaterial color="#ffffff" transparent opacity={0.2} roughness={0.15} depthWrite={false} /></Inst>
      <Inst count={n} fill={hits}
        onClick={(e) => { e.stopPropagation(); onPick({ type, id: bays[e.instanceId].id }) }}
        onPointerMove={(e) => { e.stopPropagation(); setHover({ type, id: bays[e.instanceId].id }) }}
        onPointerOut={() => setHover(null)}>
        {box}<meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </Inst>
    </group>
  )
}

/* ---------- staging: pallets and cartons that follow the simulation counters ---------- */
function StageSet({ count, pos, size, color, vis, y0 = 0 }) {
  const fill = (m, o) => { for (let i = 0; i < count; i++) { const [x, z] = pos(i), s = vis(i) ? 1 : 0.0001; put(m, i, o, x, (size[1] / 2) * s + y0, z, size[0] * s, size[1] * s, size[2] * s) } }
  return <Inst count={count} fill={fill} live castShadow>{box}<meshStandardMaterial color={color} roughness={0.85} /></Inst>
}
function Staging({ T }) {
  const inPos = (i) => W(slotX(i), INSTAGE_Y), outPos = (i) => W(slotX(i), OUTSTAGE_Y)
  const custPos = (i) => W(1.6 + (i % 2) * 1.5, 5 + Math.floor(i / 2) * 1.7)
  return (
    <group>
      <StageSet count={16} pos={inPos} size={[1.1, 0.14, 0.9]} color={T.wood} vis={(i) => i < sim.staging.in} />
      <StageSet count={16} pos={inPos} size={[1.0, 1.0, 0.8]} color={T.carton} y0={0.14} vis={(i) => i < sim.staging.in} />
      <StageSet count={16} pos={outPos} size={[1.1, 0.14, 0.9]} color={T.wood} vis={(i) => i < sim.staging.bulkOut} />
      <StageSet count={16} pos={outPos} size={[1.0, 1.0, 0.8]} color={T.carton} y0={0.14} vis={(i) => i < sim.staging.bulkOut} />
      <StageSet count={36} pos={custPos} size={[1.0, 0.8, 0.9]} color={T.carton} vis={(i) => i < sim.staging.cust} />
    </group>
  )
}

/* ---------- people: animated, anonymous (no real individuals, only roles) ---------- */
function Human({ id, T, vest, hat, getWalk }) {
  const hs = useMemo(() => hash(id), [id])
  const skin = SKIN[hs % SKIN.length], pants = PANTS[(hs >> 3) % PANTS.length], phase = (hs % 100) / 10
  const legL = useRef(), legR = useRef(), armL = useRef(), armR = useRef(), body = useRef()
  useFrame(() => {
    const { walking, speed } = getWalk()
    const t = sim.t * speed * 3.4 + phase, a = walking ? Math.sin(t) * 0.55 : 0
    legL.current.rotation.z = a; legR.current.rotation.z = -a
    armL.current.rotation.z = -a * 0.85; armR.current.rotation.z = a * 0.85
    body.current.position.y = walking ? Math.abs(Math.sin(t)) * 0.03 : 0
  })
  const limb = (ref, z, len, r, col, boot) => (
    <group ref={ref} position={[0, 0.88, z]}>
      <mesh position={[0, -len / 2, 0]} castShadow><capsuleGeometry args={[r, len - 2 * r, 4, 8]} /><meshStandardMaterial color={col} roughness={0.8} /></mesh>
      {boot && <mesh position={[0.05, -len - 0.02, 0]} castShadow><boxGeometry args={[0.26, 0.1, 0.13]} /><meshStandardMaterial color="#1b1b1b" roughness={0.6} /></mesh>}
    </group>
  )
  return (
    <group ref={body}>
      {limb(legL, -0.1, 0.86, 0.075, pants, true)}
      {limb(legR, 0.1, 0.86, 0.075, pants, true)}
      <mesh position={[0, 1.18, 0]} castShadow><capsuleGeometry args={[0.17, 0.34, 4, 10]} /><meshStandardMaterial color={vest} roughness={0.7} /></mesh>
      {[1.1, 1.27].map((y) => <mesh key={y} position={[0, y, 0]} rotation-x={Math.PI / 2}><torusGeometry args={[0.178, 0.014, 6, 20]} /><meshStandardMaterial color="#e9f1f3" roughness={0.3} /></mesh>)}
      <group ref={armL} position={[0, 1.4, -0.24]}><mesh position={[0, -0.27, 0]} castShadow><capsuleGeometry args={[0.052, 0.4, 4, 8]} /><meshStandardMaterial color={vest} roughness={0.8} /></mesh><mesh position={[0, -0.58, 0]}><sphereGeometry args={[0.05, 8, 8]} /><meshStandardMaterial color={skin} /></mesh></group>
      <group ref={armR} position={[0, 1.4, 0.24]}><mesh position={[0, -0.27, 0]} castShadow><capsuleGeometry args={[0.052, 0.4, 4, 8]} /><meshStandardMaterial color={vest} roughness={0.8} /></mesh><mesh position={[0, -0.58, 0]}><sphereGeometry args={[0.05, 8, 8]} /><meshStandardMaterial color={skin} /></mesh></group>
      <mesh position={[0, 1.62, 0]} castShadow><sphereGeometry args={[0.115, 14, 14]} /><meshStandardMaterial color={skin} roughness={0.7} /></mesh>
      <mesh position={[0, 1.67, 0]} castShadow><sphereGeometry args={[0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={hat} roughness={0.5} /></mesh>
    </group>
  )
}

function Worker({ w, T, selected, onPick, setHover }) {
  const g = useRef(), load = useRef(), cart = useRef([])
  const runner = w.role === 'runner'
  useFrame(() => {
    const [x, z] = W(w.x, w.y)
    g.current.position.set(x, 0, z)
    g.current.rotation.y = -w.h
    if (load.current) load.current.visible = !!w.carrying
    const n = Math.min(4, w.idx || 0)
    cart.current.forEach((m, i) => { if (m) m.visible = i < n })
  })
  const walking = () => ({ walking: w.path.length > 0 && !w.held, speed: w.speed || 1.4 })
  return (
    <group ref={g}
      onClick={(e) => { e.stopPropagation(); onPick({ type: 'worker', id: w.id }) }}
      onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'worker', id: w.id }) }}
      onPointerOut={() => setHover(null)}>
      <Human id={w.id} T={T} vest={runner ? T.runner : T.picker} hat={runner ? '#f5f5f2' : '#2d5d8c'} getWalk={walking} />
      {runner ? (
        <group position={[0.95, 0, 0]}>
          <mesh position={[-0.45, 0.55, 0]} rotation-z={0.45}><boxGeometry args={[0.9, 0.04, 0.05]} /><meshStandardMaterial color="#c0392b" /></mesh>
          {[-0.28, 0.28].map((dz) => <mesh key={dz} position={[0.35, 0.07, dz]} castShadow><boxGeometry args={[1.1, 0.1, 0.12]} /><meshStandardMaterial color="#c0392b" metalness={0.3} roughness={0.5} /></mesh>)}
          <group ref={load}>
            <mesh position={[0.35, 0.2, 0]} castShadow><boxGeometry args={[1.0, 0.12, 0.8]} /><meshStandardMaterial color={T.wood} roughness={0.9} /></mesh>
            <RoundedBox args={[0.95, 1.1, 0.75]} radius={0.04} position={[0.35, 0.8, 0]} castShadow><meshStandardMaterial color={palOf(w.id + 'x')} roughness={0.8} /></RoundedBox>
          </group>
        </group>
      ) : (
        <group position={[0.85, 0, 0]}>
          <mesh position={[0, 0.2, 0]} castShadow><boxGeometry args={[0.8, 0.05, 0.6]} /><meshStandardMaterial color={T.steel} metalness={0.5} roughness={0.4} /></mesh>
          {[[-0.36, -0.26], [-0.36, 0.26], [0.36, -0.26], [0.36, 0.26]].map(([dx, dz]) => (
            <group key={dx + '_' + dz}>
              <mesh position={[dx, 0.62, dz]}><boxGeometry args={[0.03, 0.85, 0.03]} /><meshStandardMaterial color={T.steel} metalness={0.5} /></mesh>
              <mesh position={[dx, 0.09, dz]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.07, 0.07, 0.05, 10]} /><meshStandardMaterial color="#1b1b1b" /></mesh>
            </group>))}
          <mesh position={[0, 1.04, 0]}><boxGeometry args={[0.78, 0.03, 0.58]} /><meshStandardMaterial color={T.steel} metalness={0.5} /></mesh>
          {[0, 1, 2, 3].map((i) => <RoundedBox key={i} ref={(m) => { cart.current[i] = m }} args={[0.34, 0.26, 0.4]} radius={0.03} position={[(i % 2) * 0.38 - 0.19, 0.36 + Math.floor(i / 2) * 0.28, (i % 2 ? 0.1 : -0.1)]} castShadow><meshStandardMaterial color={palOf(w.id + i)} roughness={0.8} /></RoundedBox>)}
        </group>
      )}
      {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.04, 0]}><ringGeometry args={[0.7, 0.85, 28]} /><meshBasicMaterial color={T.accent} /></mesh>}
    </group>
  )
}

/* ---------- forklifts, with their safety zones ---------- */
function Forklift({ f, T, mode, disk, selected, onPick, setHover }) {
  const g = useRef(), load = useRef(), beacon = useRef(), slow = useRef(), stop = useRef(), ring = useRef(), op = useRef()
  const strong = mode === 'safety'
  useFrame(() => {
    const [x, z] = W(f.x, f.y)
    g.current.position.set(x, 0, z)
    g.current.rotation.y = -f.h
    if (load.current) load.current.visible = !!f.carrying
    const col = f.factor === 0 ? T.crit : f.factor < 1 ? T.warn : T.ok
    if (beacon.current) beacon.current.color.set(f.factor === 0 ? T.crit : T.accent)
    if (disk && slow.current) {
      slow.current.material.color.set(col); stop.current.material.color.set(col)
      slow.current.visible = stop.current.visible = ring.current.visible = sim.safety.on
    }
  })
  const dark = T.pants
  const wheel = (x, z, r, w) => (
    <group key={x + '_' + z} position={[x, r, z]} rotation-x={Math.PI / 2}>
      <mesh castShadow><cylinderGeometry args={[r, r, w, 18]} /><meshStandardMaterial color="#17191b" roughness={0.9} /></mesh>
      <mesh position={[0, z > 0 ? w / 2 + 0.002 : -w / 2 - 0.002, 0]}><cylinderGeometry args={[r * 0.55, r * 0.55, 0.02, 14]} /><meshStandardMaterial color="#b9c0c5" metalness={0.6} roughness={0.4} /></mesh>
    </group>
  )
  return (
    <group>
      <group ref={g}
        onClick={(e) => { e.stopPropagation(); onPick({ type: 'forklift', id: f.id }) }}
        onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'forklift', id: f.id }) }}
        onPointerOut={() => setHover(null)}>
        <RoundedBox args={[1.7, 0.75, 1.15]} radius={0.12} position={[-0.2, 0.72, 0]} castShadow><meshStandardMaterial color={T.fork} roughness={0.5} metalness={0.2} /></RoundedBox>
        <RoundedBox args={[0.75, 1.0, 1.12]} radius={0.22} position={[-1.15, 0.85, 0]} castShadow><meshStandardMaterial color={T.fork} roughness={0.5} metalness={0.2} /></RoundedBox>
        <mesh position={[-0.2, 0.43, 0]}><boxGeometry args={[1.5, 0.12, 1.0]} /><meshStandardMaterial color={dark} /></mesh>
        <mesh position={[-0.55, 1.2, 0]} rotation-z={-0.1}><boxGeometry args={[0.5, 0.1, 0.55]} /><meshStandardMaterial color={dark} roughness={0.9} /></mesh>
        <mesh position={[-0.82, 1.45, 0]} rotation-z={-0.12}><boxGeometry args={[0.1, 0.55, 0.5]} /><meshStandardMaterial color={dark} roughness={0.9} /></mesh>
        <mesh position={[0.25, 1.35, 0]} rotation-z={0.5}><cylinderGeometry args={[0.15, 0.15, 0.03, 14]} /><meshStandardMaterial color={dark} /></mesh>
        {[[-0.75, -0.5], [-0.75, 0.5], [0.15, -0.5], [0.15, 0.5]].map(([dx, dz]) => <mesh key={dx + '_' + dz} position={[dx, 1.65, dz]}><boxGeometry args={[0.06, 1.05, 0.06]} /><meshStandardMaterial color={dark} metalness={0.4} /></mesh>)}
        {[-0.4, -0.15, 0.1, 0.35, 0.6].map((dx) => <mesh key={dx} position={[dx - 0.15, 2.19, 0]}><boxGeometry args={[0.07, 0.05, 1.08]} /><meshStandardMaterial color={dark} metalness={0.4} /></mesh>)}
        <mesh position={[-0.3, 2.31, 0]}><sphereGeometry args={[0.13, 12, 12]} /><meshBasicMaterial ref={beacon} color={T.accent} /></mesh>
        {[-0.45, 0.45].map((dz) => <mesh key={dz} position={[0.7, 1.25, dz]} castShadow><boxGeometry args={[0.12, 2.5, 0.1]} /><meshStandardMaterial color="#5e6a73" metalness={0.6} roughness={0.4} /></mesh>)}
        <mesh position={[0.78, 0.55, 0]} castShadow><boxGeometry args={[0.1, 0.75, 1.0]} /><meshStandardMaterial color="#5e6a73" metalness={0.5} /></mesh>
        {[-0.35, 0.35].map((dz) => <mesh key={dz} position={[1.55, 0.12, dz]} castShadow><boxGeometry args={[1.7, 0.07, 0.14]} /><meshStandardMaterial color="#6b7780" metalness={0.6} roughness={0.4} /></mesh>)}
        {wheel(0.35, -0.62, 0.3, 0.26)}{wheel(0.35, 0.62, 0.3, 0.26)}{wheel(-1.0, -0.6, 0.24, 0.22)}{wheel(-1.0, 0.6, 0.24, 0.22)}
        <group position={[-0.5, 0, 0]} ref={op}>
          <mesh position={[0, 1.33, 0]} castShadow><capsuleGeometry args={[0.15, 0.3, 4, 8]} /><meshStandardMaterial color={T.runner} roughness={0.7} /></mesh>
          <mesh position={[0, 1.7, 0]}><sphereGeometry args={[0.11, 10, 10]} /><meshStandardMaterial color={SKIN[hash(f.id) % SKIN.length]} /></mesh>
          <mesh position={[0, 1.76, 0]}><sphereGeometry args={[0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color="#f5f5f2" /></mesh>
        </group>
        <group ref={load} position={[1.55, 0, 0]}>
          <mesh position={[0, 0.27, 0]} castShadow><boxGeometry args={[1.1, 0.14, 0.9]} /><meshStandardMaterial color={T.wood} roughness={0.9} /></mesh>
          <RoundedBox args={[1.0, 1.1, 0.8]} radius={0.05} position={[0, 0.9, 0]} castShadow><meshStandardMaterial color={palOf(f.id + 'p')} roughness={0.8} /></RoundedBox>
        </group>
        {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}><ringGeometry args={[1.8, 2.0, 28]} /><meshBasicMaterial color={T.accent} /></mesh>}
      </group>
      {disk && <DiskFollow f={f} slow={slow} stop={stop} ring={ring} strong={strong} />}
    </group>
  )
}
function DiskFollow({ f, slow, stop, ring, strong }) {
  const g = useRef()
  useFrame(() => { const [x, z] = W(f.x, f.y); g.current.position.set(x, 0.06, z) })
  return (
    <group ref={g}>
      <mesh ref={slow} rotation-x={-Math.PI / 2}><circleGeometry args={[SLOW_R, 48]} /><meshBasicMaterial transparent opacity={strong ? 0.13 : 0.05} depthWrite={false} /></mesh>
      <mesh ref={stop} rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}><circleGeometry args={[STOP_R, 40]} /><meshBasicMaterial transparent opacity={strong ? 0.3 : 0.12} depthWrite={false} /></mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}><ringGeometry args={[SLOW_R - 0.08, SLOW_R, 64]} /><meshBasicMaterial color="#ffffff" transparent opacity={strong ? 0.5 : 0.18} depthWrite={false} /></mesh>
    </group>
  )
}

/* ---------- packing area ---------- */
function Bench({ b, T, selected, onPick, setHover }) {
  const [x, z] = W(b.x, b.y)
  const top = useRef(), cartons = useRef([]), acc = useRef(0)
  useFrame((_, dt) => {
    acc.current += dt
    if (acc.current > 0.2) {
      acc.current = 0
      const show = Math.min(4, b.queue + (b.busy ? 1 : 0))
      cartons.current.forEach((m, i) => { if (m) m.visible = i < show })
      if (top.current) top.current.color.set(b.busy ? T.accent : T.wall)
    }
  })
  return (
    <group position={[x, 0, z]}
      onClick={(e) => { e.stopPropagation(); onPick({ type: 'pack', id: b.id }) }}
      onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'pack', id: b.id }) }}
      onPointerOut={() => setHover(null)}>
      <RoundedBox args={[2.8, 1.0, 1.1]} radius={0.05} position={[0, 0.5, 0]} castShadow><meshStandardMaterial color={T.shelf} metalness={0.3} roughness={0.6} /></RoundedBox>
      <RoundedBox args={[2.9, 0.06, 1.2]} radius={0.02} position={[0, 1.03, 0]} castShadow><meshStandardMaterial ref={top} color={T.wall} /></RoundedBox>
      <mesh position={[0, 1.55, -0.52]}><boxGeometry args={[1.0, 0.45, 0.04]} /><meshStandardMaterial color="#10161b" emissive="#2a6fdb" emissiveIntensity={0.5} /></mesh>
      {[-1, -0.35, 0.3, 0.95].map((dx, i) => (
        <RoundedBox key={i} ref={(m) => { cartons.current[i] = m }} args={[0.55, 0.5, 0.65]} radius={0.04} position={[dx, 1.34, 0.05]} castShadow><meshStandardMaterial color={palOf(b.id + i)} roughness={0.8} /></RoundedBox>
      ))}
      <group position={[0, 0, 1.15]} rotation-y={Math.PI}><Human id={b.id} T={T} vest={T.pack} hat="#e9edf0" getWalk={() => ({ walking: b.busy, speed: 0.5 })} /></group>
      {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.04, 0]}><ringGeometry args={[1.9, 2.1, 32]} /><meshBasicMaterial color={T.accent} /></mesh>}
    </group>
  )
}
function PackArea({ T, sel, onPick, setHover }) {
  return sim.benches.map((b) => <Bench key={b.id} b={b} T={T} selected={sel.type === 'pack' && sel.id === b.id} onPick={onPick} setHover={setHover} />)
}

/* ---------- safety framework visuals: zones, gates, traffic lights ---------- */
function SafetyLayer({ mode, T }) {
  const strong = mode === 'safety'
  const plane = (x0, y0, x1, y1, color, op, key, y = 0.015, map) => {
    const [cx, cz] = W((x0 + x1) / 2, (y0 + y1) / 2)
    return <mesh key={key} rotation-x={-Math.PI / 2} position={[cx, y, cz]}><planeGeometry args={[x1 - x0, y1 - y0]} /><meshBasicMaterial color={color} map={map} transparent opacity={op} depthWrite={false} /></mesh>
  }
  const label = (txt, x, y, color) => { const [px, pz] = W(x, y); return strong ? <Html key={txt} position={[px, 0.2, pz]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}><div className="zlabel" style={{ color }}>{txt}</div></Html> : null }
  const postFill = (m, o) => { let i = 0; A.forEach((y, a) => { [[60.2, a], [33.1, a]].forEach(([x]) => { const [px, pz] = W(x, y - 1.7); put(m, i++, o, px, 1.1, pz, 0.12, 2.2, 0.12) }) }) }
  const lamps = (m, o, c) => {
    A.forEach((y, a) => {
      const L = sim.locks[a], off = !sim.safety.on
      const [ex, ez] = W(60.2, y - 1.7), [wx, wz] = W(33.1, y - 1.7)
      put(m, a, o, ex, 2.35, ez, 1, 1, 1)
      m.setColorAt(a, c.set(off ? T.neutral : L.type === 'ped' ? T.crit : T.ok))
      const west = a >= 1 && a <= 4
      put(m, 6 + a, o, wx, 2.35, wz, west ? 1 : 0.0001, west ? 1 : 0.0001, west ? 1 : 0.0001)
      m.setColorAt(6 + a, c.set(off ? T.neutral : L.type === 'fork' ? T.crit : T.ok))
    })
  }
  const hz = useMemo(() => { const t = tile('hazard', 1, 1); t.repeat.set(1, 1.2); return t }, [])
  return (
    <group>
      {plane(FORK_X, 4.5, 59.5, 38, T.warn, strong ? 0.2 : 0.04, 'fz')}
      {plane(33, 4.5, FORK_X, 38, T.ok, strong ? 0.2 : 0.04, 'rz')}
      {plane(59.5, 0, 65, 40, T.warn, strong ? 0.3 : 0.08, 'lane')}
      {plane(5, 4.5, 31, 38, T.ok, strong ? 0.14 : 0, 'pz')}
      {A.map((y, a) => plane(33.6, y - 1.3, 35.6, y + 1.3, '#ffffff', strong ? 0.95 : 0.7, 'g' + a, 0.03, hz))}
      <Inst count={A.length * 2} fill={postFill}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color="#2a2f33" metalness={0.4} /></Inst>
      <Inst count={12} fill={lamps} live><sphereGeometry args={[0.28, 14, 14]} /><meshBasicMaterial /></Inst>
      {label('FORKLIFT ZONE', 51, 21, T.warn)}
      {label('RUNNER RESERVE', 37.5, 21, T.ok)}
      {label('PEDESTRIANS ONLY', 18, 21, T.ok)}
      {label('FORKLIFT LANE', 62.3, 21, T.warn)}
    </group>
  )
}

/* ---------- trucks: rigid distribution trucks with carrier colours ---------- */
function Wheel({ x, z, r = 0.5, w = 0.32 }) {
  return (
    <group position={[x, r, z]} rotation-x={Math.PI / 2}>
      <mesh castShadow><cylinderGeometry args={[r, r, w, 22]} /><meshStandardMaterial color="#141618" roughness={0.9} /></mesh>
      <mesh position={[0, z > 0 ? w / 2 + 0.003 : -w / 2 - 0.003, 0]}><cylinderGeometry args={[r * 0.58, r * 0.58, 0.02, 18]} /><meshStandardMaterial color="#c7ced3" metalness={0.7} roughness={0.35} /></mesh>
    </group>
  )
}
function Truck({ t, T, selected, onPick, setHover }) {
  const g = useRef(), lab = useRef(), fill = useRef(), acc = useRef(1), dl = useRef(), dr = useRef(), inner = useRef(), open = useRef(0)
  const xfer = t.dir === 'xfer'
  const liv = xfer ? { body: '#efe9fb', stripe: T.lane, cab: T.lane } : LIV[t.car] || LIV['Noordvaart Freight']
  useFrame((_, dt) => {
    const [x, z] = W(t.x, t.y)
    g.current.position.set(x, 0, z)
    g.current.rotation.y = -t.h
    const want = t.st === 'docked' || t.st === 'waiting' ? 1 : 0
    open.current += (want - open.current) * Math.min(1, dt * 2.5)
    const a = open.current * 1.75
    if (dl.current) { dl.current.rotation.y = -a; dr.current.rotation.y = a; inner.current.visible = open.current > 0.05 }
    acc.current += dt
    if (acc.current > 0.25) {
      acc.current = 0
      let txt
      if (xfer) txt = t.label
      else {
        const eta = Math.max(0, Math.ceil(((1 - t.progress) * truckSeconds(t)) / 60))
        txt = t.st === 'waiting' ? `Waiting ${Math.round(t.waited / 60)} min` : t.st === 'queue' ? 'In yard queue' : t.st === 'arriving' ? 'Arriving' : t.st === 'leaving' ? 'Leaving'
          : `${t.dir === 'in' ? 'Unloading' : 'Loading'} ${Math.round(t.progress * 100)}% · ${eta} min`
      }
      if (lab.current) lab.current.textContent = `${t.id} · ${txt}`
      if (fill.current) { fill.current.style.width = (t.st === 'docked' ? t.progress * 100 : 0) + '%'; fill.current.style.background = t.st === 'waiting' ? T.warn : T.ok }
    }
  })
  const glass = <meshStandardMaterial color="#1b2a36" roughness={0.12} metalness={0.7} />
  return (
    <group ref={g}
      onClick={(e) => { e.stopPropagation(); onPick({ type: 'truck', id: t.id }) }}
      onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'truck', id: t.id }) }}
      onPointerOut={() => setHover(null)}>
      {/* chassis */}
      <mesh position={[0, 0.85, 0]} castShadow><boxGeometry args={[11.4, 0.28, 1.2]} /><meshStandardMaterial color="#2a2f33" roughness={0.7} metalness={0.4} /></mesh>
      {/* box body with livery */}
      <RoundedBox args={[8.0, 2.75, 2.5]} radius={0.1} smoothness={3} position={[-1.8, 2.35, 0]} castShadow><meshStandardMaterial color={liv.body} roughness={0.55} /></RoundedBox>
      <mesh position={[-1.8, 1.6, 0]}><boxGeometry args={[7.9, 0.34, 2.53]} /><meshStandardMaterial color={liv.stripe} roughness={0.5} /></mesh>
      <mesh position={[-0.2, 2.9, 0]}><boxGeometry args={[2.2, 0.8, 2.53]} /><meshStandardMaterial color={liv.stripe} roughness={0.5} /></mesh>
      {[-4.9, -3.6, -2.3, -1.0, 0.3, 1.6].map((rx) => <mesh key={rx} position={[rx, 2.35, 0]}><boxGeometry args={[0.07, 2.6, 2.56]} /><meshStandardMaterial color="#c9d1d6" roughness={0.6} /></mesh>)}
      {/* rear: lights, bumper, doors, dark interior */}
      <mesh position={[-5.86, 1.15, 0]}><boxGeometry args={[0.2, 0.18, 2.3]} /><meshStandardMaterial color="#9aa3a9" metalness={0.6} roughness={0.4} /></mesh>
      {[-1.08, 1.08].map((dz) => <mesh key={dz} position={[-5.82, 1.55, dz]}><boxGeometry args={[0.06, 0.34, 0.2]} /><meshStandardMaterial color="#c0291f" emissive="#c0291f" emissiveIntensity={0.5} /></mesh>)}
      <mesh ref={inner} position={[-5.79, 2.45, 0]} rotation-y={-Math.PI / 2} visible={false}><planeGeometry args={[2.3, 2.45]} /><meshBasicMaterial color="#0b0f12" /></mesh>
      <group ref={dl} position={[-5.82, 2.4, -1.25]}><mesh position={[0, 0, 0.62]} castShadow><boxGeometry args={[0.05, 2.5, 1.22]} /><meshStandardMaterial color={liv.body} roughness={0.55} /></mesh></group>
      <group ref={dr} position={[-5.82, 2.4, 1.25]}><mesh position={[0, 0, -0.62]} castShadow><boxGeometry args={[0.05, 2.5, 1.22]} /><meshStandardMaterial color={liv.body} roughness={0.55} /></mesh></group>
      {/* cab */}
      <RoundedBox args={[2.9, 1.5, 2.45]} radius={0.16} position={[4.45, 1.6, 0]} castShadow><meshStandardMaterial color={liv.cab} roughness={0.4} metalness={0.15} /></RoundedBox>
      <RoundedBox args={[2.2, 1.55, 2.4]} radius={0.2} position={[4.1, 2.95, 0]} castShadow><meshStandardMaterial color={liv.cab} roughness={0.4} metalness={0.15} /></RoundedBox>
      <mesh position={[5.22, 3.0, 0]} rotation-z={0.1}><boxGeometry args={[0.06, 1.1, 2.2]} />{glass}</mesh>
      {[-1.215, 1.215].map((dz) => <mesh key={dz} position={[4.3, 3.05, dz]}><boxGeometry args={[1.3, 0.85, 0.04]} />{glass}</mesh>)}
      <mesh position={[5.95, 1.35, 0]}><boxGeometry args={[0.08, 0.55, 1.5]} /><meshStandardMaterial color="#1a1d20" roughness={0.6} /></mesh>
      {[-0.95, 0.95].map((dz) => <mesh key={dz} position={[5.93, 1.75, dz]}><boxGeometry args={[0.08, 0.25, 0.4]} /><meshStandardMaterial color="#fff6d6" emissive="#fff0b0" emissiveIntensity={0.6} /></mesh>)}
      <mesh position={[6.0, 0.8, 0]} castShadow><boxGeometry args={[0.28, 0.34, 2.5]} /><meshStandardMaterial color="#8a949b" metalness={0.6} roughness={0.4} /></mesh>
      {[-1.4, 1.4].map((dz) => <group key={dz}><mesh position={[5.35, 3.0, dz]}><boxGeometry args={[0.05, 0.05, 0.3]} /><meshStandardMaterial color="#222" /></mesh><mesh position={[5.35, 2.9, dz * 1.04]}><boxGeometry args={[0.14, 0.5, 0.1]} /><meshStandardMaterial color="#222" /></mesh></group>)}
      <mesh position={[3.15, 3.55, 1.0]} castShadow><cylinderGeometry args={[0.07, 0.07, 1.5, 10]} /><meshStandardMaterial color="#c4cbd0" metalness={0.8} roughness={0.3} /></mesh>
      <mesh position={[1.9, 0.85, 1.05]} rotation-z={Math.PI / 2} castShadow><cylinderGeometry args={[0.32, 0.32, 1.6, 14]} /><meshStandardMaterial color="#aeb7bd" metalness={0.7} roughness={0.35} /></mesh>
      {/* wheels: steered front axle and dual rear axles */}
      {[-1.15, 1.15].map((dz) => <Wheel key={'f' + dz} x={4.55} z={dz} />)}
      {[-3.7, -2.35].flatMap((xx) => [-1.15, 1.15, -0.78, 0.78].map((zz) => <Wheel key={xx + '_' + zz} x={xx} z={zz} />))}
      {[-3.0].flatMap((xx) => [-1.3, 1.3].map((zz) => <mesh key={zz} position={[xx, 1.1, zz]}><boxGeometry args={[2.6, 0.06, 0.4]} /><meshStandardMaterial color="#1c2024" /></mesh>))}
      <Html position={[0, 5.0, 0]} center zIndexRange={[15, 5]} style={{ pointerEvents: 'none' }}>
        <div className="tbadge"><span ref={lab} /><i><b ref={fill} /></i></div>
      </Html>
      {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}><ringGeometry args={[6.4, 6.8, 40]} /><meshBasicMaterial color={T.accent} /></mesh>}
    </group>
  )
}
function Trucks({ T, sel, onPick, setHover }) {
  const [, setV] = useState(0), seen = useRef(-1)
  useFrame(() => { if (seen.current !== sim.truckVersion) { seen.current = sim.truckVersion; setV((v) => v + 1) } })
  return sim.trucks.map((t) => <Truck key={t.id} t={t} T={T} selected={sel.type === 'truck' && sel.id === t.id} onPick={onPick} setHover={setHover} />)
}

/* ---------- docks, walls, floors ---------- */
const dockGeom = (d, depth = 1.1) => {
  const c = (d.a + d.b) / 2, len = d.b - d.a
  if (d.wall === 'y') return { pos: W(c, depth), size: [len, 2.2] }
  if (d.wall === 'x') return { pos: W(depth, c), size: [2.2, len] }
  if (d.wall === 's') return { pos: W(c, HALL.d - depth), size: [len, 2.2] }
  return { pos: W(c, SUBHALL.y0 + depth), size: [len, 2.2] }
}
function DockStrip({ d, T }) {
  const m = useRef(), { pos, size } = dockGeom(d)
  useFrame(() => { if (m.current) { const cls = dockStatus(d).cls; m.current.color.set(cls === 'ok' ? T.ok : cls === 'warn' ? T.warn : T.neutral) } })
  return <mesh rotation-x={-Math.PI / 2} position={[pos[0], 0.02, pos[1]]}><planeGeometry args={size} /><meshBasicMaterial ref={m} transparent opacity={0.45} /></mesh>
}
// rolling door, rubber dock shelter and a number plate, built in a frame where the wall runs along local x and outside is local +z
const ROT = { y: Math.PI, n2: Math.PI, s: 0, x: -Math.PI / 2 }
function DockDoor({ d, T }) {
  const c = (d.a + d.b) / 2, len = d.b - d.a
  const [px, pz] = d.wall === 'y' ? W(c, -0.2) : d.wall === 'x' ? W(-0.2, c) : d.wall === 's' ? W(c, HALL.d) : W(c, SUBHALL.y0 - 0.2)
  const panel = useRef(), cur = useRef(1), hasWall = d.wall !== 's'
  useFrame((_, dt) => {
    const t = sim.trucks.find((x) => x.dock === d.id && x.st !== 'leaving')
    const target = t && (t.st === 'docked' || t.st === 'arriving' || t.st === 'waiting') ? 0.04 : 1
    cur.current += (target - cur.current) * Math.min(1, dt * 2)
    if (panel.current) panel.current.scale.y = cur.current
  })
  const black = <meshStandardMaterial color="#17191b" roughness={0.95} />
  return (
    <group position={[px, 0, pz]} rotation-y={ROT[d.wall]}>
      {hasWall && <group ref={panel} position={[0, 4.0, 0]}>
        <mesh position={[0, -2, 0]}><boxGeometry args={[len - 0.1, 4.0, 0.1]} /><meshStandardMaterial color={T.door} roughness={0.5} metalness={0.3} /></mesh>
        {[-3.2, -2.4, -1.6, -0.8].map((y) => <mesh key={y} position={[0, y, 0.06]}><boxGeometry args={[len - 0.1, 0.05, 0.03]} /><meshStandardMaterial color="#6f7b84" /></mesh>)}
      </group>}
      {[-1, 1].map((s) => <mesh key={s} position={[s * (len / 2 + 0.12), 2.1, 0.5]} castShadow>{<boxGeometry args={[0.4, 4.2, 0.9]} />}{black}</mesh>)}
      <mesh position={[0, 4.25, 0.5]} castShadow><boxGeometry args={[len + 0.9, 0.4, 0.9]} />{black}</mesh>
      {[-1, 1].map((s) => <mesh key={'b' + s} position={[s * (len / 2 - 0.4), 0.2, 1.4]}><boxGeometry args={[0.5, 0.4, 0.4]} />{black}</mesh>)}
      <mesh position={[0, 0.06, -0.9]} receiveShadow><boxGeometry args={[len - 0.4, 0.1, 1.8]} /><meshStandardMaterial color="#7f8b94" metalness={0.6} roughness={0.5} /></mesh>
      <Html position={[0, 4.9, 0.4]} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}><div className="dlabel">{d.id}</div></Html>
    </group>
  )
}

function Shell({ x0, y0, w, wallH, northDocks, westDocks, T }) {
  const doorH = 4.0, parts = []
  const wall = (axis, docks, len) => {
    const ds = docks.slice().sort((a, b) => a.a - b.a)
    const piece = (a, b, key, lo, hi) => {
      const l = b - a, mid = (a + b) / 2, [x, z] = axis === 'y' ? W(mid, y0 - 0.2) : W(x0 - 0.2, mid)
      const size = (th, h) => (axis === 'y' ? [l, h, th] : [th, h, l])
      parts.push(
        <group key={key}>
          <mesh position={[x, (lo + hi) / 2, z]} castShadow receiveShadow><boxGeometry args={size(0.4, hi - lo)} /><meshStandardMaterial color={T.wall} map={tile('corr', Math.max(1, l * 1.2), 1)} roughness={0.8} /></mesh>
          {lo === 0 && <mesh position={[x + (axis === 'y' ? 0 : -0.03), 0.55, z + (axis === 'y' ? -0.03 : 0)]}><boxGeometry args={size(0.46, 1.1)} /><meshStandardMaterial color={T.wallBase} roughness={0.6} /></mesh>}
          <mesh position={[x, hi + 0.08, z]}><boxGeometry args={size(0.5, 0.16)} /><meshStandardMaterial color={T.steel} metalness={0.4} roughness={0.5} /></mesh>
        </group>)
    }
    let at = axis === 'y' ? x0 : y0
    ds.forEach((d, i) => { if (d.a > at) piece(at, d.a, axis + i, 0, wallH); piece(d.a, d.b, axis + 'l' + i, doorH, wallH); at = d.b })
    piece(at, len, axis + 'end', 0, wallH)
    // steel columns along the wall, skipped in front of doors
    for (let s = (axis === 'y' ? x0 : y0); s <= len; s += 6) {
      if (ds.some((d) => s > d.a - 0.6 && s < d.b + 0.6)) continue
      const [x, z] = axis === 'y' ? W(s, y0 - 0.5) : W(x0 - 0.5, s)
      parts.push(<mesh key={axis + 'c' + s} position={[x, (wallH + 0.2) / 2, z]} castShadow><cylinderGeometry args={[0.2, 0.2, wallH + 0.2, 12]} /><meshStandardMaterial color={T.steel} metalness={0.5} roughness={0.45} /></mesh>)
    }
  }
  wall('y', northDocks, x0 + w)
  wall('x', westDocks, y0 + (y0 === 0 ? HALL.d : SUBHALL.d))
  return <group>{parts}</group>
}

function Floor({ T, sel, mode }) {
  const planes = useMemo(() => ({
    hall: tile('concrete', HALL.w / 5.5, HALL.d / 5.5), sub: tile('concrete', SUBHALL.w / 5.5, SUBHALL.d / 5.5),
    yard: tile('asphalt', 30, 24), grass: tile('grass', 60, 50), slots: (() => { const t = getTex().slots.clone(); t.needsUpdate = true; return t })(),
  }), [])
  const plane = (x0, y0, x1, y1, color, op, key, y = 0.01, map) => {
    const [cx, cz] = W((x0 + x1) / 2, (y0 + y1) / 2)
    return <mesh key={key} rotation-x={-Math.PI / 2} position={[cx, y, cz]} receiveShadow><planeGeometry args={[x1 - x0, y1 - y0]} /><meshStandardMaterial color={color} map={map} transparent={op < 1} opacity={op} roughness={0.95} /></mesh>
  }
  const label = (txt, x, y, color) => {
    const [px, pz] = W(x, y)
    return <Html key={txt} position={[px, 0.1, pz]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}><div className="zlabel" style={{ color }}>{txt}</div></Html>
  }
  const selDock = sel.type === 'dock' && DOCKS.find((x) => x.id === sel.id)
  const dashes = useMemo(() => {
    const out = []
    for (let x = -22; x < 90; x += 6) out.push([x + 1.5, -17, 3, 0.25])           // north road
    for (let y = -18; y < 62; y += 6) out.push([-17, y + 1.5, 0.25, 3])            // west road
    for (let x = -20; x < 90; x += 6) out.push([x + 1.5, ROAD_Y, 3, 0.25])         // transfer road
    return out
  }, [])
  const dash = (m, o) => dashes.forEach((d, i) => { const [x, z] = W(d[0], d[1]); put(m, i, o, x, 0.0, z, d[2], 1, d[3]) })
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.12, 25]} receiveShadow><planeGeometry args={[700, 600]} /><meshStandardMaterial color={T.grass} map={planes.grass} roughness={1} /></mesh>
      {plane(-26, -24, 96, 62, T.yard, 1, 'yard', -0.06, planes.yard)}
      {plane(16, 62, 64, 98, T.yard, 1, 'subyard', -0.055, planes.yard)}
      {plane(-23, -20, 90, -14, T.road, 1, 'roadN', -0.04)}
      {plane(-20, -20, -14, 62, T.road, 1, 'roadW', -0.035)}
      {plane(-20, ROAD_Y - 3, 90, ROAD_Y + 3, T.road, 1, 'roadS', -0.04)}
      {plane(72, 28, 80, ROAD_Y + 3, T.road, 1, 'roadE', -0.038)}
      <Inst count={dashes.length} fill={dash}><boxGeometry args={[1, 0.02, 1]} /><meshBasicMaterial color="#e9edf0" /></Inst>
      {plane(0, 0, HALL.w, HALL.d, T.floor, 1, 'f', 0, planes.hall)}
      {plane(5, 4.5, 31, 36.4, T.pickZone, 0.1, 'pz')}
      {plane(5, 36.4, 31, HALL.d, T.pack, 0.28, 'pack')}
      {plane(33, 4.5, 59.5, 38, T.bulkZone, 0.1, 'bz')}
      {plane(30.4, 2, 33.6, 38, T.lane, 0.22, 'lane')}
      {plane(0.4, 4, 3.6, 36, T.stage, 0.16, 'stage')}
      {plane(33, 3.5, 59.5, 5.9, T.receiving, 0.22, 'instage')}
      {plane(33, 32.9, 59.5, 35.1, T.lane, 0.18, 'outstage')}
      {(() => { const [cx, cz] = W(46.25, 4.7); return <mesh rotation-x={-Math.PI / 2} position={[cx, 0.03, cz]}><planeGeometry args={[24, 1.7]} /><meshBasicMaterial map={planes.slots} transparent depthWrite={false} /></mesh> })()}
      {(() => { const [cx, cz] = W(46.25, 34); return <mesh rotation-x={-Math.PI / 2} position={[cx, 0.03, cz]}><planeGeometry args={[24, 1.7]} /><meshBasicMaterial map={planes.slots} transparent depthWrite={false} /></mesh> })()}
      {plane(33, 0.4, 66, 3.4, T.receiving, 0.08, 'recv')}
      {plane(SUBHALL.x0, SUBHALL.y0, SUBHALL.x0 + SUBHALL.w, SUBHALL.y0 + SUBHALL.d, T.floor, 1, 'subf', 0, planes.sub)}
      {plane(24, 72, 50, 90, T.bulkZone, 0.1, 'subz')}
      {DOCKS.map((d) => <DockStrip key={d.id} d={d} T={T} />)}
      {DOCKS.map((d) => <DockDoor key={d.id} d={d} T={T} />)}
      {selDock && (() => { const { pos } = dockGeom(selDock); return <mesh rotation-x={-Math.PI / 2} position={[pos[0], 0.05, pos[1]]}><ringGeometry args={[2.4, 2.7, 4, 1, Math.PI / 4]} /><meshBasicMaterial color={T.accent} /></mesh> })()}
      {label('PICK ZONE', 18, 2.2, T.pickZone)}
      {label('PACKING', 18, 39.2, T.pack)}
      {label('RECEIVING · INBOUND STAGING', 46, 4.7, T.receiving)}
      {label('BULK STAGING · TRANSFERS', 46, 34, T.lane)}
      {label('REPLEN LANE', 32, 1.5, T.lane)}
      {label('OUTBOUND STAGING', 2, 2.2, T.stage)}
      {label('TRANSFER ROAD', 48, ROAD_Y + 1.8, T.yardText)}
      {label('YARD', 50, -26, T.yardText)}
      {label('SUB-WAREHOUSE', 40, 93.5, T.bulkZone)}
    </group>
  )
}

/* ---------- surroundings: trees, light poles, cars, containers, gatehouse, cones ---------- */
function Surroundings({ T, dark }) {
  const trees = useMemo(() => {
    let s = 13; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    const out = []
    while (out.length < 110) {
      const x = -90 + r() * 220, y = -80 + r() * 200
      const near = (x > -30 && x < 100 && y > -28 && y < 66) || (x > 12 && x < 68 && y > 62 && y < 100)
      if (!near) out.push([x, y, 0.8 + r() * 0.9, r()])
    }
    return out
  }, [])
  const trunks = (m, o) => trees.forEach((t, i) => { const [x, z] = W(t[0], t[1]); put(m, i, o, x, 1.0 * t[2], z, 0.35 * t[2], 2 * t[2], 0.35 * t[2]) })
  const crowns = (m, o, c) => trees.forEach((t, i) => { const [x, z] = W(t[0], t[1]); put(m, i, o, x, 3.2 * t[2], z, 2.3 * t[2], 2.2 * t[2], 2.3 * t[2]); m.setColorAt(i, c.set(dark ? '#2f5535' : t[3] > 0.5 ? '#4c8a46' : '#5f9b4f')) })
  const crowns2 = (m, o, c) => trees.forEach((t, i) => { const [x, z] = W(t[0], t[1]); put(m, i, o, x, 4.6 * t[2], z, 1.5 * t[2], 1.5 * t[2], 1.5 * t[2]); m.setColorAt(i, c.set(dark ? '#3a6540' : '#6fae5a')) })
  const poles = useMemo(() => {
    const p = []
    for (let x = -8; x <= 84; x += 16) p.push([x, -12.5, 1])
    for (let y = 4; y <= 52; y += 16) p.push([-12.5, y, 2])
    for (let x = -8; x <= 84; x += 16) p.push([x, 50.5, 3])
    return p
  }, [])
  const pole = (m, o) => poles.forEach((p, i) => { const [x, z] = W(p[0], p[1]); put(m, i, o, x, 4.0, z, 0.18, 8, 0.18) })
  const head = (m, o) => poles.forEach((p, i) => { const [x, z] = W(p[0], p[1]); put(m, i, o, x, 8.1, z, 0.9, 0.18, 0.5) })
  const cones = useMemo(() => [[59.2, 1.5], [59.2, 38.5], [65.2, 1.5], [65.2, 38.5], [35, -3.2], [58, -3.2], [-3.2, 9], [-3.2, 33], [31, 41.5], [5, 41.5], [33.6, 2], [33.6, 38.5]], [])
  const cone = (m, o) => cones.forEach((p, i) => { const [x, z] = W(p[0], p[1]); put(m, i, o, x, 0.35, z, 1, 1, 1) })
  const cars = useMemo(() => Array.from({ length: 12 }, (_, i) => ({ x: 4 + (i % 10) * 3.1, y: i < 10 ? 45.5 : 49.8, c: CAR_COLORS[(i * 7 + 3) % CAR_COLORS.length], n: i })), [])
  const lines = (m, o) => { for (let i = 0; i <= 10; i++) { const [x, z] = W(2.5 + i * 3.1, 45.5); put(m, i, o, x, 0.0, z, 0.1, 1, 4.6) } }
  const containers = [[72, -30, '#b3472f', 0], [72, -30, '#2f6aa3', 1], [85, -30, '#3a8a52', 0], [72, -26.4, '#c9962c', 0]]
  const corr = useMemo(() => tile('corr', 6, 1), [])
  const [gx, gz] = W(80, -11)
  const barrier = useRef()
  useFrame(() => { if (barrier.current) barrier.current.rotation.z = sim.trucks.some((t) => t.dir !== 'xfer' && t.st === 'arriving' && t.x > 60 && t.y < -10) ? 1.2 : 0 })
  return (
    <group>
      <Inst count={trees.length} fill={trunks} castShadow><cylinderGeometry args={[0.5, 0.7, 1, 8]} /><meshStandardMaterial color="#6b4a33" roughness={1} /></Inst>
      <Inst count={trees.length} fill={crowns} deps={[dark]} castShadow><icosahedronGeometry args={[1, 1]} /><meshStandardMaterial roughness={0.95} flatShading /></Inst>
      <Inst count={trees.length} fill={crowns2} deps={[dark]} castShadow><icosahedronGeometry args={[1, 1]} /><meshStandardMaterial roughness={0.95} flatShading /></Inst>
      <Inst count={poles.length} fill={pole} castShadow><cylinderGeometry args={[0.5, 0.7, 1, 8]} /><meshStandardMaterial color="#8c969d" metalness={0.6} roughness={0.4} /></Inst>
      <Inst count={poles.length} fill={head}>{box}<meshStandardMaterial color="#fff3c8" emissive="#ffe9a0" emissiveIntensity={dark ? 1.4 : 0.35} /></Inst>
      <Inst count={cones.length} fill={cone} castShadow><coneGeometry args={[0.28, 0.7, 12]} /><meshStandardMaterial color="#ff6a1a" roughness={0.6} /></Inst>
      {containers.map(([x, y, col, lvl], i) => { const [cx, cz] = W(x, y); return (
        <mesh key={i} position={[cx, 1.3 + lvl * 2.6, cz]} castShadow receiveShadow><boxGeometry args={[12, 2.6, 2.45]} /><meshStandardMaterial color={col} map={corr} roughness={0.6} metalness={0.2} /></mesh>) })}
      {cars.map((c) => <Car key={c.n} x={c.x} y={c.y} color={c.c} dir={c.y < 47 ? -Math.PI / 2 : Math.PI / 2} />)}
      <Inst count={11} fill={lines}><boxGeometry args={[1, 0.02, 1]} /><meshBasicMaterial color="#f2f4f5" /></Inst>
      <group position={[gx, 0, gz]}>
        <RoundedBox args={[3.4, 2.7, 2.6]} radius={0.12} position={[0, 1.35, 0]} castShadow><meshStandardMaterial color="#d8dee2" roughness={0.7} /></RoundedBox>
        <mesh position={[0, 2.8, 0]} castShadow><boxGeometry args={[4.2, 0.2, 3.4]} /><meshStandardMaterial color="#2a6fb0" /></mesh>
        <mesh position={[0, 1.7, 1.31]}><boxGeometry args={[2.6, 0.9, 0.04]} /><meshStandardMaterial color="#1b2a36" roughness={0.1} metalness={0.6} /></mesh>
        <group position={[2.0, 0.9, 2.2]}><group ref={barrier}><mesh position={[1.9, 0, 0]}><boxGeometry args={[3.8, 0.12, 0.12]} /><meshStandardMaterial color="#e8eaec" /></mesh>{[0.6, 1.6, 2.6, 3.4].map((px) => <mesh key={px} position={[px, 0, 0]}><boxGeometry args={[0.4, 0.13, 0.13]} /><meshStandardMaterial color="#c0291f" /></mesh>)}</group></group>
      </group>
    </group>
  )
}
function Car({ x, y, color, dir }) {
  const [cx, cz] = W(x, y)
  return (
    <group position={[cx, 0, cz]} rotation-y={-dir}>
      <RoundedBox args={[4.3, 0.75, 1.8]} radius={0.25} position={[0, 0.7, 0]} castShadow><meshStandardMaterial color={color} roughness={0.35} metalness={0.4} /></RoundedBox>
      <RoundedBox args={[2.3, 0.7, 1.62]} radius={0.28} position={[-0.2, 1.3, 0]} castShadow><meshStandardMaterial color={color} roughness={0.35} metalness={0.4} /></RoundedBox>
      <RoundedBox args={[2.05, 0.46, 1.66]} radius={0.2} position={[-0.2, 1.33, 0]}><meshStandardMaterial color="#1b2a36" roughness={0.1} metalness={0.7} /></RoundedBox>
      {[[1.35, -0.85], [1.35, 0.85], [-1.35, -0.85], [-1.35, 0.85]].map(([wx, wz]) => (
        <group key={wx + '_' + wz} position={[wx, 0.32, wz]} rotation-x={Math.PI / 2}><mesh castShadow><cylinderGeometry args={[0.32, 0.32, 0.24, 16]} /><meshStandardMaterial color="#141618" /></mesh><mesh position={[0, wz > 0 ? 0.13 : -0.13, 0]}><cylinderGeometry args={[0.18, 0.18, 0.02, 12]} /><meshStandardMaterial color="#c7ced3" metalness={0.7} /></mesh></group>
      ))}
      {[-0.6, 0.6].map((dz) => <mesh key={dz} position={[2.16, 0.78, dz]}><boxGeometry args={[0.06, 0.16, 0.34]} /><meshStandardMaterial color="#fff6d6" emissive="#fff0b0" emissiveIntensity={0.5} /></mesh>)}
    </group>
  )
}

/* ---------- selection, focus, hover ---------- */
const entity = (r) => {
  if (!r) return null
  if (r.type === 'pick' || r.type === 'bulk' || r.type === 'sub') {
    const b = byId[r.id], [x, z] = W(b.cx, b.cy), h = r.type === 'pick' ? RACK_H + 0.2 : BULK_H + 0.2
    return { pos: [x, h / 2, z], size: [b.w + 0.2, h, b.d + 0.2] }
  }
  return null
}
function Outline({ r, color }) {
  const e = entity(r)
  const geo = useMemo(() => e && new THREE.EdgesGeometry(new THREE.BoxGeometry(...e.size)), [r && r.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) return null
  return <lineSegments position={e.pos} geometry={geo}><lineBasicMaterial color={color} /></lineSegments>
}
function Focus({ ids, T }) {
  const fill = (m, o) => ids.forEach((id, i) => { const e = entity({ type: byId[id].kind, id }); put(m, i, o, ...e.pos, ...e.size) })
  return (
    <Inst key={ids.join()} count={ids.length} fill={fill}>
      {box}<meshBasicMaterial color={T.warn} transparent opacity={0.28} depthWrite={false} />
    </Inst>
  )
}
function Tip({ hover }) {
  if (!hover) return null
  let pos, text
  if (hover.type === 'truck') {
    const t = sim.trucks.find((x) => x.id === hover.id); if (!t) return null
    const [x, z] = W(t.x, t.y); pos = [x, 5.8, z]; text = `${t.id} · ${t.car}`
  } else if (hover.type === 'worker') {
    const w = workerById[hover.id]; const [x, z] = W(w.x, w.y); pos = [x, 2.3, z]; text = `${w.id} · ${w.status}`
  } else if (hover.type === 'forklift') {
    const f = forkById[hover.id]; const [x, z] = W(f.x, f.y); pos = [x, 3, z]; text = `${f.id} · ${f.status}`
  } else if (hover.type === 'pack') {
    const b = sim.benches.find((x) => x.id === hover.id), [x, z] = W(b.x, b.y); pos = [x, 2.2, z]; text = `${b.id} · queue ${b.queue}${b.busy ? ', packing' : ''}`
  } else {
    const e = entity(hover), b = byId[hover.id]; pos = [e.pos[0], e.pos[1] + e.size[1] / 2 + 0.3, e.pos[2]]
    text = hover.type === 'pick' ? `${b.id} · ${b.qty}/${b.cap} units · ${b.size}` : `${b.id} · ${b.levels}/4 pallets`
  }
  return <Html position={pos} center zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}><div className="tip">{text}</div></Html>
}

/* ---------- simulation + camera ---------- */
function Sim() {
  useFrame((_, dt) => stepSim(Math.min(dt, 0.1)))
  return null
}
function CameraRig({ view, follow, views }) {
  const controls = useRef(), anim = useRef(null)
  const { camera } = useThree()
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useLayoutEffect(() => {
    const v = view.custom || views[view.name]
    if (!v || !controls.current) return
    anim.current = { t: 0, p0: camera.position.clone(), t0: controls.current.target.clone(), p1: new THREE.Vector3(...v.pos), t1: new THREE.Vector3(...v.target) }
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    const c = controls.current
    if (!c) return
    const sub = follow && (workerById[follow] || forkById[follow] || sim.trucks.find((t) => t.id === follow))
    if (sub) {
      const [x, z] = W(sub.x, sub.y), truck = !sub.role, back = truck ? 17 : sub.role === 'forklift' ? 8 : 6, up = truck ? 8 : sub.role === 'forklift' ? 4.5 : 3.4
      tmp.set(x - Math.cos(sub.h) * back, up, z - Math.sin(sub.h) * back)
      camera.position.lerp(tmp, 0.05)
      c.target.lerp(tmp.set(x + Math.cos(sub.h) * 4, 1, z + Math.sin(sub.h) * 4), 0.08)
      anim.current = null
    } else if (anim.current) {
      const a = anim.current
      a.t = Math.min(1, a.t + dt / 1.4)
      const k = a.t * a.t * (3 - 2 * a.t)
      camera.position.lerpVectors(a.p0, a.p1, k)
      c.target.lerpVectors(a.t0, a.t1, k)
      if (a.t >= 1) anim.current = null
    }
    c.update()
  })
  return <OrbitControls ref={controls} makeDefault enabled={!follow} enableDamping dampingFactor={0.08} minDistance={5} maxDistance={190} maxPolarAngle={Math.PI / 2.04} />
}

export default function Scene({ dark, mode, sel, focus, hover, setHover, onPick, view, follow, views }) {
  const T = THEMES[dark ? 'dark' : 'light']
  const pickSel = ['pick', 'bulk', 'sub'].includes(sel.type) ? sel : null
  const common = { T, onPick, setHover }
  return (
    <Canvas shadows dpr={[1, 1.75]} camera={{ position: views.overview.pos, fov: 38, near: 0.5, far: 600 }}
      onPointerMissed={() => setHover(null)} gl={{ antialias: true, alpha: true }}>
      <fog attach="fog" args={[T.horizon, 170, 360]} />
      <hemisphereLight args={[dark ? '#8aa0c0' : '#cfe6ff', dark ? '#1a232a' : '#a8997d', dark ? 0.7 : 0.95]} />
      <directionalLight position={[50, 90, 70]} color={dark ? '#a9bbd8' : '#fff2da'} intensity={dark ? 1.0 : 1.7} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}
        shadow-camera-left={-70} shadow-camera-right={70} shadow-camera-top={80} shadow-camera-bottom={-50} shadow-camera-near={10} shadow-camera-far={220} />
      <Sim />
      <CameraRig view={view} follow={follow} views={views} />
      <Floor T={T} sel={sel} mode={mode} />
      <Surroundings T={T} dark={dark} />
      <Shell x0={0} y0={0} w={HALL.w} wallH={HALL.wallH} northDocks={DOCKS.filter((d) => d.wall === 'y')} westDocks={DOCKS.filter((d) => d.wall === 'x')} T={T} />
      <Shell x0={SUBHALL.x0} y0={SUBHALL.y0} w={SUBHALL.w} wallH={SUBHALL.wallH} northDocks={DOCKS.filter((d) => d.wall === 'n2')} westDocks={[]} T={T} />
      <SafetyLayer mode={mode} T={T} />
      <Staging T={T} />
      <PackArea {...common} sel={sel} />
      <Trucks {...common} sel={sel} />
      <PickZone mode={mode} {...common} />
      <RackBlock bays={bulkBays} type="bulk" mode={mode} {...common} />
      <RackBlock bays={subBays} type="sub" mode={mode} {...common} />
      {sim.workers.map((w) => <Worker key={w.id} w={w} T={T} selected={sel.type === 'worker' && sel.id === w.id} onPick={onPick} setHover={setHover} />)}
      {sim.subWorkers.map((w) => <Worker key={w.id} w={w} T={T} selected={false} onPick={onPick} setHover={setHover} />)}
      {sim.forklifts.map((f) => <Forklift key={f.id} f={f} T={T} mode={mode} disk selected={sel.type === 'forklift' && sel.id === f.id} onPick={onPick} setHover={setHover} />)}
      {sim.subForks.map((f) => <Forklift key={f.id} f={f} T={T} mode={mode} disk={false} selected={false} onPick={onPick} setHover={setHover} />)}
      {focus && <Focus ids={focus} T={T} />}
      {pickSel && <Outline r={pickSel} color={T.accent} />}
      {hover && hover.id !== sel.id && ['pick', 'bulk', 'sub'].includes(hover.type) && <Outline r={hover} color={dark ? '#ffffff' : '#15202a'} />}
      <Tip hover={hover} T={T} />
    </Canvas>
  )
}
