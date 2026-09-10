"""
tools/generate_icons.py
生成扩展图标（运行态 icon16/48/128.png + 暂停态 gray16/48/128.png）
纯 Python 标准库实现（zlib + struct），无需第三方依赖。

图标设计：圆角方形背景 + 白色播放三角（代表"媒体"）。
  - 运行态：主题蓝 #2563eb
  - 暂停态：中性灰 #9ca3af（供「暂停嗅探」时用 chrome.action.setIcon 切换）
运行方式：python js/utils/generate_icons.py
"""

import os
import struct
import zlib

# 主题色
BLUE = (37, 99, 235, 255)   # #2563eb（运行态）
GRAY = (156, 163, 175, 255)  # #9ca3af（暂停态，与界面 .tag-decor 灰度一致）
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def inside_round_rect(x, y, s, r):
    """判断像素中心 (x,y) 是否落在圆角矩形内。"""
    cx, cy = x + 0.5, y + 0.5
    if cx < r and cy < r:
        return (cx - r) ** 2 + (cy - r) ** 2 <= r * r
    if cx < r and cy > s - r:
        return (cx - r) ** 2 + (cy - (s - r)) ** 2 <= r * r
    if cx > s - r and cy < r:
        return (cx - (s - r)) ** 2 + (cy - r) ** 2 <= r * r
    if cx > s - r and cy > s - r:
        return (cx - (s - r)) ** 2 + (cy - (s - r)) ** 2 <= r * r
    return True


def sign(ax, ay, bx, by, cx, cy):
    return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)


def inside_triangle(px, py, a, b, c):
    """判断点是否在三角形内（叉积符号法）。"""
    d1 = sign(px, py, a[0], a[1], b[0], b[1])
    d2 = sign(px, py, b[0], b[1], c[0], c[1])
    d3 = sign(px, py, c[0], c[1], a[0], a[1])
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def build_pixels(size, bg=BLUE):
    """生成 RGBA 像素矩阵。bg 为圆角方形的底色（默认主题蓝）。"""
    pixels = [[TRANSPARENT for _ in range(size)] for _ in range(size)]
    r = size * 0.22  # 圆角半径

    # 播放三角顶点（连续坐标）
    a = (0.40 * size, 0.32 * size)
    b = (0.40 * size, 0.68 * size)
    c = (0.70 * size, 0.50 * size)

    for y in range(size):
        for x in range(size):
            if inside_round_rect(x, y, size, r):
                pixels[y][x] = bg
                if inside_triangle(x + 0.5, y + 0.5, a, b, c):
                    pixels[y][x] = WHITE
    return pixels


def write_png(path, size, pixels):
    """将像素矩阵写为 PNG 文件。"""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        for x in range(size):
            raw.extend(pixels[y][x])

    def chunk(tag, data):
        out = struct.pack('>I', len(data)) + tag + data
        out += struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)


def main():
    # 注意：本脚本位于 js/utils/ 下（v0.2.5 重构后从 tools/ 移入，深了一层），
    # 因此需要三次 dirname 才能到项目根；图标目录也由 icons/ 改名为 img/。
    base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    icons_dir = os.path.join(base, 'img')
    os.makedirs(icons_dir, exist_ok=True)

    # 运行态（主题蓝）
    for size in (16, 48, 128):
        path = os.path.join(icons_dir, f'icon{size}.png')
        write_png(path, size, build_pixels(size))
        print(f'已生成: {path}')

    # 暂停态（置灰）：供「暂停嗅探」时切换，视觉上明确表示已停止工作
    for size in (16, 48, 128):
        path = os.path.join(icons_dir, f'gray{size}.png')
        write_png(path, size, build_pixels(size, GRAY))
        print(f'已生成: {path}')

    print('图标生成完成。')


if __name__ == '__main__':
    main()
