# Web flasher

Deployed to **GitHub Pages** from this directory (see `.github/workflows/pages.yml`).

- **UI:** `index.html` — Web Serial flasher for the Waveshare ESP32-S3-AUDIO kit
- **Firmware:** GitHub Releases from [ben-wes/espd-kits](https://github.com/ben-wes/espd-kits/releases), built by CI
- **Manifest:** `manifests/releases.json` (board metadata; copied here on deploy)

Based on the [ESPD Web Flasher](https://flasher.michaelkramer.at/) reference UI (`original.html`).

## Local preview

```bash
mkdir -p flasher/manifests && cp manifests/releases.json flasher/manifests/
python3 -m http.server 8080 --directory flasher
# open http://localhost:8080/
```
