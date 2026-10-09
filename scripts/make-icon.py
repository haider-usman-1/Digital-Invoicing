#!/usr/bin/env python3
"""
Regenerates assets/icon.ico from the app's SVG artwork.

    python3 scripts/make-icon.py

Run it only when the icon changes. It depends on macOS's qlmanage for rasterising and on Pillow,
neither of which belongs in the app's dependency list.

TWO SOURCES, ON PURPOSE. src/ui/favicon.svg is the real artwork and is used for 32px and up. Its
hexagon is drawn with a 20px stroke on a 512 canvas, which is 0.6px once scaled to 16px — the
outline and the centre dot merge into a dark blob. assets/icon-small.svg is the same mark with the
stroke and dot thickened so it survives that reduction, and is used only for 16px and 24px.
Hand-tuning small sizes is normal icon practice, not a workaround.

Windows picks whichever size suits the context: 16px in Explorer's details view, 256px for the
large tile. They all live in the one .ico.
"""

import pathlib, struct, subprocess, sys, tempfile
from io import BytesIO

ROOT = pathlib.Path(__file__).resolve().parent.parent
ARTWORK = ROOT / "src/ui/favicon.svg"
SMALL_ARTWORK = ROOT / "assets/icon-small.svg"
ICO = ROOT / "assets/icon.ico"

# size -> which source to rasterise from
LAYOUT = {16: SMALL_ARTWORK, 24: SMALL_ARTWORK, 32: ARTWORK, 48: ARTWORK,
          64: ARTWORK, 128: ARTWORK, 256: ARTWORK}

try:
    from PIL import Image
except ImportError:
    sys.exit("Needs Pillow:  python3 -m pip install Pillow")


def rasterise(svg: pathlib.Path) -> "Image.Image":
    """Renders an SVG well above the largest target so the downsamples stay crisp."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["qlmanage", "-t", "-s", "1024", "-o", tmp, str(svg)],
            check=True, capture_output=True,
        )
        rendered = next(pathlib.Path(tmp).glob("*.png"), None)
        if rendered is None:
            sys.exit(f"qlmanage produced no PNG for {svg.name} — is this macOS?")
        return Image.open(rendered).convert("RGBA").copy()


def build_ico(images: "dict[int, Image.Image]") -> bytes:
    """
    Assembles a PNG-compressed .ico.

    Written by hand because Pillow's ICO writer downsamples a single source, and the whole point
    here is that small sizes come from different artwork. PNG-in-ICO is supported from Windows
    Vista onward.
    """
    payloads = []
    for size in sorted(images):
        buffer = BytesIO()
        images[size].resize((size, size), Image.LANCZOS).save(buffer, format="PNG")
        payloads.append((size, buffer.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(payloads))  # reserved, type=icon, count
    offset = len(header) + 16 * len(payloads)
    entries, blobs = b"", b""

    for size, png in payloads:
        # 0 means 256 in the directory entry's single byte.
        dimension = 0 if size == 256 else size
        entries += struct.pack(
            "<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(png), offset
        )
        blobs += png
        offset += len(png)

    return header + entries + blobs


sources = {svg: rasterise(svg) for svg in {ARTWORK, SMALL_ARTWORK}}
ICO.parent.mkdir(parents=True, exist_ok=True)
ICO.write_bytes(build_ico({size: sources[svg] for size, svg in LAYOUT.items()}))

print(f"wrote {ICO.relative_to(ROOT)} ({ICO.stat().st_size:,} bytes)")
for size, svg in sorted(LAYOUT.items()):
    print(f"  {size:>3}px  from {svg.relative_to(ROOT)}")
