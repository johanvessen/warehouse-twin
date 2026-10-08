# Warehouse digital twin (mock-up)

React + React Three Fiber (three.js). One hall with a bulk zone (pallet racking) and a pick zone (shelving),
20 order pickers, 5 bulk runners and live replenishment from bulk to pick. All data is simulated.

## Run

    npm install
    npm run dev        # http://localhost:5173

## How it plays

The hall is the interface: a full-screen 3D map with a game-style HUD.

- **Flows.** Receiving unloads into inbound staging, forklifts put pallets away in bulk. Pickers walk the pick zone,
  hand orders to six pack benches, packed orders wait in outbound staging and are loaded onto outbound trucks.
  Runners replenish pick faces from the bulk reserve columns.
- **Safety framework.** Forklifts and people share the bulk aisles under right-of-way locks (one type per aisle), gate lights,
  slow and stop zones around every forklift, speed limits and zoning. Switch the Safety layer on to see it, and switch the
  system off in the Safety tab to see what happens without it (near misses start to count).
- **Transfers.** Two shuttle trucks carry transfer orders from the south docks (XF-1, XF-2) to a sub-warehouse across the road
  and bring returns back. Open the Transfers tab for the order list.
- **Realistic layer (default).** Natural colours: carrier-liveried trucks with opening rear doors, forklifts, walking people with carts, parked cars, trees, a gatehouse and road markings. The analysis layers (Fill, Pick heat, Replen, Slot fit, Safety) recolour the same scene.
- Click a pick face, bulk bay, person, forklift, pack bench or truck to open its unit card with commands
  (replenish now, upsize slot, follow, move a waiting truck to a free dock).
- Minimap bottom right: click to move the camera. Site switcher top left (three simulated sites).
- Keys: 1 to 8 camera views, space pause, F follow the selected unit, Esc clear.
- Start state from the URL hash, for example `#mode=safety&view=bulk&tab=safety`.

## Where things live

- `src/data.js`  pick faces, bulk bays, docks, quick wins, tour steps, camera views. Swap the generators for WMS data.
- `src/sim.js`   the simulation: pickers walk orders, faces drain, replenishment tasks are queued and carried by runners.
- `src/Scene.jsx` the 3D scene (instanced racks, people, walls, camera rig).
- `src/App.jsx`  panels: replenishment counters, "bigger slot yes/no" advice, quick wins, alerts, inspector, docks.

## Rules behind the numbers

- A pick face triggers replenishment at 35% of its capacity (`min` in `data.js`).
- Bigger slot = yes when a face empties 2.5 times a day or more and a larger size exists (S 24, M 48, L 96 units).
  Estimated saving is the tasks per week you avoid by doubling capacity.



