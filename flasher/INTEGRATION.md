# Web flasher integration

## Status

Integrated in `index.html` (derived from `original.html` reference UI).

| Piece | Source |
|-------|--------|
| UI | `flasher/index.html` — Waveshare-only, two steps (firmware → flash) |
| Firmware binaries | `ben-wes/espd-kits` GitHub Releases (CI on tags) |
| Board metadata | `manifests/releases.json` (copied to `flasher/manifests/` on deploy) |
| Deploy | `.github/workflows/pages.yml` → GitHub Pages |

## Manifest contract

`scripts/generate-manifest.py` emits board entries with optional `files` URLs (flat release asset names):

```json
{
  "version": "v0.1.0",
  "boards": [
    {
      "id": "waveshare_s3",
      "name": "Waveshare ESP32-S3-AUDIO",
      "target": "esp32s3",
      "files": {
        "bootloader": { "url": "…/bootloader.bin", "offset": 0 },
        "partition_table": { "url": "…/partition-table.bin", "offset": 32768 },
        "app": { "url": "…/espd.bin", "offset": 65536 }
      }
    }
  ]
}
```

The flasher lists releases via the GitHub API and downloads `bootloader.bin`, `partition-table.bin`, and `espd.bin` from each tag unless the manifest provides explicit URLs.

## Reference

Original multi-board UI: [flasher.michaelkramer.at](https://flasher.michaelkramer.at/) — kept as `original.html` for comparison.
