# Web flasher integration

## Status

Multi-board ready UI in `index.html` + `app.js`.

| Piece | Source |
|-------|--------|
| Board catalog | `manifests/boards.json` — from `boards/index.yaml` + `boards/<id>.yaml` |
| Release manifest | `manifest.json` on each GitHub Release tag |
| Firmware binaries | `{board_id}-bootloader.bin`, `{board_id}-espd.bin`, … per release |
| Deploy | `.github/workflows/pages.yml` → GitHub Pages |

## Manifest files

**`manifests/boards.json`** (static catalog, copied to Pages):

```json
{
  "boards": [
    {
      "id": "waveshare_s3",
      "name": "Waveshare ESP32-S3-AUDIO",
      "target": "esp32s3",
      "chip": "ESP32-S3",
      "description": "Waveshare AI Smart Speaker / ESP32-S3-AUDIO Board"
    }
  ]
}
```

Board card `description` comes from the first line of `help` in `boards/<id>.yaml` (text before ` (` is dropped). Optional board photo:

```yaml
flasher:
  image: "assets/boards/waveshare_s3.jpg"
```

**`manifest.json`** (attached to each release tag):

```json
{
  "version": "v0.1.0",
  "boards": [
    {
      "id": "waveshare_s3",
      "name": "…",
      "target": "esp32s3",
      "chip": "ESP32-S3",
      "description": "…",
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

## Adding a board

1. Add `boards/<id>.yaml` and `config/boards/<id>.select`
2. List it in `boards/index.yaml`
3. Add `<id>` to the CI matrix in `.github/workflows/build.yml`
4. Regenerate `manifests/boards.json`
