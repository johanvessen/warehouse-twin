# Warehouse digital twin (mock-up)

React + React Three Fiber (three.js). One hall with a bulk zone (pallet racking) and a pick zone (shelving),
20 order pickers, 5 bulk runners and live replenishment from bulk to pick. All data is simulated.

## Run

    npm install
    npm run dev        # http://localhost:5173

## Where things live

- `src/data.js`  pick faces, bulk bays, docks, quick wins, tour steps, camera views. Swap the generators for WMS data.
- `src/sim.js`   the simulation: pickers walk orders, faces drain, replenishment tasks are queued and carried by runners.
- `src/Scene.jsx` the 3D scene (instanced racks, people, walls, camera rig).
- `src/App.jsx`  panels: replenishment counters, "bigger slot yes/no" advice, quick wins, alerts, inspector, docks.

## Rules behind the numbers

- A pick face triggers replenishment at 35% of its capacity (`min` in `data.js`).
- Bigger slot = yes when a face empties 2.5 times a day or more and a larger size exists (S 24, M 48, L 96 units).
  Estimated saving is the tasks per week you avoid by doubling capacity.
