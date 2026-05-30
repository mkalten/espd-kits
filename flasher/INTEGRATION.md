# Web flasher integration

## Status

Multi-board ready UI in `index.html` + `app.js`.

| Piece | Source |
|-------|--------|
| Release list | GitHub Releases API |
| Board picker + firmware files | `manifests/releases/{tag}.json` + `firmware/{tag}/` on Pages (mirrored from GitHub Releases; browser cannot fetch release assets cross-origin) |
| Firmware binaries | `{board_id}-bootloader.bin`, `{board_id}-espd.bin`, … per release |
| Deploy | `.github/workflows/pages.yml` → GitHub Pages |

## Manifest files

**`manifests/boards.json`** — generated catalog from board YAML (used by CI/docs; the flasher does not load it).

**`manifest.json`** (attached to each release tag — drives the UI):

Board metadata in `manifest.json` is generated from `boards/<id>.yaml` (`help` → description). Optional board photo in YAML:

```yaml
flasher:
  image: "assets/boards/waveshare_s3.jpg"
```

Example release manifest:

```json
{
  "version": "v0.1.0",
  "boards": [
    {
      "id": "waveshare_s3",
      "name": "Waveshare ESP32-S3-AUDIO",
      "target": "esp32s3",
      "chip": "ESP32-S3",
      "description": "Waveshare AI Smart Speaker / ESP32-S3-AUDIO Board",
      "files": {
        "bootloader": { "url": "…/waveshare_s3-bootloader.bin", "offset": 0 },
        "partition_table": { "url": "…/waveshare_s3-partition-table.bin", "offset": 32768 },
        "app": { "url": "…/waveshare_s3-espd.bin", "offset": 65536 }
      }
    }
  ]
}
```

Generate locally:

```bash
python3 scripts/generate-manifest.py --catalog
python3 scripts/generate-manifest.py --version v0.1.0 \
  --base-url "https://github.com/ben-wes/espd-kits/releases/download/v0.1.0" \
  -o /tmp/manifest.json
```

## Patch sync (browser)

`sync.js` implements the same CDC protocol as [`espd/scripts/espd_sync.py`](../espd/scripts/espd_sync.py):

- `STATUS`, `PUT`, `RELOAD`, `RESET`, `MODE MSC_SYNC` / `MODE NORMAL`
- Prepares SD (`/sdcard`) or internal flash (`/storage` via **msc_sync** reboot)
- After reboot, reconnects via `navigator.serial.getPorts()` (port must stay authorized)

**Browser limits:**

- Folder pick: `showDirectoryPicker()` (Chrome / Edge)
- Auto-watch: `FileSystemObserver` when available; otherwise **Sync now**
- If reconnect after reboot fails, user must pick the USB port again

See [espd/docs/DEV_SYNC.md](../espd/docs/DEV_SYNC.md) for protocol and storage rules.

## Adding a board

1. Add `boards/<id>.yaml` and `config/boards/<id>.select`
2. List it in `boards/index.yaml`
3. Add `<id>` to the CI matrix in `.github/workflows/build.yml`
4. Regenerate `manifests/boards.json`
