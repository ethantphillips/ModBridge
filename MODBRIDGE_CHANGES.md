# Modbridge Architecture, Divergences & Deployment Guide

This document provides a comprehensive technical record of all architectural additions, modifications, offline identity algorithms, deployment procedures, and upstream synchronization strategies for **Modbridge** (adapted from the Modrinth monorepo).

---

## 1. Architectural Overview

Modbridge adapts the Modrinth launcher into an offline-first, controlled-connectivity Minecraft launcher backed by a serverless reverse proxy and self-updater running on **Neon Functions**.

```
                           +-------------------------------------+
                           |         Modbridge Launcher          |
                           |  (Tauri desktop app + Vue frontend) |
                           +------------------+------------------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
         Direct local operation                               Streaming requests
     (Deterministic Offline Identity)                         (Relay + Updates)
                     |                                                 |
                     v                                                 v
        +-------------------------+                       +-------------------------+
        |  Local SHA-256 UUID Gen |                       |     Neon Functions      |
        |   (Username + PIN)      |                       | (morning-bird-71929748) |
        +-------------------------+                       +------------+------------+
                                                                       |
                                                +----------------------+----------------------+
                                                |                                             |
                                                v                                             v
                                   +-------------------------+                   +-------------------------+
                                   |      Relay Function     |                   |     Updates Function    |
                                   |  (/api, /cdn, /mojang)  |                   | (/updates.json, /latest)|
                                   +------------+------------+                   +------------+------------+
                                                |                                             |
                         +----------------------+----------------------+                      v
                         |                                             |         +-------------------------+
                         v                                             v         |  GitHub Release Assets  |
            +-------------------------+                   +--------------------+ | (ethantphillips/ModBridge)
            | Upstream Modrinth Infra |                   | Upstream Mojang /  | +-------------------------+
            |  - api.modrinth.com     |                   | Minecraft Services |
            |  - cdn.modrinth.com     |                   | (piston-meta, etc.)|
            |  - launcher-meta...     |                   +--------------------+
            +-------------------------+
```

### Core Architecture Tenets
1. **In-Place Adaptation**: Rather than rewriting or building a separate launcher from scratch, Modbridge lives directly in the monorepo, preserving existing functionality and upgradeability.
2. **Offline-First Identity**: Fresh installations default to Offline mode. Users specify a Username and an Identity PIN to produce persistent, deterministic UUIDs.
3. **Controlled Upstream Connectivity**: Launcher service requests, downloads, remote media, server status, and supported sockets use the Modbridge Relay. Unsupported destinations fail before networking; redirects remain confined. Foreground links explicitly opened in the user's browser are separate from launcher networking.
4. **Zero-Buffering Streams**: All large payloads (game jars, modpack assets, version files, release binaries) are streamed end-to-end with HTTP 206 `Range` header support.
5. **Strict Allowlisting**: The relay rejects any upstream target outside the approved allowlist, preventing open-proxy misuse.
6. **Isolated Release Channel**: The self-updater points strictly to `https://github.com/ethantphillips/ModBridge`.

---

## 2. File Divergence Record

The following table records the main adaptation points, their upstream roles, and the rationale for the Modbridge changes:

| File Path | Status | Upstream Role | Modbridge Adaptation & Rationale |
| :--- | :--- | :--- | :--- |
| `modbridge-functions/neon.ts` | **NEW** | N/A | Defines `relay` and `updates` serverless functions for Neon deployment. |
| `modbridge-functions/package.json` | **NEW** | N/A | Workspace package configuration and dependencies for Neon functions. |
| `modbridge-functions/src/relay/` | **NEW** | N/A | Streaming reverse proxy, host allowlist routing, selective JSON URL rewriting, and token authentication. |
| `modbridge-functions/src/updates/` | **NEW** | N/A | GitHub release manifest generator and asset streaming proxy locked to `ethantphillips/ModBridge`. |
| `modbridge-functions/tests/` | **NEW** | N/A | Unit and integration coverage for routing, streaming, redirects, uploads, auth, updates, sockets, server status, frontend transport, rendered media, and UUID derivation. |
| `packages/app-lib/src/state/offline_identity.rs` | **NEW** | N/A | Local deterministic UUID generation via SHA-256 algorithm with locked test vectors. |
| `packages/app-lib/src/util/relay.rs` | **NEW** | N/A | Client-side URL rewrite helper and `relay_request` wrapper directing requests to `MODBRIDGE_RELAY_BASE_URL`. |
| `packages/app-lib/src/state/minecraft_auth.rs` | **MODIFIED** | Microsoft OAuth & Mojang session state | Added `Credentials::is_offline()` and `Credentials::create_offline_user()`; bypassed online Mojang calls for offline profiles; routed Mojang services through relay. |
| `packages/app-lib/src/api/minecraft_auth.rs` | **MODIFIED** | Minecraft auth API bridge | Added `add_offline_user` command; routed session server reachability check through relay. |
| `packages/app-lib/src/api/instance/run.rs` | **MODIFIED** | Minecraft game launch logic | Skipped Mojang session server join (`/session/minecraft/join`) when launching offline accounts; routed online session join through relay. |
| `packages/app-lib/src/util/fetch.rs` | **MODIFIED** | Central HTTP fetching engine | Intercepted outgoing requests to route allowlisted Modrinth and Mojang URLs through relay and inject relay auth token. |
| `packages/app-lib/build.rs` | **MODIFIED** | Cargo compile-time script | Added default fallbacks for `MODRINTH_*` and `MODBRIDGE_*` environment variables so crates compile without requiring a `.env` file. |
| `apps/app/src/api/auth.rs` | **MODIFIED** | Tauri IPC commands for auth | Registered `add_offline_user` command handler; updated auth window title to "Sign into ModBridge". |
| `apps/app/tauri.conf.json` | **MODIFIED** | Tauri desktop configuration | Updated branding and isolated `modbridge://` scheme; CSP and HTTP capabilities permit only the two approved ModBridge service origins. |
| `apps/app/tauri-release.conf.json` | **MODIFIED** | Tauri release updater config | Pointed updater endpoint to ModBridge update function. |
| `packages/app-lib/src/state/dirs.rs` | **MODIFIED** | Directory paths | Added `MODBRIDGE_CONFIG_DIR` support and isolated `%APPDATA%\ModBridge` path resolution for side-by-side coexistence with Modrinth. |
| `packages/app-lib/src/api/handler.rs` | **MODIFIED** | External command & protocol handler | Added support for `modbridge://` deep-link URL scheme with fallback to `modrinth://`. |
| `apps/app-frontend/src/config.ts` | **MODIFIED** | Frontend endpoint config | Added `relayBaseUrl` support and routed `labrinthBaseUrl` through `<relay>/api`. |
| `apps/app-frontend/src/helpers/auth.js` | **MODIFIED** | Frontend auth invoke bridge | Added `add_offline_user(username, pin)` wrapper. |
| `apps/app-frontend/src/components/ui/AccountsCard.vue` | **MODIFIED** | Account switcher UI | Added Offline Identity creation form (Username + PIN); added "Offline" / "Microsoft" badges; defaulted to offline on fresh install. |
| `apps/app-frontend/src/App.vue` | **MODIFIED** | Main frontend layout | Routed critical announcement & news requests through config; updated top bar branding to ModBridge wordmark; updated update notification text to "ModBridge". |
| `apps/app-frontend/src/components/ui/SurveyPopup.vue` | **MODIFIED** | Survey popup UI | Replaced hardcoded `api.modrinth.com` URL with `config.labrinthBaseUrl`. |
| `apps/app-frontend/src/components/ui/ErrorModal.vue` | **MODIFIED** | Error modal UI | Updated error title from "Modrinth App" to "ModBridge". |
| `pnpm-workspace.yaml` | **MODIFIED** | Workspace manifest | Added `'modbridge-functions'` to monorepo package list. |

---

## 3. Offline Account Derivation & Test Vectors

### Derivation Algorithm
1. **Namespace Prefix**: `modbridge:offline-player:v1:`
2. **Normalization**:
   - Username is trimmed and converted to ASCII lowercase: `username.trim().toLowerCase()`
   - PIN is trimmed: `pin.trim()`
   - Casing entered by the user is preserved in the UI and game profile display, but normalized for UUID derivation to ensure consistent UUIDs regardless of capitalization changes.
3. **Digest Input**:
   `input = "modbridge:offline-player:v1:" + normalized_username + ":" + normalized_pin`
4. **Hash**: Calculate SHA-256 digest of `input` (UTF-8 bytes).
5. **UUID Formatting (RFC 4122 Variant 1, Version 4)**:
   - Take the first 16 bytes of the 32-byte digest.
   - Set Version 4: `bytes[6] = (bytes[6] & 0x0f) | 0x40`
   - Set RFC 4122 Variant: `bytes[8] = (bytes[8] & 0x3f) | 0x80`
   - Format into canonical 8-4-4-4-12 hyphenated hex string.

### Locked Test Vectors
These vectors are verified and locked across both TypeScript (`modbridge-functions/tests/uuid.test.ts`) and Rust (`packages/app-lib/src/state/offline_identity.rs`):

| Username | Identity PIN | Derived Offline Player UUID |
| :--- | :--- | :--- |
| `Steve` | `1234` | `e199b16b-7efd-4584-a964-04038430f6cf` |
| `steve` | `1234` | `e199b16b-7efd-4584-a964-04038430f6cf` (case-insensitive match) |
| `Steve` | `5678` | `dbb6aacc-f85b-478e-8219-147c5d195790` (different PIN -> different UUID) |
| `Alex` | `1234` | `4faf5a1e-ab98-473c-81c9-e452cf027e50` (different user -> different UUID) |
| `Player` | `0000` | `8be464a4-566b-4e14-8742-1c25cf62dd87` |

---

## 4. Neon Relay & Upstream Host Routing

### Allowlisted Upstream Hosts
The relay will strictly proxy requests only to these approved upstream services:

| Relay Subpath | Upstream Host | Description |
| :--- | :--- | :--- |
| `/api/*` | `api.modrinth.com` | Modrinth API (projects, search, versions, auth) |
| `/cdn/*` | `cdn.modrinth.com` | Modrinth CDN (mod jars, resource packs, files) |
| `/launcher-meta/*` | `launcher-meta.modrinth.com` | Modrinth Launcher metadata |
| `/piston-meta/*` | `piston-meta.mojang.com` | Mojang version manifests & index metadata |
| `/piston-data/*` | `piston-data.mojang.com` | Mojang client/server jars and game data |
| `/minecraft-resources/*` | `resources.download.minecraft.net` | Minecraft game assets (sounds, textures, objects) |
| `/minecraft-libraries/*` | `libraries.minecraft.net` | Mojang Java libraries and dependencies |
| `/minecraft-services/*` | `api.minecraftservices.com` | Profile, entitlement, and skin services |
| `/mojang-session/*` | `sessionserver.mojang.com` | Session join & verification endpoints |
| `/minecraft-textures/*` | `textures.minecraft.net` | Player skins and capes textures |
| `/mojang-meta/*` | `launchermeta.mojang.com` | Legacy Mojang launcher metadata |
| `/mojang-launcher/*` | `launcher.mojang.com` | Legacy Mojang launcher assets |

Additional fixed routes cover Modrinth website assets, launcher files, Archon, shared instances, staged services, Azul Java metadata/downloads, Paper, Purpur, mclogs, flags, and GitHub avatars. `src/relay/routing.ts` is the authoritative allowlist. `/nodes/<hostname>/...` accepts bounded subdomains of `nodes.modrinth.com`; WebSocket connections resolve and pin public IP addresses while preserving TLS hostname verification.

Unknown routes return a structured error. Native and frontend URL resolvers reject unsupported destinations, embedded credentials, unexpected ports, and lookalike hosts before making a request.

`POST /server/resolve` resolves public Minecraft server addresses and SRV records. `POST /server/status` performs bounded modern or legacy status requests from Relay. The launcher never resolves or connects directly to a remote game server for these status checks. Private, loopback, reserved, and mapped addresses are blocked; TCP connections use validated literal IPs.

Supported WebSocket upgrades use the official `@neon/functions` SDK and return its upgrade response unchanged. The bridge preserves text/binary frames and negotiated subprotocols, strips Relay credentials before forwarding upstream, confines destinations, and bounds queued data and handshake time.

### Selective URL Rewriting in Responses
When proxying JSON responses from allowlisted services (such as version manifests or Modrinth project versions), the relay parses JSON payloads and rewrites any embedded allowlisted URLs to point back through the relay:
- Embedded `https://cdn.modrinth.com/...` -> `https://<relay-host>/cdn/...`
- Embedded `https://resources.download.minecraft.net/...` -> `https://<relay-host>/minecraft-resources/...`
- Embedded `https://libraries.minecraft.net/...` -> `https://<relay-host>/minecraft-libraries/...`
- Binary artifacts and integrity-sensitive manifests retain their original bytes. The launcher routes their nested download URLs when it makes each request, preserving upstream hashes.
- External URLs remain available as foreground browser links. Unsupported embedded media does not trigger direct requests in the desktop app.

---

## 5. Neon Deployment & Operations Guide

### Target Neon Project
- **Project Name / ID**: `morning-bird-71929748`
- **Branch**: `production`

### Prerequisites
- Node.js 24 for the deployed runtime, and a current authenticated Neon CLI or connector.
- Verify the configured project, production branch ID, and existing `relay` / `updates` slugs before deploying. Do not create replacement functions or branches to work around an authorization failure.
- Install workspace dependencies using the committed lockfile. Official `@neon/config` / `@neon/functions` packages supply the deployment and WebSocket APIs; no local substitute type declaration is used.

### Deploying Functions
Run from `modbridge-functions/` after linking the intended existing production branch:

```bash
cd modbridge-functions

# Inspect changes before applying the full neon.ts configuration
neon config plan
neon deploy

# Alternatively, deploy only one existing function without applying other config
neon functions deploy relay --src src/relay/index.ts
neon functions deploy updates --src src/updates/index.ts

# Read the deployed invocation URL
neon functions get relay
neon functions get updates
```

### Environment Variables
Configure the following environment variables on the Neon project or via the Neon Console:

| Variable | Scope | Description |
| :--- | :--- | :--- |
| `MODBRIDGE_RELAY_SECRET` | Relay Function | Optional shared secret token. If set, clients supply `X-Modbridge-Token` or `?relay_token=...`; legacy bearer/query authentication remains supported. Upstream user authorization and `token` queries are preserved. If omitted, existing open access remains supported. The standalone Updates function retains public release access. |
| `MODBRIDGE_GITHUB_TOKEN` | Updates Function | Optional GitHub personal access token to prevent GitHub API rate limiting (60 req/hr unauthenticated vs 5000 req/hr authenticated). |
| Canonical release repository | Updates Function | Fixed to `ethantphillips/ModBridge`; unrelated release assets are rejected. |

Single-function deployments that omit environment settings preserve existing secrets. Do not upload empty environment values to compensate for missing credentials. If applying declared Function environment keys, pass the reviewed local environment file to `neon deploy --env <file>`.

The Relay also serves `/updates/latest`, `/updates.json`, and `/updates/download/...`. The standalone Updates function keeps `/latest`, `/updates.json`, and `/download/...` compatible. Native updates validate manifests, downloads, and redirect destinations against the two approved origins, and retain Tauri signature verification. Published artifacts must be signed by the key matching `apps/app/tauri-release.conf.json`.

Desktop update checks retry after transient failures, release unused native resources, retain active downloads during polling, and ignore stale size responses. Linux release checks obtain platform information directly from native IPC so the initial check does not depend on frontend startup timing.

### Client Configuration
To configure the Modbridge desktop launcher to route through the deployed Neon Relay:

Set the following environment variables (or include in `.env`):
```bash
MODBRIDGE_RELAY_BASE_URL=https://<your-relay-function-url>
MODBRIDGE_RELAY_AUTH_TOKEN=<your-secret-if-configured>
MODBRIDGE_UPDATE_BASE_URL=https://<your-updates-function-url>
```

The default approved hosts are:

- `br-divine-snow-ahjav8i1-relay.compute.c-3.us-east-1.aws.neon.tech`
- `br-divine-snow-ahjav8i1-updates.compute.c-3.us-east-1.aws.neon.tech`

Custom Relay origins require matching native CSP and HTTP capability configuration at build time. `MODBRIDGE_UPDATE_BASE_URL` must select an approved service base; use `<relay>/updates` for the combined Relay handler. Linux and Windows webviews honor supported inherited proxy settings, and native sockets use HTTP CONNECT through the inherited proxy while retaining TLS verification.

---

## 6. Upstream Synchronization & Merge Strategy

To pull updates from the upstream Modrinth repository without breaking Modbridge:

1. **Maintain Remotes**:
   ```bash
   git remote add upstream https://github.com/modrinth/theseus.git
   git fetch upstream
   ```
2. **Merge Strategy**:
   - Merge or cherry-pick upstream commits onto a feature branch first:
     ```bash
     git checkout -b sync-upstream
     git merge upstream/main
     ```
3. **Conflict Resolution Guidelines**:
   - `packages/app-lib/src/util/fetch.rs`: Ensure `route_url_through_relay` and `X-Modbridge-Token` header logic remain in `fetch_advanced_with_target`.
   - `packages/app-lib/src/state/minecraft_auth.rs`: Ensure `is_offline()` guards in `maybe_online_profile` and `login_refresh` are preserved.
   - `packages/app-lib/src/api/instance/run.rs`: Ensure `server_play_project_id` join logic retains `!credentials.is_offline()`.
   - `apps/app-frontend/src/components/ui/AccountsCard.vue`: Preserve offline identity inputs and `isAccountOffline()` badge rendering.
   - `apps/app/tauri.conf.json`: Preserve `productName: "Modbridge"`, window title, and Neon CSP `connect-src` domains.
4. **Verification after Merge**:
   - Run functions unit test suite: `pnpm --filter modbridge-functions test`
   - Test offline account creation with locked test vectors.

## 7. Restricted Validation (2026-10-08)

The Linux test environment uses `scripts/relay-only.py` to create a user/network namespace with only loopback. Its proxy bridge accepts only CONNECT requests to the two approved service hosts on port 443 and forwards them through the inherited platform proxy. Package-manager presets on the outer environment cannot be reached by test processes. Direct IPv4/IPv6 sockets, package registries, GitHub, upstream Modrinth/Mojang hosts, and hostname lookalikes were explicitly rejected.

The final service/frontend suite passes **206 tests**, including **79 frontend transport, DOM, checkout, download, and updater checks**. Backend TypeScript validation, the API-client declaration build, and the app production frontend build pass. The Rust library's full **59-test** suite and **12 native GUI tests** pass with external networking disabled. Native GUI tests cover confined updater URLs, proxy handling, streamed downloads, atomic saves, cancellation, and filename sanitation. Both default and updater-enabled Linux native builds pass. WebSocket and server-status fixtures use actual loopback connections where protocol behavior matters.

Native Linux runtime checks use `scripts/desktop-smoke.py`, isolated app data, Xvfb, and the WebKit inspector. `scripts/launcher-fixture.py` builds a small Java client and seeds cached metadata/artifacts so native install, launch arguments, RPC properties, stdout/stderr, process tracking/stop, and instance CRUD can run without downloads. The fixture verifies a saved offline identity, token `0`, and `legacy` user type; it does not simulate remote Minecraft gameplay. Offline token `0` is excluded from token censoring so ordinary zero digits in game logs remain intact.

The desktop smoke also covers account/default handling, PIN redaction, bundled and custom skin storage, settings, library groups, UI routes/modals, first-profile creation, browser checkout handoff, and disabled background third-party webviews. The final native executable embeds the verified frontend entry `index-Dqyw66Lr.js`; rendered onboarding and skin labels correctly describe offline profile creation and local previews. Skin save/preview remains available locally; vanilla offline profiles cannot apply authenticated Mojang skin/cape changes. Hosted world/backup downloads stream through a native Relay client into an atomically saved file, and ordinary file/log exports use a native save dialog.

Examples, after preparing the required local toolchain and Linux GUI dependencies:

```bash
python3 scripts/relay-only.py -- pnpm --filter modbridge-functions test
python3 scripts/relay-only.py -- cargo test --offline -p theseus --lib
python3 scripts/relay-only.py -- dbus-run-session -- python3 scripts/desktop-smoke.py --launcher-fixture --probe-relay
```

Deployment archives are generated at `modbridge-functions/dist/relay.zip` and `modbridge-functions/dist/updates.zip`, each containing a standalone root `index.mjs` for Node.js 24. Both were imported and exercised independently with external networking disabled; Relay's bundled handler also passed actual legacy TCP protocol fixtures.

Live verification remains blocked: the environment's enforced policy reports no custom allowed hosts, and the platform proxy rejects CONNECT to both approved service hosts with 403. The native smoke confirms WebKit fetch, images, and WebSockets use the confined proxy; the corresponding live requests fail at the platform boundary. Missing loader/game version metadata errors remain visible in this disconnected runtime. The Neon connector also returns an internal authorization error for the documented project, preventing branch/function verification or deployment. These are environment/access failures, not successful service responses. No live deployment, signed release installation, production hosting session, real remote game download, or Windows runtime was verified. Windows virtualization is unavailable in this environment; Linux was used as the requested substitute.
