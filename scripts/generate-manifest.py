#!/usr/bin/env python3
"""Generate manifests/releases.json for the web flasher from boards/index.yaml."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore


def load_boards(index_path: Path) -> list[dict]:
    if yaml is None:
        raise SystemExit("PyYAML required: pip install pyyaml")
    data = yaml.safe_load(index_path.read_text(encoding="utf-8"))
    return list(data.get("boards") or [])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="dev", help="release tag, e.g. v0.1.0")
    ap.add_argument(
        "--base-url",
        default="",
        help="URL prefix for assets, e.g. https://github.com/ben-wes/espd-kits/releases/download/v0.1.0",
    )
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()

    root = args.root
    index_path = root / "boards" / "index.yaml"
    boards = load_boards(index_path)
    base = args.base_url.rstrip("/")

    out_boards = []
    for b in boards:
        bid = b["id"]
        entry = {
            "id": bid,
            "name": b.get("name", bid),
            "target": b["target"],
        }
        if base:
            # Release assets are uploaded at the tag root (see .github/workflows/build.yml).
            entry["files"] = {
                "bootloader": {"url": f"{base}/bootloader.bin", "offset": 0},
                "partition_table": {
                    "url": f"{base}/partition-table.bin",
                    "offset": 32768,
                },
                "app": {"url": f"{base}/espd.bin", "offset": 65536},
            }
        out_boards.append(entry)

    manifest = {"version": args.version, "boards": out_boards}
    out_path = args.output or (root / "manifests" / "releases.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
