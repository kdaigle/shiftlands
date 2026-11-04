# Shiftlands

A small cooperative settlement on islands whose connections **shift**. Gather
materials with friends, build a permanent camp upgrade, and explore the route
it unlocks. Progress survives leaving the game and restarting the server.
There is no combat, chat, trading, or offline punishment.

## Play

Use **Node 22.13+** (built-in SQLite required). Development was exercised on
Node 22.23.4; the coordinator's Node 26 is compatible with the required APIs
but has not yet been directly exercised here.

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
- **E / Interact:** gather beside a resource or contribute beside camp.
- Click a pack resource to choose what to contribute.
- **Reconnect:** reconnect using the same private identity.
- Walk left for Willow, right for Quartz; bring **4 Willow + 2 Quartz** to camp.
  The upgrade opens a real southern bridge to Sunstone.
- Bring **3 Sunstone** back to light the shared beacon.
- Every **75 seconds**, the northern bridge switches sides. A **12-second
  warning** precedes the shift. Travelers on a disappearing bridge return
  safely to camp. Packs and camp upgrades are not reset; resource nodes refill.

Your browser stores a private guest credential for each backend origin.
Nicknames are labels, not login credentials. Keep browser storage to retain
your traveler; clearing it creates a new identity. Only one active connection
per identity is allowed. Do not share credentials or move production saves
into the public assets directory.

SQLite stores inventories, resource availability, camp progression, positions,
and the shift schedule. Inventory deductions and shared awards are transactional.
Restart with the **same DB_PATH** to keep progress. Offline time advances the
tide schedule but does not remove packs or camp upgrades. Back up a running
SQLite database with a SQLite-aware backup tool, or stop the server before
copying the save and its associated files.

## Verify and package

```sh
npx playwright install --with-deps chromium  # first-time browser setup
npm run check                              # TypeScript
npm test                                   # authoritative invariants
npm run verify                             # production build + invariants + real two-browser journey
npm run package                            # builds both distribution ZIPs
```

`npm run verify` is the CI acceptance command. The browser journey starts at
the join UI and uses real keyboard/pointer controls, including a normal-speed
shift and an actual server restart against the same temporary database.
Read-only `window.shiftlands` snapshots assist observation, not action execution.
Gameplay evidence and actual actions/results are in
[evidence/verification.txt](evidence/verification.txt).

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

The implementation app cannot publish GitHub Actions workflows: the GitHub
push was rejected for missing `workflows` permission. No workflow was
installed. A maintainer can run `npm run verify` in CI, then `npm run package`
and upload `artifacts/` using their existing artifact mechanism.

This repository is not a public game server; sandbox localhost is not an
externally reachable preview or permanent hosting. No public backend has
been deployed. Public hosting requires your own TLS reverse proxy with
WebSocket upgrades, persistent writable storage, and operational monitoring.

## Scope and limits

This is a tiny shared-world cooperative slice, not an MMO. Two-player browser
play is the acceptance target; larger-scale load, public-internet operations,
and cross-browser/mobile-device support are not measured. The server caps
WebSocket connections at 32 as a safety bound, not a tested capacity claim.
Guest identity has no account recovery or cross-device transfer. Once the
beacon is complete, exploration/gathering continue but no additional upgrade
tiers are implemented.

## Game Off 2026

This project interprets **SHIFT** as changing traversable island connections,
not a cosmetic palette change. The camp and inventory are lasting anchors
while the surrounding routes change.

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
cooperative shifting-islands concept.
