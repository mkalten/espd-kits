#!/usr/bin/env python3
"""Generate flasher manifests from boards/index.yaml and boards/*.yaml."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore


def load_board_index(index_path: Path) -> list[dict]:
    if yaml is None:
        raise SystemExit("PyYAML required: pip install pyyaml")
    data = yaml.safe_load(index_path.read_text(encoding="utf-8"))
    return list(data.get("boards") or [])


def load_board_yaml(root: Path, board_id: str) -> dict:
    path = root / "boards" / f"{board_id}.yaml"
    if not path.exists() or yaml is None:
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def chip_label(target: str) -> str:
    if target.startswith("esp32s3"):
        return "ESP32-S3"
    if target.startswith("esp32c3"):
        return "ESP32-C3"
    if target.startswith("esp32c6"):
        return "ESP32-C6"
    if target.startswith("esp32p4"):
        return "ESP32-P4"
    if target == "esp32":
        return "ESP32"
    return target.upper()


def board_description(root: Path, board_id: str) -> str:
    data = load_board_yaml(root, board_id)
    help_text = data.get("help") or ""
    if isinstance(help_text, str):
        line = help_text.strip().split("\n")[0].strip()
        if " (" in line:
            line = line.split(" (")[0].strip()
        return line
    return ""


def catalog_entry(root: Path, index_row: dict) -> dict:
    bid = index_row["id"]
    yaml_data = load_board_yaml(root, bid)
    name = index_row.get("name") or yaml_data.get("name") or bid
    target = index_row.get("target") or yaml_data.get("target") or ""
    entry = {
        "id": bid,
        "name": name,
        "target": target,
        "chip": chip_label(target),
        "description": board_description(root, bid),
    }
    flasher = yaml_data.get("flasher") or {}
    if isinstance(flasher, dict) and flasher.get("image"):
        entry["image"] = flasher["image"]
    return entry


def release_files(base: str, board_id: str) -> dict:
    prefix = base.rstrip("/")
    return {
        "bootloader": {"url": f"{prefix}/{board_id}-bootloader.bin", "offset": 0},
        "partition_table": {
            "url": f"{prefix}/{board_id}-partition-table.bin",
            "offset": 32768,
        },
        "app": {"url": f"{prefix}/{board_id}-espd.bin", "offset": 65536},
    }


def write_catalog(root: Path, out_path: Path) -> None:
    boards = load_board_index(root / "boards" / "index.yaml")
    payload = {"boards": [catalog_entry(root, b) for b in boards]}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path}")


def write_release_manifest(
    root: Path, out_path: Path, version: str, base_url: str
) -> None:
    boards = load_board_index(root / "boards" / "index.yaml")
    base = base_url.rstrip("/")
    out_boards = []
    for b in boards:
        bid = b["id"]
        entry = catalog_entry(root, b)
        if base:
            entry["files"] = release_files(base, bid)
        out_boards.append(entry)
    manifest = {"version": version, "boards": out_boards}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out_path}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", action="store_true", help="write boards catalog only")
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
    if args.catalog:
        out_path = args.output or (root / "manifests" / "boards.json")
        write_catalog(root, out_path)
        return 0

    out_path = args.output or (root / "manifests" / "releases.json")
    write_release_manifest(root, out_path, args.version, args.base_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
