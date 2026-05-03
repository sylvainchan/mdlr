"""
生成 Chrome Extension 所需的簡單 icon PNG 檔案。
執行一次即可：python generate_icons.py
"""

import os
import struct
import zlib


def create_png(size: int, filepath: str):
    """建立一個純色（深紅 #e94560）正方形 PNG。"""

    def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
        c = chunk_type + data
        return (
            struct.pack(">I", len(data))
            + c
            + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        )

    # IHDR
    ihdr_data = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB

    # Image data: each row = filter byte (0) + RGB pixels
    r, g, b = 0xE9, 0x45, 0x60  # #e94560
    row = bytes([0]) + bytes([r, g, b] * size)
    raw = row * size
    idat_data = zlib.compress(raw)

    with open(filepath, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")  # PNG signature
        f.write(png_chunk(b"IHDR", ihdr_data))
        f.write(png_chunk(b"IDAT", idat_data))
        f.write(png_chunk(b"IEND", b""))


if __name__ == "__main__":
    icons_dir = os.path.join(os.path.dirname(__file__), "chrome-extension", "icons")
    os.makedirs(icons_dir, exist_ok=True)

    for size in (16, 48, 128):
        path = os.path.join(icons_dir, f"icon{size}.png")
        create_png(size, path)
        print(f"✓ 生成 {path}")

    print("Icons 生成完成！")
