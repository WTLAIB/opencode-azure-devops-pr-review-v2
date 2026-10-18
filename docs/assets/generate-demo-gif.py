"""Build the optional synthetic walkthrough GIF from generate-demo.mjs --frames.

Requires an existing Pillow installation; never installs project dependencies.
Run: python3 docs/assets/generate-demo-gif.py
"""
from pathlib import Path
from PIL import Image

assets = Path(__file__).resolve().parent
frames_dir = assets.parent.parent / ".local" / "project-launch-demo-assets"
frames = []
for number in range(1, 5):
    with Image.open(frames_dir / f"step-{number}.png") as source:
        frames.append(source.convert("RGB"))
assert all(frame.size == (1200, 660) for frame in frames)
frames[0].save(
    assets / "quick-review-demo.gif",
    save_all=True,
    append_images=frames[1:],
    duration=[4500, 5500, 5500, 5500],
    loop=1,  # Play twice, then stop. A static alternative is linked in DEMO.md.
    optimize=True,
    disposal=2,
)
print("Generated quick-review-demo.gif from four synthetic illustration frames.")
