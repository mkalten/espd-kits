#!/usr/bin/env bash
# Build ESPD firmware for one kit board id (see boards/*.yaml).
set -euo pipefail

BOARD_ID="${1:-}"
if [[ -z "${BOARD_ID}" ]]; then
  echo "usage: $0 <board_id>   e.g. waveshare_s3" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ESPD="${ROOT}/espd"
YAML="${ROOT}/boards/${BOARD_ID}.yaml"
DIST="${ROOT}/dist/${BOARD_ID}"

if [[ ! -f "${YAML}" ]]; then
  echo "missing ${YAML}" >&2
  exit 1
fi

if ! command -v idf.py &>/dev/null; then
  echo "idf.py not in PATH — source ESP-IDF export.sh" >&2
  exit 1
fi

TARGET="$(python3 -c "
import yaml
d = yaml.safe_load(open('${YAML}'))
print(d.get('target', ''))
")"
if [[ -z "${TARGET}" ]]; then
  echo "boards/${BOARD_ID}.yaml: missing target:" >&2
  exit 1
fi

"${ROOT}/scripts/prepare_espd.sh"

export ESPD_BOARDS_DIR="${ROOT}/boards"
python3 "${ROOT}/scripts/generate-manifest.py" --select "${BOARD_ID}" \
  > "${ESPD}/sdkconfig.defaults.local"

"${ROOT}/scripts/prepare-board-build.sh"

cd "${ESPD}"
idf.py set-target "${TARGET}"
idf.py build

mkdir -p "${DIST}"
cp -f build/espd.bin \
      build/bootloader/bootloader.bin \
      build/partition_table/partition-table.bin \
      build/flash_args \
      "${DIST}/"

echo "build-board: ${BOARD_ID} → ${DIST}/"
