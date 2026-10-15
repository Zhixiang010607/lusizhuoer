"""Generate tiny, font-independent SVG paths from the existing OFL report font.

Development dependencies: fonttools, brotli. Emits JSON to stdout; no face inputs.
"""
import io
import json
from pathlib import Path

import brotli
from fontTools.cffLib import CFFFontSet
from fontTools.pens.svgPathPen import SVGPathPen

root = Path(__file__).resolve().parents[1]
source = root / "miniprogram-app/miniprogram/packages/report-font/NotoSansCJKsc-Common-Identity.br"
font = CFFFontSet()
font.decompile(io.BytesIO(brotli.decompress(source.read_bytes())), None)
top = font[font.fontNames[0]]
glyphs = {}
for character in "0123456789-: 上下班打卡北京时间":
    # The PDF font remaps CJK CIDs to Unicode, but intentionally leaves Latin
    # glyphs in its compact original order (PDF uses a separate Latin font).
    if character == "-":
        glyphs[character] = {"path": "M40 280H300V350H40Z", "width": 347}
        continue
    cid = 1 if character == " " else ord(character) - 32 if ord(character) < 128 else ord(character)
    name = f"cid{cid:05d}"
    glyph = top.CharStrings[name]
    pen = SVGPathPen(None)
    glyph.draw(pen)
    glyphs[character] = {"path": pen.getCommands(), "width": glyph.width}
print(json.dumps({"license": "SIL Open Font License 1.1; NotoSansCJKsc, existing repository report font", "glyphs": glyphs}, ensure_ascii=False))
