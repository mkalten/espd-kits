# Web flasher

Deployed to **GitHub Pages** from this directory (see `.github/workflows/pages.yml`).

- **UI:** `index.html` — layout and copy
- **Logic:** `app.js` — firmware list, Web Serial flash flow, monitor
- **Loader:** [esptool-js](https://github.com/espressif/esptool-js) v0.5.4 via [jsDelivr](https://cdn.jsdelivr.net/npm/esptool-js@0.5.4/bundle.js) (not vendored in repo)
- **Firmware:** GitHub Releases from [ben-wes/espd-kits](https://github.com/ben-wes/espd-kits/releases), built by CI
- **Manifest:** `manifests/releases.json` (board metadata; copied here on deploy)

Based on the [ESPD Web Flasher](https://flasher.michaelkramer.at/) reference UI (`original.html`).

## Local preview

```bash
python3 scripts/generate-manifest.py --catalog
python3 scripts/sync-flasher-releases.py   # mirror release bins (same-origin fetch)
python3 -m http.server 8080 --directory flasher
# open http://localhost:8080/
```

## First release

Tag **`v*`** on `main` after pushing the flasher + CI changes. CI builds each board in the matrix, then the `release` job uploads `{board_id}/*.bin` and `manifest.json`.

```bash
git tag v0.1.0
git push origin v0.1.0
```

Watch **Actions → Build kit firmware**. When it finishes, [GitHub Releases](https://github.com/ben-wes/espd-kits/releases) should list `waveshare_s3-espd.bin`, …, and `manifest.json`. The flasher version dropdown fills in after that.
