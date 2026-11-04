# Shiftlands

A small cooperative **Rising Tide** survival-and-building game, alone or with
friends. **The sea rises with every tide. Gather from the outer islands before
they flood, then build seawalls so the haven and its land stay dry.**

Each surge is the **SHIFT**: sea-connected low land becomes water. Walls,
materials, flood damage, and personal progress survive reconnect and server
restart. There is no final quest that ends the world, and tides pause when
nobody is connected. **No public multiplayer server is hosted.**

## Play

Use **Node 22.13+** (built-in SQLite required). This delivery is validated on
**Node 22.23.4**. Earlier branch evidence records runs on Node 22.13.0 and
26.13.0; those versions were not re-tested for this delivery.

From the repository root:

```sh
npm ci
npm run build
HOST=127.0.0.1 PORT=3000 DB_PATH=/absolute/writable/path/world.sqlite npm start
```

Open `http://127.0.0.1:3000`, enter a nickname, and select **Enter the islands**.
For two players on one machine, use separate browser profiles or isolated
browser contexts—not two tabs in the same profile. To play across a LAN, bind
`HOST=0.0.0.0` and give your friend the server's LAN address and port. That
exposes the game on your network; use only a trusted network for plain HTTP.

- **WASD / arrow keys:** move. Touch direction buttons also move.
- **E / Interact:** gather beside a grove/quarry, collect driftwood after
  recession, or bank one selected material at the central storehouse.
- **B:** build a wood wall on the highlighted adjacent tile (3 wood).
- **V:** build a stone wall (3 stone + 1 wood).
- **R:** repair a highlighted wall (1 matching material).
- Face a tile by moving toward it, or click an adjacent tile. Buttons also
  support building and repairing. Click a pack resource to select what to bank.
- **Reconnect:** reconnect using the same private identity.

### Your first wall

Walk left and slightly up from the storehouse to the **starter grove**.
Press E three times to gather 3 wood. From the grove, face left and press B
to build on the glowing marker. Stay on the grove and watch the wall block
the first surge. The three-step tracker records this permanently.
Then protect more land, repair battered walls, or work on the shared Lookout.

### The tide

A gathering countdown normally lasts **90 seconds**. The always-visible countdown gives its
height; tile numbers show ground elevation. During the final **15 seconds**,
every tile forecast to flood is red. At surge, water spreads from the sea
through tiles **below** that height, unless blocked by high ground or a wall
strong enough for that surge. Flooded tiles cannot be crossed.

Wood walls hold up to height **3**; stone walls hold up to **5**. Successful
defenses wear down durability, shown on each wall. Repair before it breaks;
broken walls do not block water. A higher surge overtops a weaker wall.
Surge heights repeat predictably, with **every eighth a height-6 King Tide**.
Neither wall type alone can stop a King Tide: use elevation-6 ridges as
natural barriers, preserve high fields, and bank supplies to rebuild afterward.
The elevation-7 haven and its recovery resources always stay safe.

Flooded nodes wash away. A swept traveler returns to the haven and loses
**only carried materials**—banked materials, identity, and shared construction
remain. Water then recedes, leaving driftwood to gather. Groves and quarries
refill only if their tile stayed dry through the previous tide; repeatedly
flooded land stays stripped. Protected land is a renewable shared resource.

Bank **12 wood + 8 stone** at the storehouse to build the **Lookout**, extending
warnings and revealing the next two surge forecasts. The haven board tracks
dry land held, tides weathered, and top builders. There is no permanent win
or game over; even a battered world can recover.

### Timing configuration

```sh
TIDE_PERIOD_MS=30000 TIDE_WARNING_MS=10000 \
  HOST=127.0.0.1 PORT=3000 DB_PATH=/absolute/writable/path/world.sqlite npm start
```

`TIDE_PERIOD_MS` defaults to `90000`; `TIDE_WARNING_MS` defaults to `15000`.
They are server settings, not browser controls. Use short timings to play
several tides quickly. Keep the warning shorter than the period; all timing
values must be integer milliseconds, at least `100`.
Surge holds water for `TIDE_SURGE_MS` (default `8000`), followed by
`TIDE_RECEDE_MS` (default `5000`) of recession before the next gathering
countdown starts. Thus default surge-to-surge time is about 103 seconds.
A saved
world retains its current tide progress; restart never advances offline time.

Your browser stores a private guest credential for each backend origin.
Nicknames are labels, not login credentials. Keep browser storage to retain
your traveler; clearing it creates a new identity. Only one active connection
per identity is allowed. Do not share credentials or move production saves
into the public assets directory.

SQLite stores carried materials, resource availability, walls, objectives,
bank, positions, flood history, and tide progress. Costs and shared awards are transactional.
Restart with the **same DB_PATH** to keep progress. Offline time never advances
the tide schedule: tides advance only with an authenticated connection.
Back up a running
SQLite database with a SQLite-aware backup tool, or stop the server before
copying the save and its associated files.

## Verify and package

```sh
npx playwright install --with-deps chromium  # first-time browser setup
npm run check                              # TypeScript
npm test                                   # authoritative invariants
npm run verify                             # production build + invariants + real two-browser journey
npm run package                            # builds both distribution ZIPs
npm run test:package                       # extracts ZIPs and joins the bundled backend
```

`npm run verify` is the CI acceptance command. The browser journey starts at
the join UI and uses real keyboard/pointer controls, including accelerated
tides and an actual server restart against the same temporary database.
Read-only `window.shiftlands` snapshots assist observation, not action execution.
Snapshots include tide phase/time/height, forecast and flooded tiles, walls,
carried materials, and objective progress. They contain no bearer credentials
and cannot be used to control the server.
Gameplay evidence and actual actions/results are in
[evidence/verification.txt](evidence/verification.txt).
Future contributors and agents should follow [AGENTS.txt](AGENTS.txt),
especially its real-browser verification and safe-save requirements.

Packaging creates:

- `artifacts/shiftlands-runtime.zip`: client assets plus bundled server.
  Unzip, then run without a checkout, build, or dependency installation:

  ```sh
  HOST=127.0.0.1 PORT=3000 DB_PATH=/absolute/writable/path/world.sqlite node server.mjs
  ```

  Keep the mutable database **outside** the extracted runtime directory.
  `GET /health` returns readiness JSON and the live connection count.
- `artifacts/shiftlands-itch.zip`: static HTML5 client ZIP with `index.html` at
  its root. Upload as an itch.io HTML game with fullscreen enabled. The join
  screen accepts a backend origin, or use `?backend=https%3A%2F%2Fyour-server.example`.
  Multiplayer **requires a separately deployed HTTPS/WSS backend**; the ZIP
  does not contain a hosted server. Plain HTTP is blocked on an HTTPS client.

Both ZIPs include `REVISION.json`. For a release tied to a clean committed
revision, use `RELEASE_SHA="$(git rev-parse HEAD)" npm run package`;
mismatched revisions or dirty package inputs are rejected.

The delivered runtime is the sole generated archive intentionally tracked:
[artifacts/shiftlands-runtime.zip](artifacts/shiftlands-runtime.zip).
Its adjacent [provenance record](artifacts/shiftlands-runtime.provenance.json)
contains the exact clean source commit and SHA-256. Download the ZIP using
GitHub's **Raw / Download raw file** button on this PR branch, not the HTML
file preview. No dependency directory, database, or Node executable is bundled;
only Node 22.13+ is required on the coordinator's machine.

Extract the ZIP into a new directory, change into it, and run:

```sh
DB_PATH=/absolute/writable/path/outside-the-runtime/world.sqlite node server.mjs
```

By default it binds only to **127.0.0.1:3000**. Open
`http://127.0.0.1:3000`; `curl http://127.0.0.1:3000/health` checks readiness.
Override `HOST` and `PORT` explicitly if needed. Keep operational saves outside
the repository and extracted runtime. No build step or `npm install` is needed.

To reproduce the delivered ZIP, check out the provenance record's **source
commit** in a clean checkout, use its recorded Node/npm/zip versions, run
`npm ci`, then `RELEASE_SHA="$(git rev-parse HEAD)" npm run package`.
Packaging uses the source commit time, sorted file order, normalized file
permissions/timestamps and stripped ZIP extra fields; two same-toolchain builds
must produce the recorded checksum. `REVISION.json` records that source commit,
source timestamp, Node version and `sourceDirty: false`. Later delivery commits
add only the runtime and verification/provenance records, not runtime inputs.
Other generated outputs remain ignored. No workflow is installed or added.

This repository is not a public game server; sandbox localhost is not an
externally reachable preview or permanent hosting. No public backend has
been deployed. Public hosting requires your own TLS reverse proxy with
WebSocket upgrades, persistent writable storage, and operational monitoring.

## Scope and limits

This is a tiny shared-world cooperative slice, not an MMO. Two-player browser
play is the acceptance target; larger-scale load, public-internet operations,
and cross-browser/mobile-device support are not measured. The server caps
WebSocket connections at 32 as a safety bound, not a tested capacity claim.
Guest identity has no account recovery or cross-device transfer. Audio, accounts,
additional building types, and elaborate art are out of scope.
Run **one backend process per database**; multi-instance
deployment and shared session coordination are not supported.

## Game Off 2026

This project interprets **SHIFT** as tides physically redrawing land and sea,
not a cosmetic palette change. The haven and shared defenses are lasting anchors
while the surrounding shores flood and recede.

Rules below are the verified official rules supplied with the project brief;
the official pages could not be independently retrieved from this sandbox:

- Develop primarily during November. Submission deadline: **December 1, 2026,
  13:37 PST / 21:37 UTC**.
- Public GitHub source **and an explicit playable itch.io jam submission** are
  required. A public repository alone is not an entry.
- AI coding, ideation, and assets are allowed, but must be disclosed.
- Honor asset licenses; paid/proprietary assets cannot be redistributed
  without rights.
- During voting, make only critical bug fixes, with a change note. Voting ends
  January 1, 2027, 13:37 PST.
- No itch.io page, submission, paid hosting, or external deployment has been
  created or authorized by this task.

Official references:
[announcement](https://github.blog/open-source/gaming/game-off-2026-the-theme-is-shift/),
[jam](https://itch.io/jam/game-off-2026),
[FAQ](https://itch.io/jam/game-off-2026/topic/7290154/frequently-asked-questions-faq),
[itch.io HTML5 packaging](https://itch.io/docs/creators/html5).

## Licenses and AI disclosure

Code is [MIT-licensed](LICENSE). Actual artwork provenance and its separate
license declaration are in [ASSETS.txt](ASSETS.txt). No third-party artwork,
fonts, music, or sound is bundled. Third-party software retains its own
licenses and distribution notices.

GitHub Copilot cloud agents assisted with design, implementation, original
geometric artwork, tests, and documentation. The user chose the persistent
cooperative Rising Tide design.
