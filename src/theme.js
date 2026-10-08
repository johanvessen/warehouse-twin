import { useEffect, useState } from 'react'
import * as THREE from 'three'

export const THEMES = {
  light: {
    bg: '#dde3e6', horizon: '#dbe9f1', grass: '#86a85f', yard: '#858d93', road: '#6a7279', yardText: '#eef3f6', wallBase: '#2a6fb0', steel: '#8996a1', door: '#b7c1c8', muted: '#566772', floor: '#d3d8db', grid: '#b9c3c8', wall: '#e9eef2', post: '#456a8f', beam: '#e07b2a', shelf: '#8fa3b2',
    wood: '#a98456', carton: '#c9a06a', truck: '#f4f6f7', cabTruck: '#aab6bc', neutral: '#a9b6bb',
    pickZone: '#2a6fdb', bulkZone: '#d08a1e', lane: '#7a54d6', stage: '#1d8548', receiving: '#1c5fd1',
    fork: '#f28c0f', cross: '#f2c400', pack: '#14a39a', ok: '#1d8548', warn: '#d9822b', crit: '#c2392a', accent: '#1c5fd1', picker: '#f08a1c', runner: '#d6e02a', skin: '#d9ad8a', pants: '#2c3946',
    stock: ['#d6e6e3', '#93c9c0', '#46a0a4', '#1f7a8c'],
    heat: ['#f1e5d0', '#efb35e', '#d4672a', '#7e2418'],
    repl: ['#e7e1f4', '#b39ae0', '#7a54d6', '#3d1f8f'],
    slot: { up: '#e0661c', down: '#3f7fd6', ok: '#8fb0ad' },
  },
  dark: {
    bg: '#0d1317', horizon: '#27384a', grass: '#27402c', yard: '#1c252b', road: '#151d22', yardText: '#9fb0ba', wallBase: '#2c6aa8', steel: '#566774', door: '#47565f', muted: '#8c9ea8', floor: '#222d34', grid: '#24323a', wall: '#34434d', post: '#35597f', beam: '#d0701f', shelf: '#4b5f6e',
    wood: '#7d6140', carton: '#9a7849', truck: '#8797a0', cabTruck: '#5a6b74', neutral: '#3d4e57',
    pickZone: '#4d90f0', bulkZone: '#e0a030', lane: '#9b7bff', stage: '#46c47c', receiving: '#5d9cff',
    fork: '#ff9f1c', cross: '#ffd23a', pack: '#2ec4b6', ok: '#46c47c', warn: '#f0a63a', crit: '#ff6e5a', accent: '#5d9cff', picker: '#ff9a2e', runner: '#e8f23a', skin: '#c99a78', pants: '#10161b',
    stock: ['#244650', '#25706f', '#4fb8ac', '#c4f3e2'],
    heat: ['#3a2c1f', '#97561c', '#ec8a30', '#ffd596'],
    repl: ['#2f2848', '#5b3fb0', '#9b7bff', '#e0d2ff'],
    slot: { up: '#ff8a3d', down: '#5d9cff', ok: '#3f5f5c' },
  },
}

export function useDark() {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)'), f = () => setDark(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return dark
}

const A = new THREE.Color(), B = new THREE.Color()
export function ramp(stops, t, out) {
  t = Math.min(1, Math.max(0, t))
  const n = stops.length - 1, i = Math.min(Math.floor(t * n), n - 1)
  return out.copy(A.set(stops[i])).lerp(B.set(stops[i + 1]), t * n - i)
}
