# ⚡ Msotra Gameplay Lab — "Spaza Defense & Grid Guardians"

A gamified civic-reporting platform for Soweto, disguised as a high-stakes stealth game.
Residents play as anonymous **Msotra Agents**, feed real intel on cable theft and
infrastructure damage to City Power / SAPS, and earn **Msotra Coins** redeemable for
airtime, data and Eskom prepaid tokens.

The hard part isn't the game. It's that **reporting cable theft in a township can get you
killed.** So the entire architecture is built around one guarantee: nothing that could
identify, locate or expose a reporter ever crosses the municipal boundary.

## Run it on a laptop that has nothing installed

**There is no `npm install` step.** The project has zero dependencies, so the only thing
anyone needs is Node.js itself (npm ships with it, unused here).

### 1. Install Node.js 22.5 or newer — once, about 30 seconds

| OS | Command | Or download |
|---|---|---|
| Windows | `winget install OpenJS.NodeJS.LTS` | [nodejs.org](https://nodejs.org) → LTS → run the `.msi` |
| macOS | `brew install node` | [nodejs.org](https://nodejs.org) → LTS → run the `.pkg` |
| Linux | — | [nodejs.org](https://nodejs.org) LTS (distro packages are usually too old) |

Then **open a new terminal** (PATH only refreshes in new windows) and check:

```bash
node --version      # must print v22.5.0 or higher
```

### 2. Get the folder

`git clone` it, or just copy/unzip the folder. Nothing to fetch, install or build.

### 3. Start it

- **Windows:** double-click **`START-WINDOWS.bat`**
- **macOS / Linux:** `bash start.sh`
- **Any terminal**, from inside the project folder: `node server.mjs`

### 4. Open http://localhost:7788

Keep the terminal window open — closing it or pressing Ctrl+C stops the server, and the
page will then show `ERR_CONNECTION_REFUSED`.

```bash
node server.mjs      # or: npm start   (identical)
npm run seed         # optional, with the server up: fills the Hood Leaderboard with rivals
npm test             # 10 tests proving the anonymity guarantees
```

Node 22.5+ is required because the app uses Node's built-in SQLite (`node:sqlite`) — which
is exactly what lets it run with no packages at all. On an older Node it exits with a clear
message instead of crashing. Need a different port: `PORT=8080 node server.mjs`.

No build step, no packages, no API keys, no internet — it runs on a community-centre laptop
that is completely offline.

## The three-move Stealth Quest

| Move | Tab | What the player does |
|---|---|---|
| 1 | 🗺️ **Drop Pin** | Taps the exact spot on a custom SVG map of 12 Soweto zones (Orlando West, Diepkloof, Jabulani, Klipspruit, Meadowlands, Pimville…) — a map-strategy puzzle, not a form field |
| 2 | 💬 **Kasi Intel** | Reports through a WhatsApp-style chat with "Control", with quick-reply chips. The scrubber runs live and tells you what it removed as you type |
| 3 | 📸 **Paparazzi** | Uploads photos of the damage from cover. Triggers the **Proof Uploaded** seal animation + an Amapiano log-drum riff |

Then **Transmit** → a safety loading screen → a **Ghost Agent Receipt** showing the player
the exact JSON that reached City Power, and what was destroyed on the way.

## Ghost Agent — the anonymity pipeline

Five stages in [`src/ghost.mjs`](src/ghost.mjs). Every removal is written to a
`sanitization_log` row as evidence.

1. **Pseudonymise** — the callsign is replaced by an HMAC handle (`GHOST-A31F7C`) derived
   from a random nonce, so it can't be brute-forced back from a chosen name. Destroy the
   key and the link becomes mathematically unrecoverable — we can't be compelled to reveal
   what we can't compute.
2. **Scrub the text** — 10 South-Africa-tuned rules strip mobile numbers, 13-digit ID
   numbers, emails, GP plates, house/stand numbers, bank details, social handles, family
   references and self-identification (`"its me Thabo from no 4432"`). Operational detail
   ("cutting the main cable behind the transformer box") survives intact.
3. **Blur the geography** — the pin is *snapped* to a 150 m grid, not jittered, so repeat
   reports from one spot can never be averaged back to a doorstep. Timestamps round to a
   15-minute window.
4. **Destroy media metadata** — JPEGs and PNGs are rebuilt byte-by-byte in pure JS.
   APP1/EXIF (incl. the GPS IFD), APP13/IPTC, XMP, vendor blocks, comments and PNG
   `tEXt`/`eXIf` chunks are never copied into the new file. Unknown containers are
   **rejected**, not guessed at.
5. **Allowlist + tripwire** — the municipal payload is built from an empty object using 14
   approved fields, so a new database column can never start leaking. Then a final sweep
   re-scans the human-authored strings for identifiers and checks numerically that the
   blurred pin ≠ the real one. A hit **fails the send closed**.

What City Power actually receives:

```json
{
  "case_ref": "GG-1EA6DC",
  "category": "cable_theft",
  "severity": 5,
  "description": "Hi [SELF-ID-REDACTED] from [ADDRESS-REDACTED] Vilakazi, call me on [PHONE-REDACTED] or [EMAIL-REDACTED]. ID [ID-REDACTED]. Three guys cutting the main cable behind the transformer box, bakkie [PLATE-REDACTED].",
  "zone": "Orlando West",
  "crew_area": "Orlando Crew",
  "landmark": "Vilakazi Street",
  "lat": -26.2386, "lng": 27.90585, "location_precision_m": 150,
  "observed_window": "2026-09-17T10:30:00.000Z",
  "evidence_count": 1, "evidence_hash": "20f7ee24fd18d5bf",
  "source": "Grid Guardians / anonymous community report"
}
```

The 👻 **Ghost Agent** tab lets a judge type anything into the scrubber and watch the
before/after side by side, then read the full audit trail.

## Economy, progression, competition

- **Append-only ledger** (`ledger` table) — every balance change writes a row inside a
  transaction, so the cached balance can never drift from its history. Overspend is
  blocked at the database level (`CHECK (coin_balance >= 0)`).
- **Payouts on verification only** — City Power / SAPS confirm a case, then coins fire.
  Payout scales with asset risk × severity, plus a photo-evidence bonus.
- **Ranks**: Observer → Street Captain (150 XP) → Soweto Legend (500 XP), with a rank-up
  takeover animation.
- **Redemption gateway**: R10 airtime · 500MB / 1GB data · R50 / R100 Eskom prepaid tokens
  (issued as correctly-formatted 20-digit tokens). Vouchers are issued to the *ghost
  handle* — no phone number is stored to receive them.
- **Hood Leaderboard**: live crew-vs-crew standings (Meadowlands vs Pimville vs Orlando…),
  per-zone heat with grid-health bars, and a top-agents board showing **ghost handles only**.
  Updates push over Server-Sent Events.

## Safety by design

- A rotating safety band is pinned to the top of every screen, and the transmit loading
  screen repeats: *"Real Msotra heroes report from a safe distance — never approach suspects."*
- Real hotlines are surfaced on the HQ tab (City Power 011 375 5555, SAPS 10111).
- The app states plainly that it is **not an emergency line**.
- Ghost Agent is on by default and can't be silently disabled.

## 🔌 Blackout Escape Room (live event module)

A 5-minute offline countdown for community-centre events. The lights go out, and the team
races to solve three clues — each one forces them to look up a *real* community reporting
number. Every clue solved switches a light back on; all three restores power and pays the
captain 60 coins. Runs with no internet, results go to a drill leaderboard.

## 🗺️ Street map (OpenStreetMap)

The Drop Pin tab defaults to a real OpenStreetMap street map, with a toggle back to the
stylised **Grid map**. The street map shows the dashed 150 m cell around your pin, which is
exactly what City Power receives.

- **The reporter's browser never talks to OSM.** Tiles are fetched by our server at
  `/tiles/{z}/{x}/{y}.png`. Otherwise OSM's tile servers would log the reporter's IP address
  next to the exact streets they zoomed into.
- **Cached on disk** in `data/tiles/`. Areas viewed once keep working offline.
- **Limited to the Soweto area, zoom levels 11–18**, so the proxy can't be abused as a
  general tile downloader (OSM's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  forbids bulk downloading).
- **Offline:** if no tiles load at all, the app switches to the Grid map automatically.
- Leaflet 1.9.4 is in `public/vendor/leaflet/`, so there's still no `npm install`.

## Architecture

```
server.mjs            zero-dep HTTP: static + JSON API + SSE live stream + OSM tile proxy
src/preflight.mjs     Node version guard with a human-readable failure
src/ghost.mjs         the Ghost Agent pipeline (the heavy lift)
src/db.mjs            10-table relational schema + haversine zone queries
src/economy.mjs       ledger, ranks, redemption, leaderboard aggregates
public/index.html     8-tab single-page app
public/app.js         SVG map projection, chat, upload, wallet, boards, escape room
public/vendor/leaflet Leaflet 1.9.4 (vendored, BSD-2) for the street map
public/sfx.js         Amapiano log drum + Kwaito stabs, synthesised in WebAudio (no assets)
tests/pipeline.test.mjs
```

**Data model** (SQLite, foreign keys on): `zones`, `agents`, `reports`, `report_media`,
`intel_messages`, `ledger`, `redemptions`, `sanitization_log`, `webhook_outbox`,
`escape_sessions`. Raw narratives and exact coordinates live only in `reports` and are
never selected into any outbound or public response — `/api/case/:ref` is the proof.

**Audio**: no sound files. The Amapiano log drum is a pitch-dropping sine through a `tanh`
waveshaper; shakers are filtered noise bursts. The whole soundtrack is ~150 lines of
WebAudio, so the app stays tiny on a capped data bundle.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | zones, catalogue, ranks, safety copy, hotlines |
| POST | `/api/agent` | enlist / return a ghost handle |
| POST | `/api/reports` | submit a drop → runs all 5 Ghost stages, returns the receipt |
| POST | `/api/verify` | City Power / SAPS confirm → coins + XP fire |
| POST | `/api/ghost/preview` | live scrub of arbitrary text (used while typing) |
| GET | `/api/ghost/audit` | full sanitisation evidence trail |
| GET | `/api/case/:ref` | public dossier — proves what a third party *cannot* read |
| GET | `/api/leaderboard` · `/api/hotzones?lat&lng&radius` | crew/zone/agent boards, geospatial |
| GET | `/api/wallet?callsign=` · POST `/api/redeem` | ledger + redemption gateway |
| POST | `/api/escape/start` · `/api/escape/finish` | Blackout Escape Room |
| GET | `/events` | SSE: reports, verifications, leaderboard |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` in the browser | nothing is listening — the server isn't running, or its terminal was closed | start it again and leave the window open |
| `EADDRINUSE: address already in use :::7788` | another copy is still running | Windows: `Get-NetTCPConnection -LocalPort 7788 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` · macOS/Linux: `lsof -ti:7788 \| xargs kill` · or use `PORT=8080` |
| `Cannot find module 'node:sqlite'` | Node older than 22.5 | install current Node LTS |
| `node: command not found` | Node not installed, or terminal opened before install | install Node, then open a **new** terminal |

## What's simulated for the demo

Municipal delivery is written to a `webhook_outbox` table rather than POSTed to City
Power's live endpoint, and a **Control Room Simulator** on the Wallet tab stands in for a
municipal controller confirming a case. Both are one swap away from real: point the outbox
at the City Power endpoint, and verification arrives as a webhook callback. Vouchers are
generated locally in the correct formats, ready for an airtime/token aggregator.
