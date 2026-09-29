#!/usr/bin/env python3
"""Create a clean, versioned Connector ZIP with a stable directory name."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "browser-extension"
PREFIX = "ZoomPaper-Plus-Connector"


def main() -> None:
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    output = ROOT / f"{PREFIX}_{manifest['version']}.zip"
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for path in sorted(SOURCE.rglob("*")):
            relative = path.relative_to(SOURCE)
            if path.is_dir() or any(part.startswith(".") for part in relative.parts):
                continue
            archive.write(path, Path(PREFIX) / relative)
    print(output)


if __name__ == "__main__":
    main()
