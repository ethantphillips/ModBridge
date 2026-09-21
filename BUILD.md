# Building ModBridge

Instructions for building, running, and releasing the ModBridge launcher.

## 1. Quick Start (Development Mode)

Run the desktop application in development mode with live hot-reloading:

```bash
pnpm install
pnpm app:dev
```

## 2. Local Standalone Build

To compile the standalone production installer on your machine:

```bash
pnpm app:build
```

### Build Artifact Locations
When compilation finishes, Tauri outputs binaries to:
- **Windows (NSIS Installer):** `apps/app/src-tauri/target/release/bundle/nsis/ModBridge_<version>_x64-setup.exe`
- **Linux (AppImage / DEB):** `target/release/bundle/appimage/` and `target/release/bundle/deb/`
- **macOS (DMG):** `target/universal-apple-darwin/release/bundle/dmg/`

## 3. Automated Builds via GitHub Actions

Every push to the `main` branch of `ethantphillips/ModBridge` triggers the **`ModBridge App build`** workflow.

- Builds across **Windows**, **macOS**, and **Linux** using standard GitHub-hosted runners.
- Output installer artifacts are uploaded to the GitHub Actions run summary for immediate download.

### Creating a Release

To publish pre-compiled release binaries to [GitHub Releases](https://github.com/ethantphillips/ModBridge/releases):

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions will build all platform bundles and automatically publish them to the release.
