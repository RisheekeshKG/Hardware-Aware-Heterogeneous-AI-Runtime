"""Package a PyInstaller runtime folder as a release asset.

GitHub rejects release assets larger than 2 GiB, so archives above
--part-size are split into numbered parts (<name>.001, <name>.002, ...).
The desktop app downloads every part and joins them before extracting.
"""

import argparse
import zipfile
from pathlib import Path

DEFAULT_PART_SIZE = 1900 * 1024 * 1024


def build_zip(source: Path, archive: Path) -> None:
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zip_file:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                zip_file.write(path, Path(source.name) / path.relative_to(source))


def split(archive: Path, part_size: int) -> list[Path]:
    parts = []
    with archive.open("rb") as handle:
        while chunk := handle.read(part_size):
            part = archive.with_name(f"{archive.name}.{len(parts) + 1:03d}")
            part.write_bytes(chunk)
            parts.append(part)
    archive.unlink()
    return parts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="runtime folder, e.g. dist/har-runtime-server")
    parser.add_argument("archive", type=Path, help="output zip path")
    parser.add_argument("--part-size", type=int, default=DEFAULT_PART_SIZE)
    args = parser.parse_args()

    if not args.source.is_dir():
        parser.error(f"{args.source} is not a directory")
    args.archive.parent.mkdir(parents=True, exist_ok=True)
    build_zip(args.source, args.archive)
    size = args.archive.stat().st_size
    print(f"Built {args.archive} ({size / 2**20:.0f} MB)")
    if size > args.part_size:
        for part in split(args.archive, args.part_size):
            print(f"  part {part.name} ({part.stat().st_size / 2**20:.0f} MB)")


if __name__ == "__main__":
    main()
