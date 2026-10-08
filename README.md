# Warehouse digital twin (mock-up)

React + React Three Fiber (three.js). One hall with a bulk zone (pallet racking) and a pick zone (shelving),
20 order pickers, 5 bulk runners and live replenishment from bulk to pick. All data is simulated.

## Run

    npm install
    npm run dev        # http://localhost:5173

## How it plays

The hall is the interface: a full-screen 3D map with a game-style HUD.

- Click a pick face, bulk bay, person or truck to open its unit card (status, ETA, stock) with commands:
  replenish now, upsize slot, follow, move a waiting truck to a free dock.
- Trucks arrive in the yard, dock, load or unload with a live progress badge and leave. Outbound trucks fill as pickers drop orders at staging.
- Minimap bottom right: click to move the camera. Site switcher top left (three simulated sites).
- Keys: 1 to 6 camera views, space pause, F follow the selected unit, Esc clear.

## Where things live

- `src/data.js`  pick faces, bulk bays, docks, quick wins, tour steps, camera views. Swap the generators for WMS data.
- `src/sim.js`   the simulation: pickers walk orders, faces drain, replenishment tasks are queued and carried by runners.
- `src/Scene.jsx` the 3D scene (instanced racks, people, walls, camera rig).
- `src/App.jsx`  panels: replenishment counters, "bigger slot yes/no" advice, quick wins, alerts, inspector, docks.

## Rules behind the numbers

- A pick face triggers replenishment at 35% of its capacity (`min` in `data.js`).
- Bigger slot = yes when a face empties 2.5 times a day or more and a larger size exists (S 24, M 48, L 96 units).
  Estimated saving is the tasks per week you avoid by doubling capacity.

