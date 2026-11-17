#!/usr/bin/env python3
"""Render recorded terminal output; captions and timing edits live outside it.

Needs optional pyte and Pillow. An MP4 also needs ffmpeg (or imageio-ffmpeg);
a GIF is written with Pillow alone where neither is installed. No live services.
The edit manifest contains ordered segments with start/end/seconds/title and
optional screenshots with at/name/title. All times refer to the original cast.
"""
import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFont
import pyte

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('cast', type=Path)
parser.add_argument('edit', type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--font', type=Path, default=Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'))
parser.add_argument('--emoji-font', type=Path, help='Optional font with emoji glyphs; never distributed with the output')
parser.add_argument('--crop-bottom', type=int, default=0, help='Hide this many bottom terminal rows; keep the original cast intact')
parser.add_argument('--label', default='AZPR / REAL TERMINAL RECORDING', help='The line above the title; say so here when the services behind the terminal were fixtures')
parser.add_argument('--note', default='', help='Added to the disclosure line under the terminal, for what else a viewer must know')
parser.add_argument('--fps', type=int, default=10)
parser.add_argument('--gif', action='store_true')
args = parser.parse_args()
lines = args.cast.read_text().splitlines()
header = json.loads(lines[0])
assert header['version'] == 2
assert 0 <= args.crop_bottom < header['height']
visible_rows = header['height'] - args.crop_bottom
rows = [json.loads(line) for line in lines[1:] if line]
assert rows and all(len(row) == 3 and row[1] == 'o' for row in rows)
assert all(a[0] <= b[0] for a, b in zip(rows, rows[1:]))
edit = json.loads(args.edit.read_text())
segments = edit['segments']
assert segments and all(0 <= segment['start'] <= segment['end'] <= rows[-1][0]
                        and segment['seconds'] > 0 for segment in segments)
assert 1 <= args.fps <= 30
font = ImageFont.truetype(str(args.font), 16)
emoji_font = ImageFont.truetype(str(args.emoji_font), 16) if args.emoji_font else font
label_font = ImageFont.truetype(str(args.font), 17)
small_font = ImageFont.truetype(str(args.font), 12)
cell_width, cell_height = font.getlength('M'), 21
padding, top, bottom = 24, 88, 45
width = round(header['width'] * cell_width + padding * 2)
height = visible_rows * cell_height + top + bottom
width += width % 2
height += height % 2
palette = {'black': '#1c2028', 'red': '#ec7279', 'green': '#9dd39b',
           'brown': '#e8c37f', 'blue': '#8ab9f1', 'magenta': '#c8a3e8',
           'cyan': '#8cd0cc', 'white': '#d9e0e9', 'brightblack': '#727a8b',
           'brightred': '#ff8a8a', 'brightgreen': '#b6e5a8', 'brightbrown': '#ffe0a0',
           'brightblue': '#a3cfff', 'brightmagenta': '#dbb2f3',
           'brightcyan': '#b1edeb', 'brightwhite': '#ffffff'}


def color(value, default):
    if value == 'default':
        return default
    if value in palette:
        return palette[value]
    if len(value) == 6 and all(c in '0123456789abcdefABCDEF' for c in value):
        return '#' + value
    return default


# Replay only real output, in source order. Save frames needed by the edit.
requested = []
for segment in segments:
    count = max(1, round(segment['seconds'] * args.fps))
    requested.extend(segment['start'] + (segment['end'] - segment['start']) * index / max(1, count - 1)
                     for index in range(count))
requested.extend(item['at'] for item in edit.get('screenshots', []))
assert all(0 <= moment <= rows[-1][0] for moment in requested)
screen = pyte.Screen(header['width'], header['height'])
stream = pyte.Stream(screen)
event = 0
states = {}
for moment in sorted(set(requested)):
    while event < len(rows) and rows[event][0] <= moment:
        # pyte ignores terminal capabilities; it renders only their visible effects.
        stream.feed(rows[event][2])
        event += 1
    states[moment] = copy.deepcopy(screen.buffer)


glyph_widths = {}


def glyph_width(char):
    if char not in glyph_widths:
        glyph_widths[char] = font.getlength(char)
    return glyph_widths[char]


def render(moment, title):
    result = Image.new('RGB', (width, height), '#111722')
    draw = ImageDraw.Draw(result)
    draw.text((padding, 17), args.label, font=small_font, fill='#8db6dc')
    draw.text((padding, 43), title, font=label_font, fill='#ffffff')
    draw.rectangle((padding - 8, top - 6, width - padding + 8, top + visible_rows * cell_height + 6), fill='#0c0f15')
    buffer = states[moment]
    for row in range(visible_rows):
        cells = buffer[row]
        column = 0
        while column < header['width']:
            cell = cells[column]
            fg, bg = color(cell.fg, '#d9e0e9'), color(cell.bg, '#0c0f15')
            if cell.reverse:
                fg, bg = bg, fg
            end = column + 1
            while end < header['width'] and (cells[end].fg, cells[end].bg, cells[end].reverse) == (cell.fg, cell.bg, cell.reverse):
                end += 1
            if bg != '#0c0f15':
                draw.rectangle((padding + column * cell_width, top + row * cell_height,
                                padding + end * cell_width - 1, top + (row + 1) * cell_height - 1), fill=bg)
            # ASCII and box-drawing runs share the font's exact cell width.
            # Place wide/combining glyphs individually to preserve columns.
            text = ''.join(cells[index].data for index in range(column, end))
            if text.strip():
                if all(len(cells[index].data) == 1 and abs(glyph_width(cells[index].data) - cell_width) < 0.1
                       for index in range(column, end)):
                    draw.text((padding + column * cell_width, top + row * cell_height), text, font=font, fill=fg)
                else:
                    for index in range(column, end):
                        if cells[index].data.strip():
                            value = cells[index].data
                            selected_font = emoji_font if any(ord(char) >= 0x1f000 for char in value) else font
                            draw.text((padding + index * cell_width, top + row * cell_height), value,
                                      font=selected_font, fill=fg, embedded_color=selected_font is not font)
            column = end
    disclosure = 'Edited terminal replay | Waiting time shortened | '
    disclosure += 'Terminal status bar cropped' if args.crop_bottom else 'Test PR with seeded defects'
    if args.note:
        disclosure += ' | ' + args.note
    draw.text((padding, height - 27), disclosure, font=small_font, fill='#8e9cad')
    return result


def frames():
    """Every frame of the edit, in order, as (moment, title)."""
    for segment in segments:
        count = max(1, round(segment['seconds'] * args.fps))
        for index in range(count):
            yield segment['start'] + (segment['end'] - segment['start']) * index / max(1, count - 1), segment['title']


def write_gif_with_pillow():
    """A 960-pixel-wide GIF with one palette for all frames; equal frames in a row become one longer frame."""
    scaled_height = round(height * 960 / width)
    distinct, durations, previous = [], [], None
    for key in frames():
        if key == previous:
            durations[-1] += 1000 // args.fps
            continue
        previous = key
        distinct.append(render(*key).resize((960, scaled_height), Image.Resampling.LANCZOS))
        durations.append(1000 // args.fps)
    # The palette comes from a sheet of frames chosen evenly over the whole edit, so colors do not shift between
    # frames and the accents of late frames are in it as well.
    count = min(12, len(distinct))
    chosen = [distinct[round(index * (len(distinct) - 1) / max(1, count - 1))] for index in range(count)]
    sheet = Image.new('RGB', (960, scaled_height * len(chosen)))
    for index, frame in enumerate(chosen):
        sheet.paste(frame, (0, index * scaled_height))
    # An octree keeps the few accent colors of a mostly dark terminal; a median cut spends the palette on shades of gray.
    palette_image = sheet.quantize(colors=255, method=Image.Quantize.FASTOCTREE)
    indexed = [frame.quantize(palette=palette_image, dither=Image.Dither.NONE) for frame in distinct]
    # Like the FFmpeg path: played, repeated once, then the last frame stays.
    indexed[0].save(args.output, save_all=True, append_images=indexed[1:], duration=durations, loop=1, optimize=False, disposal=1)


args.output.parent.mkdir(parents=True, exist_ok=True)
ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        ffmpeg = None
if not ffmpeg and not args.gif:
    parser.error('An MP4 needs ffmpeg or imageio-ffmpeg; a GIF (--gif) is written with Pillow alone.')
if not ffmpeg:
    write_gif_with_pillow()
else:
    command = [ffmpeg, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
               '-s', f'{width}x{height}', '-r', str(args.fps), '-i', '-', '-an']
    if args.gif:
        command.extend(['-vf', 'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '1'])
    else:
        command.extend(['-c:v', 'libx264', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'])
    command.append(str(args.output))
    encoder = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for moment, title in frames():
            encoder.stdin.write(render(moment, title).tobytes())
    finally:
        encoder.stdin.close()
    assert encoder.wait() == 0, 'Video encoder failed'
for item in edit.get('screenshots', []):
    name = Path(item['name'])
    assert name.name == str(name) and name.suffix == '.png', 'Screenshot name must be a PNG basename'
    render(item['at'], item['title']).save(args.output.parent / name)
print(json.dumps({'output': str(args.output), 'seconds': sum(item['seconds'] for item in segments),
                  'sourceSeconds': rows[-1][0], 'size': [width, height],
                  'screenshots': len(edit.get('screenshots', []))}))
