import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import * as THREE from 'three'
import { HALL, DOCKS, pickFaces, bulkBays, byId, toWorld } from './data.js'
import { sim, stepSim, workerById, dockStatus, truckSeconds } from './sim.js'
import { THEMES, ramp } from './theme.js'

const H = HALL

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

/* ---------- colour per layer ---------- */
function faceColor(f, mode, T, out) {
  if (mode === 'fill') return ramp(T.stock, f.qty / f.cap, out)
  if (mode === 'heat') return ramp(T.heat, f.heat, out)
  if (mode === 'repl') return ramp(T.repl, f.repl7 / 42, out)
  return out.set(f.fit === 'up' ? T.slot.up : f.fit === 'down' ? T.slot.down : T.slot.ok)
}
const bulkColor = (b, mode, T, out) => mode === 'fill' ? ramp(T.stock, b.levels / 4, out) : out.set(T.carton)

/* ---------- pick zone ---------- */
function PickZone({ mode, T, onPick, setHover }) {
  const n = pickFaces.length
  const frame = (m, o, c) => {
    pickFaces.forEach((f, i) => {
      const [x, z] = toWorld(f.cx, f.cy)
      ;[[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b], k) => put(m, i * 4 + k, o, x + a * (f.w / 2 - 0.04), RACK_H / 2, z + b * (f.d / 2 - 0.04), 0.07, RACK_H, 0.07))
    })
  }
  const shelves = (m, o) => pickFaces.forEach((f, i) => {
    const [x, z] = toWorld(f.cx, f.cy)
    for (let l = 0; l < 4; l++) put(m, i * 4 + l, o, x, 0.08 + l * 0.98, z, f.w, 0.06, f.d)
  })
  const stock = (m, o, c) => pickFaces.forEach((f, i) => {
    const [x, z] = toWorld(f.cx, f.cy), h = 0.08 + (f.qty / f.cap) * 2.6
    put(m, i, o, x, h / 2 + 0.1, z, f.w - 0.2, h, f.d - 0.25)
    m.setColorAt(i, faceColor(f, mode, T, c))
  })
  const bars = (m, o, c) => pickFaces.forEach((f, i) => {
    const [x, z] = toWorld(f.cx, f.cy)
    const t = mode === 'heat' ? f.heat : mode === 'repl' ? Math.min(1, f.repl7 / 42) : 0
    const h = mode === 'heat' || mode === 'repl' ? Math.max(0.1, t * 6) : 0.0001
    put(m, i, o, x, RACK_H + 0.3 + h / 2, z, 1.0, h, 0.9)
    m.setColorAt(i, faceColor(f, mode, T, c))
  })
  const beacons = (m, o, c) => pickFaces.forEach((f, i) => {
    const [x, z] = toWorld(f.cx, f.cy), t = f.task
    put(m, i, o, x, RACK_H + 0.55, z, t ? 1 : 0.0001, t ? 1 : 0.0001, t ? 1 : 0.0001)
    m.setColorAt(i, c.set(t && t.st !== 'queued' ? T.accent : t && f.qty === 0 ? T.crit : T.warn))
  })
  const flags = (m, o, c) => {
    pickFaces.forEach((f, i) => {
      const [x, z] = toWorld(f.cx, f.cy), on = mode === 'slot' && f.fit !== 'ok', s = on ? 1 : 0.0001
      o.rotation.x = f.fit === 'down' ? Math.PI : 0
      put(m, i, o, x, RACK_H + 0.9, z, s, s, s)
      m.setColorAt(i, c.set(f.fit === 'up' ? T.slot.up : T.slot.down))
    })
    o.rotation.x = 0
  }
  const hits = (m, o) => pickFaces.forEach((f, i) => { const [x, z] = toWorld(f.cx, f.cy); put(m, i, o, x, 1.6, z, f.w, 3.2, f.d) })
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

/* ---------- bulk zone ---------- */
function BulkZone({ mode, T, onPick, setHover }) {
  const n = bulkBays.length
  const posts = (m, o) => bulkBays.forEach((b, i) => {
    const [x, z] = toWorld(b.cx, b.cy)
    ;[[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, c], k) => put(m, i * 4 + k, o, x + a * 0.96, BULK_H / 2, z + c * 0.9, 0.1, BULK_H, 0.1))
  })
  const beams = (m, o) => bulkBays.forEach((b, i) => {
    const [x, z] = toWorld(b.cx, b.cy)
    for (let l = 0; l < 4; l++) { put(m, (i * 4 + l) * 2, o, x, 0.2 + l * LEVEL, z - 0.88, 2, 0.14, 0.09); put(m, (i * 4 + l) * 2 + 1, o, x, 0.2 + l * LEVEL, z + 0.88, 2, 0.14, 0.09) }
  })
  const wood = (m, o) => bulkBays.forEach((b, i) => {
    const [x, z] = toWorld(b.cx, b.cy)
    for (let l = 0; l < 4; l++) { const on = l < b.levels; put(m, i * 4 + l, o, x, 0.2 + l * LEVEL + 0.14, z, on ? 1.7 : 0.0001, on ? 0.14 : 0.0001, on ? 1.6 : 0.0001) }
  })
  const cartons = (m, o, c) => bulkBays.forEach((b, i) => {
    const [x, z] = toWorld(b.cx, b.cy)
    for (let l = 0; l < 4; l++) {
      const on = l < b.levels
      put(m, i * 4 + l, o, x, 0.2 + l * LEVEL + 0.21 + 0.55, z, on ? 1.6 : 0.0001, on ? 1.1 : 0.0001, on ? 1.5 : 0.0001)
      m.setColorAt(i * 4 + l, bulkColor(b, mode, T, c))
    }
  })
  const hits = (m, o) => bulkBays.forEach((b, i) => { const [x, z] = toWorld(b.cx, b.cy); put(m, i, o, x, BULK_H / 2, z, 2, BULK_H, 2) })
  return (
    <group>
      <Inst count={n * 4} fill={posts} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.post} roughness={0.6} /></Inst>
      <Inst count={n * 8} fill={beams} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.beam} roughness={0.55} /></Inst>
      <Inst count={n * 4} fill={wood} live castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={T.wood} roughness={0.9} /></Inst>
      <Inst count={n * 4} fill={cartons} deps={[mode, T]} live castShadow receiveShadow>{box}<meshStandardMaterial roughness={0.8} /></Inst>
      <Inst count={n} fill={hits}
        onClick={(e) => { e.stopPropagation(); onPick({ type: 'bulk', id: bulkBays[e.instanceId].id }) }}
        onPointerMove={(e) => { e.stopPropagation(); setHover({ type: 'bulk', id: bulkBays[e.instanceId].id }) }}
        onPointerOut={() => setHover(null)}>
        {box}<meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </Inst>
    </group>
  )
}

/* ---------- people ---------- */
function Worker({ w, T, selected, onPick, setHover }) {
  const g = useRef(), body = useRef(), load = useRef()
  const runner = w.role === 'runner'
  const phase = useMemo(() => Math.random() * 6, [])
  useFrame(() => {
    const [x, z] = toWorld(w.x, w.y), moving = w.path.length > 0
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

/* ---------- hall shell ---------- */
function Truck({ t, T, selected, onPick, setHover }) {
  const g = useRef(), lab = useRef(), fill = useRef(), acc = useRef(1)
  useFrame((_, dt) => {
    const [x, z] = toWorld(t.x, t.y)
    g.current.position.set(x, 0, z)
    g.current.rotation.y = -t.h
    acc.current += dt
    if (acc.current > 0.25) {
      acc.current = 0
      const eta = Math.max(0, Math.ceil(((1 - t.progress) * truckSeconds(t)) / 60))
      const txt = t.st === 'waiting' ? `Waiting ${Math.round(t.waited / 60)} min` : t.st === 'queue' ? 'In yard queue' : t.st === 'arriving' ? 'Arriving' : t.st === 'leaving' ? 'Leaving'
        : `${t.dir === 'in' ? 'Unloading' : 'Loading'} ${Math.round(t.progress * 100)}% · ${eta} min`
      if (lab.current) lab.current.textContent = `${t.id} · ${txt}`
      if (fill.current) { fill.current.style.width = (t.st === 'docked' ? t.progress * 100 : 0) + '%'; fill.current.style.background = t.st === 'waiting' ? T.warn : T.ok }
    }
  })
  return (
    <group ref={g}
      onClick={(e) => { e.stopPropagation(); onPick({ type: 'truck', id: t.id }) }}
      onPointerOver={(e) => { e.stopPropagation(); setHover({ type: 'truck', id: t.id }) }}
      onPointerOut={() => setHover(null)}>
      <mesh position={[-1, 1.9, 0]} castShadow><boxGeometry args={[9.6, 3.0, 2.6]} /><meshStandardMaterial color={T.truck} roughness={0.6} /></mesh>
      <mesh position={[5, 1.3, 0]} castShadow><boxGeometry args={[2.0, 2.4, 2.4]} /><meshStandardMaterial color={T.cabTruck} /></mesh>
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

function DockStrips({ T }) {
  return DOCKS.map((d) => <DockStrip key={d.id} d={d} T={T} />)
}
function DockStrip({ d, T }) {
  const m = useRef()
  const [cx, cz] = d.wall === 'y' ? toWorld((d.a + d.b) / 2, 1.1) : toWorld(1.1, (d.a + d.b) / 2)
  const size = d.wall === 'y' ? [d.b - d.a, 2.2] : [2.2, d.b - d.a]
  useFrame(() => { if (m.current) m.current.color.set(dockStatus(d).cls === 'ok' ? T.ok : dockStatus(d).cls === 'warn' ? T.warn : T.neutral) })
  return <mesh rotation-x={-Math.PI / 2} position={[cx, 0.02, cz]}><planeGeometry args={size} /><meshBasicMaterial ref={m} transparent opacity={0.5} /></mesh>
}

function Walls({ T }) {
  const wh = H.wallH, doorH = 4.0
  const parts = []
  const addWall = (axis, len) => {
    const ds = DOCKS.filter((d) => d.wall === axis).sort((a, b) => a.a - b.a)
    let at = 0
    const seg = (a, b, k) => {
      const l = b - a, mid = (a + b) / 2
      const [x, z] = axis === 'y' ? toWorld(mid, -0.2) : toWorld(-0.2, mid)
      parts.push(<mesh key={axis + k} position={[x, wh / 2, z]} castShadow receiveShadow><boxGeometry args={axis === 'y' ? [l, wh, 0.4] : [0.4, wh, l]} /><meshStandardMaterial color={T.wall} roughness={0.9} /></mesh>)
    }
    const lintel = (a, b, k) => {
      const l = b - a, mid = (a + b) / 2, [x, z] = axis === 'y' ? toWorld(mid, -0.2) : toWorld(-0.2, mid)
      parts.push(<mesh key={axis + 'l' + k} position={[x, (doorH + wh) / 2, z]}><boxGeometry args={axis === 'y' ? [l, wh - doorH, 0.4] : [0.4, wh - doorH, l]} /><meshStandardMaterial color={T.wall} roughness={0.9} /></mesh>)
    }
    ds.forEach((d, i) => { if (d.a > at) seg(at, d.a, i); lintel(d.a, d.b, i); at = d.b })
    seg(at, len, 99)
  }
  addWall('y', H.w); addWall('x', H.d)
  return <group>{parts}</group>
}

function Floor({ T, sel }) {
  const plane = (x0, y0, x1, y1, color, op, key, y = 0.01) => {
    const [cx, cz] = toWorld((x0 + x1) / 2, (y0 + y1) / 2)
    return <mesh key={key} rotation-x={-Math.PI / 2} position={[cx, y, cz]} receiveShadow><planeGeometry args={[x1 - x0, y1 - y0]} /><meshStandardMaterial color={color} transparent={op < 1} opacity={op} roughness={0.95} /></mesh>
  }
  const label = (txt, x, y, color) => {
    const [px, pz] = toWorld(x, y)
    return <Html key={txt} position={[px, 0.1, pz]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}><div className="zlabel" style={{ color }}>{txt}</div></Html>
  }
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.05, 0]} receiveShadow><planeGeometry args={[220, 180]} /><meshStandardMaterial color={T.yard} roughness={1} /></mesh>
      {plane(-23, -20, 82, -14, T.road, 1, 'roadN', -0.03)}
      {plane(-20, -20, -14, 62, T.road, 1, 'roadW', -0.025)}
      {plane(0, 0, H.w, H.d, T.floor, 1, 'f', 0)}
      {plane(5, 4.5, 31, 38, T.pickZone, 0.1, 'pz')}
      {plane(33, 4.5, 59.5, 38, T.bulkZone, 0.1, 'bz')}
      {plane(30.4, 2, 33.6, 38, T.lane, 0.22, 'lane')}
      {plane(0.4, 4, 3.6, 36, T.stage, 0.16, 'stage')}
      {plane(33, 0.4, 59.6, 5, T.receiving, 0.1, 'recv')}
      <DockStrips T={T} />
      {sel.type === 'dock' && (() => {
        const d = DOCKS.find((x) => x.id === sel.id), [cx, cz] = d.wall === 'y' ? toWorld((d.a + d.b) / 2, 1.1) : toWorld(1.1, (d.a + d.b) / 2)
        return <mesh rotation-x={-Math.PI / 2} position={[cx, 0.05, cz]}><ringGeometry args={[2.4, 2.7, 4, 1, Math.PI / 4]} /><meshBasicMaterial color={T.accent} /></mesh>
      })()}
      {label('PICK ZONE', 18, 2.2, T.pickZone)}
      {label('BULK ZONE', 46, 38.2, T.bulkZone)}
      {label('REPLEN LANE', 32, 39.2, T.lane)}
      {label('OUTBOUND STAGING', 2, 38.2, T.stage)}
      {label('RECEIVING', 46, 1.2, T.receiving)}
      {label('YARD', 50, -26, T.muted)}
    </group>
  )
}

/* ---------- selection, focus, hover ---------- */
const entity = (r) => {
  if (!r) return null
  if (r.type === 'pick' || r.type === 'bulk') {
    const b = byId[r.id], [x, z] = toWorld(b.cx, b.cy), h = r.type === 'pick' ? RACK_H + 0.2 : BULK_H + 0.2
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
    const [x, z] = toWorld(t.x, t.y); pos = [x, 5.4, z]; text = `${t.id} · ${t.car}`
  } else if (hover.type === 'worker') {
    const w = workerById[hover.id]; const [x, z] = toWorld(w.x, w.y); pos = [x, 2.3, z]; text = `${w.id} · ${w.status}`
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
    const sub = follow && (workerById[follow] || sim.trucks.find((t) => t.id === follow))
    if (sub) {
      const [x, z] = toWorld(sub.x, sub.y), back = sub.role ? 6 : 15, up = sub.role ? 3.4 : 8
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
  return <OrbitControls ref={controls} makeDefault enabled={!follow} enableDamping dampingFactor={0.08} minDistance={5} maxDistance={140} maxPolarAngle={Math.PI / 2.04} />
}

export default function Scene({ dark, mode, sel, focus, hover, setHover, onPick, view, follow, views }) {
  const T = THEMES[dark ? 'dark' : 'light']
  const pickSel = sel.type === 'pick' || sel.type === 'bulk' ? sel : null
  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: views.overview.pos, fov: 38, near: 0.5, far: 400 }}
      onPointerMissed={() => setHover(null)} gl={{ antialias: true }}>
      <color attach="background" args={[T.bg]} />
      <fog attach="fog" args={[T.bg, 110, 240]} />
      <hemisphereLight args={[dark ? '#8aa0b8' : '#ffffff', dark ? '#1a232a' : '#9aa6ad', dark ? 0.7 : 0.9]} />
      <directionalLight position={[34, 60, 26]} intensity={dark ? 1.1 : 1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}
        shadow-camera-left={-50} shadow-camera-right={50} shadow-camera-top={50} shadow-camera-bottom={-50} shadow-camera-near={10} shadow-camera-far={160} />
      <Sim />
      <CameraRig view={view} follow={follow} views={views} />
      <Floor T={T} sel={sel} />
      <Walls T={T} />
      <Trucks T={T} sel={sel} onPick={onPick} setHover={setHover} />
      <PickZone mode={mode} T={T} onPick={onPick} setHover={setHover} />
      <BulkZone mode={mode} T={T} onPick={onPick} setHover={setHover} />
      {sim.workers.map((w) => <Worker key={w.id} w={w} T={T} selected={sel.type === 'worker' && sel.id === w.id} onPick={onPick} setHover={setHover} />)}
      {focus && <Focus ids={focus} T={T} />}
      {pickSel && <Outline r={pickSel} color={T.accent} />}
      {hover && hover.id !== sel.id && (hover.type === 'pick' || hover.type === 'bulk') && <Outline r={hover} color={dark ? '#ffffff' : '#15202a'} />}
      <Tip hover={hover} T={T} />
    </Canvas>
  )
}
