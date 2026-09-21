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
3. **Controlled Upstream Connectivity**: The launcher does not directly contact Modrinth or Mojang infrastructure when configured with the Modbridge Relay. All traffic flows through the relay, which forwards requests, filters headers, and rewrites URLs in upstream payloads.
4. **Zero-Buffering Streams**: All large payloads (game jars, modpack assets, version files, release binaries) are streamed end-to-end with HTTP 206 `Range` header support.
5. **Strict Allowlisting**: The relay rejects any upstream target outside the approved allowlist, preventing open-proxy misuse.
6. **Isolated Release Channel**: The self-updater points strictly to `https://github.com/ethantphillips/ModBridge`.

---

## 2. File Divergence Record

The following table details every file added or modified in the repository, its upstream role, and the rationale for the Modbridge adaptation:

| File Path | Status | Upstream Role | Modbridge Adaptation & Rationale |
| :--- | :--- | :--- | :--- |
| `modbridge-functions/neon.ts` | **NEW** | N/A | Defines `relay` and `updates` serverless functions for Neon deployment. |
| `modbridge-functions/package.json` | **NEW** | N/A | Workspace package configuration and dependencies for Neon functions. |
| `modbridge-functions/src/relay/` | **NEW** | N/A | Streaming reverse proxy, host allowlist routing, selective JSON URL rewriting, and token authentication. |
| `modbridge-functions/src/updates/` | **NEW** | N/A | GitHub release manifest generator and asset streaming proxy locked to `ethantphillips/ModBridge`. |
| `modbridge-functions/tests/` | **NEW** | N/A | Comprehensive Vitest suite (38 tests) covering routing, rewrite, UUID derivation, auth, and updates. |
| `packages/app-lib/src/state/offline_identity.rs` | **NEW** | N/A | Local deterministic UUID generation via SHA-256 algorithm with locked test vectors. |
| `packages/app-lib/src/util/relay.rs` | **NEW** | N/A | Client-side URL rewrite helper and `relay_request` wrapper directing requests to `MODBRIDGE_RELAY_BASE_URL`. |
| `packages/app-lib/src/state/minecraft_auth.rs` | **MODIFIED** | Microsoft OAuth & Mojang session state | Added `Credentials::is_offline()` and `Credentials::create_offline_user()`; bypassed online Mojang calls for offline profiles; routed Mojang services through relay. |
| `packages/app-lib/src/api/minecraft_auth.rs` | **MODIFIED** | Minecraft auth API bridge | Added `add_offline_user` command; routed session server reachability check through relay. |
| `packages/app-lib/src/api/instance/run.rs` | **MODIFIED** | Minecraft game launch logic | Skipped Mojang session server join (`/session/minecraft/join`) when launching offline accounts; routed online session join through relay. |
| `packages/app-lib/src/util/fetch.rs` | **MODIFIED** | Central HTTP fetching engine | Intercepted outgoing requests to route allowlisted Modrinth and Mojang URLs through relay and inject relay auth token. |
| `packages/app-lib/build.rs` | **MODIFIED** | Cargo compile-time script | Added default fallbacks for `MODRINTH_*` and `MODBRIDGE_*` environment variables so crates compile without requiring a `.env` file. |
| `apps/app/src/api/auth.rs` | **MODIFIED** | Tauri IPC commands for auth | Registered `add_offline_user` command handler; updated auth window title to "Sign into ModBridge". |
| `apps/app/tauri.conf.json` | **MODIFIED** | Tauri desktop configuration | Updated `productName`, `mainBinaryName`, `identifier`, and window title to "ModBridge"; registered isolated `modbridge://` scheme; updated CSP `connect-src` to permit `*.neon.tech`. |
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

Any request to an unmapped host returns HTTP 403 Forbidden with `{ "error": "Upstream host not allowed", "code": 403 }`.

### Selective URL Rewriting in Responses
When proxying JSON responses from allowlisted services (such as version manifests or Modrinth project versions), the relay parses JSON payloads and rewrites any embedded allowlisted URLs to point back through the relay:
- Embedded `https://cdn.modrinth.com/...` -> `https://<relay-host>/cdn/...`
- Embedded `https://resources.download.minecraft.net/...` -> `https://<relay-host>/minecraft-resources/...`
- Embedded `https://libraries.minecraft.net/...` -> `https://<relay-host>/minecraft-libraries/...`
- External URLs (such as GitHub, Discord, CurseForge, third-party mavens) are preserved without modification.

---

## 5. Neon Deployment & Operations Guide

### Target Neon Project
- **Project Name / ID**: `morning-bird-71929748`
- **Branch**: `production`

### Prerequisites
- Node.js 20+
- `neon` CLI installed globally: `npm install -g neon`
- Authenticated with Neon: `neon auth`

### Deploying Functions
Run from the `modbridge-functions/` directory:

```bash
cd modbridge-functions

# Authenticate if not already logged in
neon auth

# Link to the project
neon link --project-id morning-bird-71929748

# Deploy functions to the production branch
neon deploy --branch production
```

### Environment Variables
Configure the following environment variables on the Neon project or via the Neon Console:

| Variable | Scope | Description |
| :--- | :--- | :--- |
| `MODBRIDGE_RELAY_SECRET` | Relay Function | Optional shared secret token. If set, clients must supply `Authorization: Bearer <secret>`, `X-Modbridge-Token: <secret>`, or `?token=<secret>`. If omitted, open access is allowed. |
| `MODBRIDGE_GITHUB_TOKEN` | Updates Function | Optional GitHub personal access token to prevent GitHub API rate limiting (60 req/hr unauthenticated vs 5000 req/hr authenticated). |
| `MODBRIDGE_CANONICAL_REPO` | Updates Function | Repository slug for release checking (defaults to `ethantphillips/ModBridge`). |

### Client Configuration
To configure the Modbridge desktop launcher to route through the deployed Neon Relay:

Set the following environment variables (or include in `.env`):
```bash
MODBRIDGE_RELAY_BASE_URL=https://<your-relay-function-url>
MODBRIDGE_RELAY_AUTH_TOKEN=<your-secret-if-configured>
MODBRIDGE_UPDATE_BASE_URL=https://<your-updates-function-url>
```

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
