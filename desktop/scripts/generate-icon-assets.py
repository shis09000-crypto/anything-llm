from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
BUILD_DIR.mkdir(parents=True, exist_ok=True)

SIZE = 1024


def draw_icon(size=SIZE):
    scale = size / SIZE
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def box(values):
        return tuple(round(value * scale) for value in values)

    def width(value):
        return max(1, round(value * scale))

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        box((122, 136, 902, 916)),
        radius=width(188),
        fill=(0, 0, 0, 120),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(width(34)))
    image.alpha_composite(shadow)

    draw.rounded_rectangle(
        box((96, 86, 928, 918)),
        radius=width(196),
        fill=(18, 25, 37, 255),
    )

    gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient_draw = ImageDraw.Draw(gradient)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = (
            round(17 + 8 * ratio),
            round(55 + 80 * (1 - ratio)),
            round(72 + 38 * ratio),
            255,
        )
        gradient_draw.line((0, y, size, y), fill=color)
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(box((96, 86, 928, 918)), radius=width(196), fill=255)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(box((40, -112, 620, 450)), fill=(58, 213, 171, 70))
    glow_draw.ellipse(box((432, 464, 1048, 1090)), fill=(67, 179, 255, 58))
    glow = glow.filter(ImageFilter.GaussianBlur(width(28)))
    image.alpha_composite(glow)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        box((252, 224, 772, 800)),
        radius=width(70),
        fill=(255, 255, 255, 28),
        outline=(255, 255, 255, 72),
        width=width(6),
    )
    draw.line(box((336, 358, 676, 358)), fill=(255, 255, 255, 76), width=width(18))
    draw.line(box((336, 470, 600, 470)), fill=(255, 255, 255, 54), width=width(18))
    draw.line(box((336, 582, 650, 582)), fill=(255, 255, 255, 54), width=width(18))

    nodes = {
        "a": (328, 656),
        "b": (504, 470),
        "c": (688, 642),
        "d": (658, 318),
    }
    for start, end in [("a", "b"), ("b", "c"), ("b", "d")]:
        draw.line(
            box((*nodes[start], *nodes[end])),
            fill=(114, 246, 211, 205),
            width=width(22),
        )

    for key, (x, y) in nodes.items():
        radius = 54 if key == "b" else 46
        fill = (121, 255, 220, 255) if key == "b" else (85, 196, 255, 255)
        draw.ellipse(
            box((x - radius, y - radius, x + radius, y + radius)),
            fill=fill,
            outline=(255, 255, 255, 180),
            width=width(8),
        )

    draw.rounded_rectangle(
        box((96, 86, 928, 918)),
        radius=width(196),
        outline=(255, 255, 255, 82),
        width=width(8),
    )
    return image


icon = draw_icon()
icon.save(BUILD_DIR / "icon.png")
icon.save(
    BUILD_DIR / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

(BUILD_DIR / "icon.svg").write_text(
    """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#143646"/>
      <stop offset="1" stop-color="#178078"/>
    </linearGradient>
    <radialGradient id="glowA" cx="24%" cy="12%" r="58%">
      <stop offset="0" stop-color="#7fffe0" stop-opacity=".42"/>
      <stop offset="1" stop-color="#7fffe0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="80%" cy="82%" r="50%">
      <stop offset="0" stop-color="#56b7ff" stop-opacity=".34"/>
      <stop offset="1" stop-color="#56b7ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="96" y="86" width="832" height="832" rx="196" fill="url(#bg)"/>
  <rect x="96" y="86" width="832" height="832" rx="196" fill="url(#glowA)"/>
  <rect x="96" y="86" width="832" height="832" rx="196" fill="url(#glowB)"/>
  <rect x="252" y="224" width="520" height="576" rx="70" fill="#fff" fill-opacity=".12" stroke="#fff" stroke-opacity=".28" stroke-width="6"/>
  <path d="M336 358h340M336 470h264M336 582h314" stroke="#fff" stroke-opacity=".36" stroke-width="18" stroke-linecap="round"/>
  <path d="M328 656 504 470 688 642M504 470 658 318" stroke="#72f6d3" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="504" cy="470" r="54" fill="#79ffdc" stroke="#fff" stroke-opacity=".7" stroke-width="8"/>
  <circle cx="328" cy="656" r="46" fill="#55c4ff" stroke="#fff" stroke-opacity=".7" stroke-width="8"/>
  <circle cx="688" cy="642" r="46" fill="#55c4ff" stroke="#fff" stroke-opacity=".7" stroke-width="8"/>
  <circle cx="658" cy="318" r="46" fill="#55c4ff" stroke="#fff" stroke-opacity=".7" stroke-width="8"/>
  <rect x="96" y="86" width="832" height="832" rx="196" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="8"/>
</svg>
""",
    encoding="utf8",
)

print(f"Generated icon assets in {BUILD_DIR}")
