#!/usr/bin/env bash
# Sync board YAMLs into espd submodule and apply Pd patches.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ESPD="${ROOT}/espd"
BOARDS_SRC="${ROOT}/boards"

if [[ ! -d "${ESPD}/.git" && ! -f "${ESPD}/.git" ]]; then
  echo "espd submodule missing — run: git submodule update --init --recursive" >&2
  exit 1
fi

shopt -s nullglob
yaml_files=("${BOARDS_SRC}"/*.yaml)
if [[ ${#yaml_files[@]} -eq 0 ]]; then
  echo "no boards/*.yaml in ${BOARDS_SRC}" >&2
  exit 1
fi

mkdir -p "${ESPD}/boards"
for f in "${yaml_files[@]}"; do
  base="$(basename "$f")"
  [[ "$base" == "index.yaml" ]] && continue
  cp -f "$f" "${ESPD}/boards/${base}"
done

"${ESPD}/scripts/apply-pd-patches.sh"
echo "prepare_espd: boards synced, Pd patches applied"
