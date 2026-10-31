# 生成应用图标（build/icon.ico）：纯本地 Pillow 绘制，不依赖外部素材。
# 用法：python scripts/make-icon.py
# 设计：纸色圆角方块 + 深棕「章」字，和写作页的纸墨配色一致。
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "build")
SIZE = 512  # 先画大图再缩放，边缘更干净

PAPER = (247, 244, 238, 255)
PAPER_SOFT = (251, 249, 244, 255)
LINE = (211, 200, 180, 255)
ACCENT = (138, 90, 59, 255)
INK = (43, 40, 34, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def rounded_rect(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    margin = 16
    # 纸色圆角方块 + 描边
    rounded_rect(
        draw,
        (margin, margin, SIZE - margin, SIZE - margin),
        radius=88,
        fill=PAPER,
        outline=LINE,
        width=8,
    )
    # 内侧浅色底，做出「纸」的层次
    inset = margin + 22
    rounded_rect(
        draw,
        (inset, inset, SIZE - inset, SIZE - inset),
        radius=66,
        fill=PAPER_SOFT,
        outline=(232, 224, 209, 255),
        width=3,
    )

    # 中央「章」字
    font = pick_font(268)
    text = "章"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (SIZE - tw) / 2 - bbox[0]
    ty = (SIZE - th) / 2 - bbox[1] - 6
    draw.text((tx, ty), text, font=font, fill=INK)

    # 底部一条棕色书脊线，作为品牌色
    draw.rounded_rectangle(
        (SIZE * 0.34, SIZE - 86, SIZE * 0.66, SIZE - 74),
        radius=6,
        fill=ACCENT,
    )

    png_path = os.path.join(OUT_DIR, "icon.png")
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    image.save(png_path, "PNG")
    image.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"[icon] {png_path}")
    print(f"[icon] {ico_path}")


if __name__ == "__main__":
    main()
