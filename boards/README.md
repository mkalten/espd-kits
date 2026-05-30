# Board definitions

YAML files here are the **source of truth** for kit builds. CI copies them to `espd/boards/` before `idf.py` configure.

Schema and authoring guide: **[espd/docs/ADDING_A_BOARD.md](../espd/docs/ADDING_A_BOARD.md)** (in submodule).

Each board needs a matching Kconfig snippet in **`config/boards/<id>.select`** for automated builds (see `docs/ARCHITECTURE.md`).
