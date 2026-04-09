from pathlib import Path
import zipfile


def build_archive() -> None:
    root = Path(__file__).resolve().parents[1]
    source_dir = root / "plugins" / "chrome"
    archive_path = root / "hash-hedge-chrome.zip"

    if not source_dir.exists():
        raise FileNotFoundError(f"Source directory not found: {source_dir}")

    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in source_dir.rglob("*"):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(source_dir).as_posix())

    print(f"Archive updated: {archive_path}")


if __name__ == "__main__":
    build_archive()