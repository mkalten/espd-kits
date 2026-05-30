# Web flasher

Static site deployed to **GitHub Pages** from this directory.

- Loads **`../manifests/releases.json`** (copied into `flasher/manifests/` on release by CI, or served from repo root on Pages with base path adjustment).
- Reference implementation: [ESPD Web Flasher](https://flasher.michaelkramer.at/) (Web Serial + esptool-js pattern).

## Local preview

```bash
python3 -m http.server 8080 --directory flasher
# open http://localhost:8080/ — manifest fetch may need copying manifests/ into flasher/
```
