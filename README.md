# ESPD Kits

Curated **board definitions**, **CI-built firmware**, and a **browser flasher** for [ESPD](https://github.com/ben-wes/espd) (Pure Data on ESP32).

Upstream firmware and Pd core live in the **`espd/`** git submodule. This repo owns kit YAMLs, release binaries, and the web UI — so board presets can evolve without bloating the core tree.

## Layout

| Path | Role |
|------|------|
| [`espd/`](espd/) | ESPD firmware submodule (pinned per release tag on this repo) |
| [`boards/`](boards/) | Board plugin YAMLs → copied into `espd/boards/` before build |
| [`config/boards/`](config/boards/) | Per-board `sdkconfig` snippets (Kconfig choice) for non-interactive CI |
| [`presets/`](presets/) | Example `config.txt` / patch bundles per use case (optional) |
| [`flasher/`](flasher/) | Static Web Serial flasher (GitHub Pages) |
| [`manifests/`](manifests/) | Generated `releases.json` for the flasher |
| [`scripts/`](scripts/) | `prepare_espd.sh`, `build-board.sh`, `generate-manifest.py` |

## Quick start (local build)

```bash
git clone --recursive https://github.com/ben-wes/espd-kits.git
cd espd-kits
. $HOME/.espressif/v6.0.1/esp-idf/export.sh   # ESP-IDF v6.0.1

./scripts/build-board.sh waveshare_s3
# artifacts in dist/waveshare_s3/
```

## Submodule policy

- **Development:** `espd` tracks a branch (e.g. `bsp`) or commit on `main`.
- **Releases:** tag `espd-kits` and record the submodule SHA in release notes; CI builds from that SHA.
- Board YAMLs stay **here**; consider upstreaming stable kits to `ben-wes/espd` later if they belong in core docs.

## Web flasher

GitHub Pages serves [`flasher/`](flasher/). It loads [`manifests/releases.json`](manifests/releases.json) (generated on release) and flashes via **Web Serial** (Chrome / Edge desktop), similar to [ESPD Web Flasher](https://flasher.michaelkramer.at/).

Firmware URLs point at **GitHub Release** assets for this repo (or a CDN mirror).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, CI, manifest schema, follow-ups in `espd`
- [boards/README.md](boards/README.md) — YAML schema pointer

## Status

Scaffold / planning repo. CI and Pages workflows are wired; first release after submodule pin and a green build.
