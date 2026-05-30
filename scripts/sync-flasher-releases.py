#!/usr/bin/env python3
"""Mirror stable GitHub release assets into flasher/ for same-origin browser fetch."""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = "ben-wes/espd-kits"
UA = "espd-kits-flasher-sync"


def api_json(url: str, token: str | None = None) -> object:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def download(url: str, dest: Path, token: str | None = None) -> None:
    headers = {"User-Agent": UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=300) as resp:
        dest.write_bytes(resp.read())


def board_ids_from_assets(asset_names: list[str]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for name in asset_names:
        m = re.match(r"^(.+)-espd\.bin$", name)
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            ids.append(m.group(1))
    return ids


def rewrite_manifest_urls(manifest: dict, tag: str, firmware_dir: Path, token: str | None) -> None:
    for board in manifest.get("boards") or []:
        files = board.get("files") or {}
        for spec in files.values():
            url = spec.get("url") or ""
            filename = url.rsplit("/", 1)[-1]
            if not filename:
                continue
            dest = firmware_dir / tag / filename
            if not dest.exists():
                print(f"  download {filename}")
                download(url, dest, token)
            spec["url"] = f"firmware/{tag}/{filename}"


def sync_flasher_releases(root: Path, token: str | None = None) -> int:
    flasher = root / "flasher"
    manifests_dir = flasher / "manifests" / "releases"
    firmware_dir = flasher / "firmware"
    manifests_dir.mkdir(parents=True, exist_ok=True)
    firmware_dir.mkdir(parents=True, exist_ok=True)

    releases = api_json(f"https://api.github.com/repos/{REPO}/releases?per_page=30", token)
    if not isinstance(releases, list):
        print("unexpected GitHub API response", file=sys.stderr)
        return 1

    stable = [r for r in releases if not r.get("draft") and not r.get("prerelease")]
    if not stable:
        print("no stable releases to mirror")
        return 0

    synced = 0
    for release in stable:
        tag = release["tag_name"]
        assets = release.get("assets") or []
        names = [a["name"] for a in assets]
        manifest_asset = next((a for a in assets if a["name"] == "manifest.json"), None)

        out_manifest = manifests_dir / f"{tag}.json"
        tag_firmware = firmware_dir / tag

        if manifest_asset:
            print(f"sync {tag} (manifest.json on release)")
            manifest_path = tag_firmware / "manifest.json.tmp"
            tag_firmware.mkdir(parents=True, exist_ok=True)
            download(manifest_asset["browser_download_url"], manifest_path, token)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest_path.unlink(missing_ok=True)
        else:
            print(f"sync {tag} (built from release assets)")
            board_ids = board_ids_from_assets(names)
            if not board_ids:
                print(f"  skip: no *-espd.bin assets")
                continue
            manifest = {
                "version": tag,
                "boards": [
                    {
                        "id": bid,
                        "name": bid,
                        "files": {
                            "bootloader": {
                                "url": f"https://github.com/{REPO}/releases/download/{tag}/{bid}-bootloader.bin",
                                "offset": 0,
                            },
                            "partition_table": {
                                "url": f"https://github.com/{REPO}/releases/download/{tag}/{bid}-partition-table.bin",
                                "offset": 32768,
                            },
                            "app": {
                                "url": f"https://github.com/{REPO}/releases/download/{tag}/{bid}-espd.bin",
                                "offset": 65536,
                            },
                        },
                    }
                    for bid in board_ids
                ],
            }

        rewrite_manifest_urls(manifest, tag, firmware_dir, token)
        out_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        synced += 1

    print(f"mirrored {synced} release(s) into {flasher.relative_to(root)}/")
    return 0


def main() -> int:
    import os

    root = Path(__file__).resolve().parents[1]
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    try:
        return sync_flasher_releases(root, token)
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}: {exc.reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
