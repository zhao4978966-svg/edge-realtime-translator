"""生成扩展所需的 PNG 图标（16/32/48/128）。

运行：
    python tools/make_icons.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

SCALES = (16, 32, 48, 128)
BG = (37, 99, 235, 255)          # 蓝色底
BG2 = (29, 78, 216, 255)         # 渐变第二色
BAR = (255, 255, 255, 255)       # 中间白条
INK = (30, 64, 175, 255)         # 字母颜色

FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        color = tuple(int(BG[i] + (BG2[i] - BG[i]) * t) for i in range(3)) + (255,)
        draw.line([(0, y), (size, y)], fill=color)
    return img


def draw_centered(draw: ImageDraw.ImageDraw, text: str, font, box, fill) -> None:
    left, top, right, bottom = box
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    x = left + (right - left - (r - l)) / 2 - l
    y = top + (bottom - top - (b - t)) / 2 - t
    draw.text((x, y), text, font=font, fill=fill)


def build(size: int) -> Image.Image:
    ss = size * 8  # 超采样后缩小，保证边缘平滑
    img = gradient(ss)

    draw = ImageDraw.Draw(img)

    # 中间斜向白条：象征“翻译转换”
    bar_h = max(int(ss * 0.075), 2)
    draw.rounded_rectangle(
        (int(ss * 0.10), int(ss * 0.5 - bar_h / 2), int(ss * 0.90), int(ss * 0.5 + bar_h / 2)),
        radius=bar_h // 2,
        fill=BAR,
    )

    # 上半：A（英文），下半：文（中文）
    top_box = (0, int(ss * 0.06), ss, int(ss * 0.46))
    bottom_box = (0, int(ss * 0.54), ss, int(ss * 0.96))

    if size >= 32:
        draw_centered(draw, "A", load_font(int(ss * 0.34)), top_box, BAR)
        draw_centered(draw, "文", load_font(int(ss * 0.32)), bottom_box, BAR)
    else:
        # 16px 太小，只保留两条粗横线示意
        for y_center, ratio in ((0.29, 0.09), (0.71, 0.09)):
            h = max(int(ss * ratio), 2)
            draw.rounded_rectangle(
                (int(ss * 0.24), int(ss * y_center - h / 2), int(ss * 0.76), int(ss * y_center + h / 2)),
                radius=h // 2,
                fill=BAR,
            )

    mask = rounded_mask(ss, int(ss * (0.22 if size >= 32 else 0.16)))
    img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SCALES:
        path = os.path.join(out_dir, f"icon{size}.png")
        build(size).save(path, "PNG")
        print(f"[ok] {path}")


if __name__ == "__main__":
    main()
