import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import * as THREE from 'three'
import { HALL, SUBHALL, DOCKS, A, XE, FORK_X, ROAD_Y, slotX, INSTAGE_Y, OUTSTAGE_Y, pickFaces, bulkBays, subBays, byId, toWorld } from './data.js'
import { sim, stepSim, workerById, forkById, dockStatus, truckSeconds, STOP_R, SLOW_R } from './sim.js'
import { THEMES, ramp } from './theme.js'

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
const put = (m, i, o, x, y, z, sx = 1, sy = 1, sz = 1) => { o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.updateMatrix(); m.setMatrixAt(i, o.matrix) }
const box = <boxGeometry args={[1, 1, 1]} />
const RACK_H = 3.0, BULK_H = 6.4, LEVEL = 1.55
const W = (x, y) => toWorld(x, y)

/* ---------- colour per layer ---------- */
function faceColor(f, mode, T, out) {
  if (mode === 'fill') return ramp(T.stock, f.qty / f.cap, out)
  if (mode === 'heat') return ramp(T.heat, f.heat, out)
  if (mode === 'repl') return ramp(T.repl, f.repl7 / 42, out)
  if (mode === 'slot') return out.set(f.fit === 'up' ? T.slot.up : f.fit === 'down' ? T.slot.down : T.slot.ok)
  return out.set(T.neutral)
}
const bulkColor = (b, mode, T, out) => mode === 'fill' ? ramp(T.stock, b.levels / 4, out) : out.set(mode === 'safety' ? T.neutral : T.carton)

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
      <Inst count={n * 4} fill={frame} receiveShadow castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.post} roughness={0.6} /></Inst>
      <Inst count={n * 4} fill={shelves} receiveShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.shelf} roughness={0.7} /></Inst>
      <Inst count={n} fill={stock} deps={D} live castShadow>{box}<meshStandardMaterial roughness={0.75} /></Inst>
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
      m.setColorAt(i * 4 + l, bulkColor(b, mode, T, c))
    }
  })
  const hits = (m, o) => bays.forEach((b, i) => { const [x, z] = W(b.cx, b.cy); put(m, i, o, x, BULK_H / 2, z, 2, BULK_H, 2) })
  return (
    <group>
      <Inst count={n * 4} fill={posts} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.post} roughness={0.6} /></Inst>
      <Inst count={n * 8} fill={beams} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.beam} roughness={0.55} /></Inst>
      <Inst count={n * 4} fill={wood} live castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.wood} roughness={0.9} /></Inst>
      <Inst count={n * 4} fill={cartons} deps={[mode, T]} live castShadow receiveShadow>{box}<meshStandardMaterial roughness={0.8} /></Inst>
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

/* ---------- packing area: six benches ---------- */
function Person({ T, vest, bob }) {
  const g = useRef()
  useFrame(() => { if (g.current) g.current.position.y = bob && bob() ? Math.abs(Math.sin(sim.t * 5)) * 0.04 : 0 })
  return (
    <group ref={g}>
      <mesh position={[0, 0.25, 0]} castShadow><cylinderGeometry args={[0.17, 0.15, 0.5, 8]} /><meshStandardMaterial color={T.pants} /></mesh>
      <mesh position={[0, 0.95, 0]} castShadow><capsuleGeometry args={[0.21, 0.55, 4, 10]} /><meshStandardMaterial color={vest} roughness={0.7} /></mesh>
      <mesh position={[0, 1.58, 0]} castShadow><sphereGeometry args={[0.14, 12, 12]} /><meshStandardMaterial color={T.skin} /></mesh>
    </group>
  )
}
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
      <mesh position={[0, 0.5, 0]} castShadow><boxGeometry args={[2.8, 1.0, 1.1]} /><meshStandardMaterial color={T.shelf} /></mesh>
      <mesh position={[0, 1.03, 0]} castShadow><boxGeometry args={[2.9, 0.06, 1.2]} /><meshStandardMaterial ref={top} color={T.wall} /></mesh>
      {[-1, -0.35, 0.3, 0.95].map((dx, i) => (
        <mesh key={i} ref={(m) => { cartons.current[i] = m }} position={[dx, 1.35, 0]} castShadow><boxGeometry args={[0.55, 0.55, 0.7]} /><meshStandardMaterial color={T.carton} /></mesh>
      ))}
      <group position={[0, 0, 1.15]} rotation-y={Math.PI}><Person T={T} vest={T.pack} bob={() => b.busy} /></group>
      {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.04, 0]}><ringGeometry args={[1.9, 2.1, 32]} /><meshBasicMaterial color={T.accent} /></mesh>}
    </group>
  )
}
function PackArea({ T, sel, onPick, setHover }) {
  return sim.benches.map((b) => <Bench key={b.id} b={b} T={T} selected={sel.type === 'pack' && sel.id === b.id} onPick={onPick} setHover={setHover} />)
}

/* ---------- people ---------- */
function Worker({ w, T, selected, onPick, setHover }) {
  const g = useRef(), body = useRef(), load = useRef()
  const runner = w.role === 'runner'
  const phase = useMemo(() => Math.random() * 6, [])
  useFrame(() => {
    const [x, z] = W(w.x, w.y), moving = w.path.length > 0
    g.current.position.set(x, 0, z)
    g.current.rotation.y = -w.h
    body.current.position.y = moving ? Math.abs(Math.sin(sim.t * 7 + phase)) * 0.05 : 0
    if (load.current) load.current.visible = w.carrying
  })
  return (
    <group ref={g}
      onClick={(e) => { e.stopPropagation(); onPick({ type: 'worker', id: w.id }) }}
      onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'worker', id: w.id }) }}
      onPointerOut={() => setHover(null)}>
      <group ref={body}>
        <mesh position={[0, 0.25, 0]} castShadow><cylinderGeometry args={[0.17, 0.15, 0.5, 8]} /><meshStandardMaterial color={T.pants} /></mesh>
        <mesh position={[0, 0.95, 0]} castShadow><capsuleGeometry args={[0.21, 0.55, 4, 10]} /><meshStandardMaterial color={runner ? T.runner : T.picker} roughness={0.7} /></mesh>
        <mesh position={[0, 1.58, 0]} castShadow><sphereGeometry args={[0.14, 12, 12]} /><meshStandardMaterial color={T.skin} /></mesh>
        {runner && <mesh position={[0, 1.7, 0]}><sphereGeometry args={[0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color="#ffffff" /></mesh>}
      </group>
      {runner && (
        <group position={[0.85, 0, 0]}>
          <mesh position={[0, 0.08, 0]} castShadow><boxGeometry args={[1.2, 0.12, 0.75]} /><meshStandardMaterial color="#c0392b" /></mesh>
          <group ref={load}>
            <mesh position={[0, 0.2, 0]} castShadow><boxGeometry args={[1.0, 0.12, 0.8]} /><meshStandardMaterial color={T.wood} /></mesh>
            <mesh position={[0, 0.8, 0]} castShadow><boxGeometry args={[0.95, 1.1, 0.75]} /><meshStandardMaterial color={T.carton} /></mesh>
          </group>
        </group>
      )}
      {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.04, 0]}><ringGeometry args={[0.55, 0.7, 28]} /><meshBasicMaterial color={T.accent} /></mesh>}
    </group>
  )
}

/* ---------- forklifts, with their safety zones ---------- */
function Forklift({ f, T, mode, disk, selected, onPick, setHover }) {
  const g = useRef(), load = useRef(), beacon = useRef(), slow = useRef(), stop = useRef(), ring = useRef()
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
  return (
    <group>
      <group ref={g}
        onClick={(e) => { e.stopPropagation(); onPick({ type: 'forklift', id: f.id }) }}
        onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'forklift', id: f.id }) }}
        onPointerOut={() => setHover(null)}>
        <mesh position={[-0.35, 0.65, 0]} castShadow><boxGeometry args={[1.5, 0.9, 1.15]} /><meshStandardMaterial color={T.fork} roughness={0.6} /></mesh>
        <mesh position={[-0.95, 0.9, 0]} castShadow><boxGeometry args={[0.5, 1.2, 1.1]} /><meshStandardMaterial color={T.fork} roughness={0.6} /></mesh>
        {[-0.5, 0.5].map((dz) => <mesh key={dz} position={[0.55, 1.2, dz]} castShadow><boxGeometry args={[0.1, 2.4, 0.08]} /><meshStandardMaterial color={T.pants} /></mesh>)}
        {[-0.35, 0.35].map((dz) => <mesh key={dz} position={[1.4, 0.12, dz]} castShadow><boxGeometry args={[1.7, 0.08, 0.14]} /><meshStandardMaterial color="#6b7780" /></mesh>)}
        {[[-0.75, -0.5], [-0.75, 0.5], [0.15, -0.5], [0.15, 0.5]].map(([dx, dz]) => <mesh key={dx + '_' + dz} position={[dx, 1.65, dz]}><boxGeometry args={[0.06, 1.0, 0.06]} /><meshStandardMaterial color={T.pants} /></mesh>)}
        <mesh position={[-0.3, 2.17, 0]}><boxGeometry args={[1.05, 0.06, 1.1]} /><meshStandardMaterial color={T.pants} /></mesh>
        <mesh position={[-0.3, 1.35, 0]}><capsuleGeometry args={[0.17, 0.35, 4, 8]} /><meshStandardMaterial color={T.runner} /></mesh>
        <mesh position={[-0.3, 2.3, 0]}><sphereGeometry args={[0.14, 12, 12]} /><meshBasicMaterial ref={beacon} color={T.accent} /></mesh>
        <group ref={load} position={[1.5, 0, 0]}>
          <mesh position={[0, 0.3, 0]} castShadow><boxGeometry args={[1.1, 0.14, 0.9]} /><meshStandardMaterial color={T.wood} /></mesh>
          <mesh position={[0, 0.95, 0]} castShadow><boxGeometry args={[1.0, 1.1, 0.8]} /><meshStandardMaterial color={T.carton} /></mesh>
        </group>
        {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}><ringGeometry args={[1.6, 1.8, 28]} /><meshBasicMaterial color={T.accent} /></mesh>}
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

/* ---------- safety framework visuals: zones, gates, traffic lights ---------- */
function SafetyLayer({ mode, T }) {
  const strong = mode === 'safety'
  const plane = (x0, y0, x1, y1, color, op, key, y = 0.015) => {
    const [cx, cz] = W((x0 + x1) / 2, (y0 + y1) / 2)
    return <mesh key={key} rotation-x={-Math.PI / 2} position={[cx, y, cz]}><planeGeometry args={[x1 - x0, y1 - y0]} /><meshBasicMaterial color={color} transparent opacity={op} depthWrite={false} /></mesh>
  }
  const label = (txt, x, y, color) => { const [px, pz] = W(x, y); return strong ? <Html key={txt} position={[px, 0.2, pz]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}><div className="zlabel" style={{ color }}>{txt}</div></Html> : null }
  const postFill = (m, o) => { let i = 0; A.forEach((y, a) => { [[60.2, a], [33.1, a]].forEach(([x]) => { const [px, pz] = W(x, y - 1.7); put(m, i++, o, px, 1.1, pz, 0.12, 2.2, 0.12) }) }) }
  const lamps = (m, o, c) => {
    A.forEach((y, a) => {
      const L = sim.locks[a], off = !sim.safety.on
      const [ex, ez] = W(60.2, y - 1.7), [wx, wz] = W(33.1, y - 1.7)
      put(m, a, o, ex, 2.35, ez, 1, 1, 1)                                   // east lamp: forklifts
      m.setColorAt(a, c.set(off ? T.neutral : L.type === 'ped' ? T.crit : T.ok))
      const west = a >= 1 && a <= 4
      put(m, 6 + a, o, wx, 2.35, wz, west ? 1 : 0.0001, west ? 1 : 0.0001, west ? 1 : 0.0001) // west lamp: pedestrians
      m.setColorAt(6 + a, c.set(off ? T.neutral : L.type === 'fork' ? T.crit : T.ok))
    })
  }
  return (
    <group>
      {plane(FORK_X, 4.5, 59.5, 38, T.warn, strong ? 0.2 : 0.05, 'fz')}
      {plane(33, 4.5, FORK_X, 38, T.ok, strong ? 0.2 : 0.05, 'rz')}
      {plane(59.5, 0, 65, 40, T.warn, strong ? 0.3 : 0.09, 'lane')}
      {plane(5, 4.5, 31, 38, T.ok, strong ? 0.14 : 0, 'pz')}
      {A.map((y, a) => plane(33.6, y - 1.3, 35.6, y + 1.3, T.cross, strong ? 0.75 : 0.4, 'g' + a, 0.03))}
      <Inst count={A.length * 2} fill={postFill}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.pants} /></Inst>
      <Inst count={12} fill={lamps} live><sphereGeometry args={[0.28, 14, 14]} /><meshBasicMaterial /></Inst>
      {label('FORKLIFT ZONE', 51, 21, T.warn)}
      {label('RUNNER RESERVE', 37.5, 21, T.ok)}
      {label('PEDESTRIANS ONLY', 18, 21, T.ok)}
      {label('FORKLIFT LANE', 62.3, 21, T.warn)}
    </group>
  )
}

/* ---------- trucks ---------- */
function Truck({ t, T, selected, onPick, setHover }) {
  const g = useRef(), lab = useRef(), fill = useRef(), acc = useRef(1)
  useFrame((_, dt) => {
    const [x, z] = W(t.x, t.y)
    g.current.position.set(x, 0, z)
    g.current.rotation.y = -t.h
    acc.current += dt
    if (acc.current > 0.25) {
      acc.current = 0
      let txt
      if (t.dir === 'xfer') txt = t.label
      else {
        const eta = Math.max(0, Math.ceil(((1 - t.progress) * truckSeconds(t)) / 60))
        txt = t.st === 'waiting' ? `Waiting ${Math.round(t.waited / 60)} min` : t.st === 'queue' ? 'In yard queue' : t.st === 'arriving' ? 'Arriving' : t.st === 'leaving' ? 'Leaving'
          : `${t.dir === 'in' ? 'Unloading' : 'Loading'} ${Math.round(t.progress * 100)}% Â· ${eta} min`
      }
      if (lab.current) lab.current.textContent = `${t.id} Â· ${txt}`
      if (fill.current) { fill.current.style.width = (t.st === 'docked' ? t.progress * 100 : 0) + '%'; fill.current.style.background = t.st === 'waiting' ? T.warn : T.ok }
    }
  })
  const xfer = t.dir === 'xfer'
  return (
    <group ref={g}
      onClick={(e) => { e.stopPropagation(); onPick({ type: 'truck', id: t.id }) }}
      onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'truck', id: t.id }) }}
      onPointerOut={() => setHover(null)}>
      <mesh position={[-1, 1.9, 0]} castShadow><boxGeometry args={[9.6, 3.0, 2.6]} /><meshStandardMaterial color={xfer ? T.lane : T.truck} roughness={0.6} /></mesh>
      <mesh position={[5, 1.3, 0]} castShadow><boxGeometry args={[2.0, 2.4, 2.4]} /><meshStandardMaterial color={xfer ? T.lane : T.cabTruck} /></mesh>
      <mesh position={[5.7, 1.6, 0]}><boxGeometry args={[0.6, 0.9, 2.3]} /><meshStandardMaterial color="#27333c" /></mesh>
      {[-4, -2.7, 4.6].flatMap((xx) => [-1.2, 1.2].map((zz) => (
        <mesh key={xx + '_' + zz} position={[xx, 0.5, zz]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.5, 0.5, 0.35, 14]} /><meshStandardMaterial color="#1b2227" /></mesh>
      )))}
      <Html position={[0, 4.6, 0]} center zIndexRange={[15, 5]} style={{ pointerEvents: 'none' }}>
        <div className="tbadge"><span ref={lab} /><i><b ref={fill} /></i></div>
      </Html>
      {selected && <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}><ringGeometry args={[4.9, 5.3, 40]} /><meshBasicMaterial color={T.accent} /></mesh>}
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
  return <mesh rotation-x={-Math.PI / 2} position={[pos[0], 0.02, pos[1]]}><planeGeometry args={size} /><meshBasicMaterial ref={m} transparent opacity={0.5} /></mesh>
}

function Shell({ x0, y0, w, wallH, northDocks, westDocks, T }) {
  const doorH = 4.0, parts = []
  const wall = (axis, docks, len) => {
    const ds = docks.slice().sort((a, b) => a.a - b.a)
    const piece = (a, b, key, lo, hi) => {
      const l = b - a, mid = (a + b) / 2, [x, z] = axis === 'y' ? W(mid, y0 - 0.2) : W(x0 - 0.2, mid)
      parts.push(<mesh key={key} position={[x, (lo + hi) / 2, z]} castShadow receiveShadow><boxGeometry args={axis === 'y' ? [l, hi - lo, 0.4] : [0.4, hi - lo, l]} /><meshStandardMaterial color={T.wall} roughness={0.9} /></mesh>)
    }
    let at = axis === 'y' ? x0 : y0
    ds.forEach((d, i) => { if (d.a > at) piece(at, d.a, axis + i, 0, wallH); piece(d.a, d.b, axis + 'l' + i, doorH, wallH); at = d.b })
    piece(at, len, axis + 'end', 0, wallH)
  }
  wall('y', northDocks, x0 + w)
  wall('x', westDocks, y0 + (y0 === 0 ? HALL.d : SUBHALL.d))
  return <group>{parts}</group>
}

function Floor({ T, sel, mode }) {
  const plane = (x0, y0, x1, y1, color, op, key, y = 0.01) => {
    const [cx, cz] = W((x0 + x1) / 2, (y0 + y1) / 2)
    return <mesh key={key} rotation-x={-Math.PI / 2} position={[cx, y, cz]} receiveShadow><planeGeometry args={[x1 - x0, y1 - y0]} /><meshStandardMaterial color={color} transparent={op < 1} opacity={op} roughness={0.95} /></mesh>
  }
  const label = (txt, x, y, color) => {
    const [px, pz] = W(x, y)
    return <Html key={txt} position={[px, 0.1, pz]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}><div className="zlabel" style={{ color }}>{txt}</div></Html>
  }
  const selDock = sel.type === 'dock' && DOCKS.find((x) => x.id === sel.id)
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.05, 25]} receiveShadow><planeGeometry args={[260, 220]} /><meshStandardMaterial color={T.yard} roughness={1} /></mesh>
      {plane(-23, -20, 90, -14, T.road, 1, 'roadN', -0.03)}
      {plane(-20, -20, -14, 62, T.road, 1, 'roadW', -0.025)}
      {plane(-20, ROAD_Y - 3, 90, ROAD_Y + 3, T.road, 1, 'roadS', -0.03)}
      {plane(72, 28, 80, ROAD_Y + 3, T.road, 1, 'roadE', -0.028)}
      {plane(0, 0, HALL.w, HALL.d, T.floor, 1, 'f', 0)}
      {plane(5, 4.5, 31, 36.4, T.pickZone, 0.1, 'pz')}
      {plane(5, 36.4, 31, HALL.d, T.pack, 0.28, 'pack')}
      {plane(33, 4.5, 59.5, 38, T.bulkZone, 0.1, 'bz')}
      {plane(30.4, 2, 33.6, 38, T.lane, 0.22, 'lane')}
      {plane(0.4, 4, 3.6, 36, T.stage, 0.16, 'stage')}
      {plane(33, 3.5, 59.5, 5.9, T.receiving, 0.22, 'instage')}
      {plane(33, 32.9, 59.5, 35.1, T.lane, 0.18, 'outstage')}
      {plane(33, 0.4, 66, 3.4, T.receiving, 0.08, 'recv')}
      {plane(SUBHALL.x0, SUBHALL.y0, SUBHALL.x0 + SUBHALL.w, SUBHALL.y0 + SUBHALL.d, T.floor, 1, 'subf', 0)}
      {plane(24, 72, 50, 90, T.bulkZone, 0.1, 'subz')}
      {DOCKS.map((d) => <DockStrip key={d.id} d={d} T={T} />)}
      {selDock && (() => { const { pos } = dockGeom(selDock); return <mesh rotation-x={-Math.PI / 2} position={[pos[0], 0.05, pos[1]]}><ringGeometry args={[2.4, 2.7, 4, 1, Math.PI / 4]} /><meshBasicMaterial color={T.accent} /></mesh> })()}
      {label('PICK ZONE', 18, 2.2, T.pickZone)}
      {label('PACKING', 18, 39.2, T.pack)}
      {label('RECEIVING Â· INBOUND STAGING', 46, 4.7, T.receiving)}
      {label('BULK STAGING Â· TRANSFERS', 46, 34, T.lane)}
      {label('REPLEN LANE', 32, 1.5, T.lane)}
      {label('OUTBOUND STAGING', 2, 2.2, T.stage)}
      {label('TRANSFER ROAD', 48, ROAD_Y, T.muted)}
      {label('YARD', 50, -26, T.muted)}
      {label('SUB-WAREHOUSE', 40, 93.5, T.bulkZone)}
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
    const [x, z] = W(t.x, t.y); pos = [x, 5.4, z]; text = `${t.id} Â· ${t.car}`
  } else if (hover.type === 'worker') {
    const w = workerById[hover.id]; const [x, z] = W(w.x, w.y); pos = [x, 2.3, z]; text = `${w.id} Â· ${w.status}`
  } else if (hover.type === 'forklift') {
    const f = forkById[hover.id]; const [x, z] = W(f.x, f.y); pos = [x, 3, z]; text = `${f.id} Â· ${f.status}`
  } else if (hover.type === 'pack') {
    const b = sim.benches.find((x) => x.id === hover.id), [x, z] = W(b.x, b.y); pos = [x, 2.2, z]; text = `${b.id} Â· queue ${b.queue}${b.busy ? ', packing' : ''}`
  } else {
    const e = entity(hover), b = byId[hover.id]; pos = [e.pos[0], e.pos[1] + e.size[1] / 2 + 0.3, e.pos[2]]
    text = hover.type === 'pick' ? `${b.id} Â· ${b.qty}/${b.cap} units Â· ${b.size}` : `${b.id} Â· ${b.levels}/4 pallets`
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
      const [x, z] = W(sub.x, sub.y), truck = !sub.role, back = truck ? 15 : sub.role === 'forklift' ? 8 : 6, up = truck ? 8 : sub.role === 'forklift' ? 4.5 : 3.4
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
    <Canvas shadows dpr={[1, 1.75]} camera={{ position: views.overview.pos, fov: 38, near: 0.5, far: 500 }}
      onPointerMissed={() => setHover(null)} gl={{ antialias: true }}>
      <color attach="background" args={[T.bg]} />
      <fog attach="fog" args={[T.bg, 160, 330]} />
      <hemisphereLight args={[dark ? '#8aa0b8' : '#ffffff', dark ? '#1a232a' : '#9aa6ad', dark ? 0.7 : 0.9]} />
      <directionalLight position={[50, 90, 70]} intensity={dark ? 1.1 : 1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}
        shadow-camera-left={-70} shadow-camera-right={70} shadow-camera-top={80} shadow-camera-bottom={-50} shadow-camera-near={10} shadow-camera-far={220} />
      <Sim />
      <CameraRig view={view} follow={follow} views={views} />
      <Floor T={T} sel={sel} mode={mode} />
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

