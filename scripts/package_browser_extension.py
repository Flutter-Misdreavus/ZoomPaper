#!/usr/bin/env python3
"""Prepare a stable Chrome-loadable directory; optionally ZIP it for Releases."""

import argparse
import json
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "browser-extension"
PREFIX = "ZoomPaper-Connector"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", action="store_true", help="Also create a ZIP for GitHub Releases")
    args = parser.parse_args()
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    directory = ROOT / PREFIX
    directory.mkdir(exist_ok=True)
    files = []
    for path in sorted(SOURCE.rglob("*")):
        relative = path.relative_to(SOURCE)
        if path.is_dir() or any(part.startswith(".") for part in relative.parts) or path.suffix == ".md":
            continue
        target = directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        files.append(relative)
    # Remove obsolete packaged files without changing the directory Chrome loads.
    for path in directory.rglob("*"):
        if path.is_file() and path.relative_to(directory) not in files:
            path.unlink()
    print(directory)
    if args.zip:
        output = ROOT / f"{PREFIX}_{manifest['version']}.zip"
        with ZipFile(output, "w", ZIP_DEFLATED) as archive:
            for relative in files:
                archive.write(directory / relative, Path(PREFIX) / relative)
        print(output)


if __name__ == "__main__":
    main()
