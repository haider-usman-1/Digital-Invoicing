#!/usr/bin/env python3
"""
Regenerates assets/icon.ico from src/ui/favicon.svg.

    python3 scripts/make-icon.py

Run it only when the artwork changes. It depends on macOS's qlmanage for rasterising and on Pillow,
neither of which belongs in the app's dependency list.

One source for every size. An earlier mark needed a separate, thickened variant for 16px and 24px
because it was drawn with thin strokes; the current one is fill-only and sized to the safe area, so
it survives the reduction on its own. If a future icon needs a small-size variant, that is a sign to
redraw it rather than to add one.

Windows chooses whichever size fits the context — 16px in Explorer's details view, 256px for the
large tile — so they all live in the one file.
"""

import pathlib, struct, subprocess, sys, tempfile
from io import BytesIO

SIZES = [16, 24, 32, 48, 64, 128, 256]
ROOT = pathlib.Path(__file__).resolve().parent.parent
ARTWORK = ROOT / "src/ui/favicon.svg"
ICO = ROOT / "assets/icon.ico"

try:
    from PIL import Image
except ImportError:
    sys.exit("Needs Pillow:  python3 -m pip install Pillow")


def rasterise(svg: pathlib.Path) -> "Image.Image":
    """Renders well above the largest target so every downsample stays crisp."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["qlmanage", "-t", "-s", "1024", "-o", tmp, str(svg)],
            check=True, capture_output=True,
        )
        rendered = next(pathlib.Path(tmp).glob("*.png"), None)
        if rendered is None:
            sys.exit(f"qlmanage produced no PNG for {svg.name} — is this macOS?")
        return Image.open(rendered).convert("RGBA").copy()


def build_ico(master: "Image.Image") -> bytes:
    """
    Assembles a PNG-compressed .ico.

    Written by hand rather than via Pillow's ICO writer so the directory entries are explicit and
    verifiable. PNG-in-ICO is supported from Windows Vista onward.
    """
    payloads = []
    for size in SIZES:
        buffer = BytesIO()
        master.resize((size, size), Image.LANCZOS).save(buffer, format="PNG")
        payloads.append((size, buffer.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(payloads))  # reserved, type=icon, count
    offset = len(header) + 16 * len(payloads)
    entries, blobs = b"", b""

    for size, png in payloads:
        # 0 means 256 in the directory entry's single byte.
        dimension = 0 if size == 256 else size
        entries += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(png), offset)
        blobs += png
        offset += len(png)

    return header + entries + blobs


ICO.parent.mkdir(parents=True, exist_ok=True)
ICO.write_bytes(build_ico(rasterise(ARTWORK)))
print(f"wrote {ICO.relative_to(ROOT)} ({ICO.stat().st_size:,} bytes) at sizes {SIZES}")
