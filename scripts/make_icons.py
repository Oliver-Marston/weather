"""Generate weather-station app icons (sun + cloud on blue gradient)."""
from PIL import Image, ImageDraw

S = 1024  # high-res master, downscaled per output


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # vertical gradient background (matches app: #5a9ecf -> #16456f)
    top, bot = (0x5a, 0x9e, 0xcf), (0x16, 0x45, 0x6f)
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(top, bot, y / S) + (255,))

    # --- sun (upper-left), with rays ---
    sun_c = (S * 0.40, S * 0.40)
    sun_r = S * 0.165
    ray_in, ray_out = sun_r * 1.30, sun_r * 1.85
    import math
    for k in range(12):
        ang = math.radians(k * 30)
        x1 = sun_c[0] + math.cos(ang) * ray_in
        y1 = sun_c[1] + math.sin(ang) * ray_in
        x2 = sun_c[0] + math.cos(ang) * ray_out
        y2 = sun_c[1] + math.sin(ang) * ray_out
        d.line([(x1, y1), (x2, y2)], fill=(0xff, 0xcf, 0x4a, 255), width=int(S * 0.022))
    d.ellipse([sun_c[0] - sun_r, sun_c[1] - sun_r, sun_c[0] + sun_r, sun_c[1] + sun_r],
              fill=(0xff, 0xc7, 0x3a, 255))

    # --- cloud (overlapping, lower-right) white ---
    white = (255, 255, 255, 255)
    # base slab
    cy = S * 0.66
    d.rounded_rectangle([S * 0.30, cy, S * 0.80, cy + S * 0.165],
                        radius=S * 0.082, fill=white)
    # puffs
    d.ellipse([S * 0.34, S * 0.50, S * 0.34 + S * 0.22, S * 0.50 + S * 0.22], fill=white)
    d.ellipse([S * 0.52, S * 0.45, S * 0.52 + S * 0.27, S * 0.45 + S * 0.27], fill=white)
    d.ellipse([S * 0.66, S * 0.55, S * 0.66 + S * 0.18, S * 0.55 + S * 0.18], fill=white)
    return img


master = make_master()

# Apple touch icon + manifest icons (square, full-bleed; iOS masks corners itself)
for size in (180, 192, 512):
    master.resize((size, size), Image.LANCZOS).save(f"icon-{size}.png")

# Favicons
for size in (32, 16):
    master.resize((size, size), Image.LANCZOS).save(f"favicon-{size}.png")
master.resize((48, 48), Image.LANCZOS).save("favicon.ico", sizes=[(48, 48), (32, 32), (16, 16)])

print("icons written")
