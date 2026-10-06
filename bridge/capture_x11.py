#!/usr/bin/env python3
"""NeverQuestAlone's Linux/X11 capture helper: screen-captures the top-left corner of
the WoW client window (running under Wine) and decodes the addon's pixel strip (see
Codec.lua in the addon). Prints one JSON line per new message to stdout, with the
same {info|warn|error[,kind]|id,text} contract as the other NeverQuestAlone helpers
(PRD §11.1, PF-7). Started by bridge/transport/capture.mjs.

Like the Windows helper it also reports the game's lifecycle, {"game": "absent" |
"running" | "launched" | "exited", "pid": N} (the pid from _NET_WM_PID, when
/proc confirms it is the game's), and typed errors (window_not_found,
window_minimized, capture_unsupported), each said when it starts and then at most
once a minute.

Zero dependencies: python3 + ctypes against libX11.

  capture_x11.py --test-image strip.png   decode a PNG once and exit (tests)
  capture_x11.py --probe out.png          save what the capture sees once and exit (it also
                                          tries the other known magic, and says which decoded)
  capture_x11.py --window-name NAME       match a window by title instead of WM_CLASS
  capture_x11.py --magic C72C             the strip's magic: C72C (NeverQuestAlone, the default)
                                          or C71A (upstream wow-ai's WoWAI addon)
  capture_x11.py --pitch-search           when the fixed --cell doesn't decode, measure the
                                          cell pitch (--min-pitch 3 to --max-pitch 6 px)
"""

import argparse
import ctypes
import ctypes.util
import json
import math
import os
import struct
import sys
import time
import zlib

DEFAULT_MAGIC = "C72C"
KNOWN_MAGICS = {"C72C": "NeverQuestAlone", "C71A": "the WoWAI addon (wow-ai)"}
EXIT_GRACE = 10.0  # s: with no pid to watch, a window gone this long means the game quit
# Code health BR-15 (PF-09): the search for the game's window ran every 3 s for as long as the game
# stayed closed. It waits 3 s at first, twice as long after each search that finds none, at most a
# minute, and 3 s again once a window was found (so an exit's grace and a relaunch are seen quickly).
SEARCH_WAIT_FIRST, SEARCH_WAIT_MOST = 3.0, 60.0
SLACK = 8  # pixels of misalignment searched around the window origin
SEARCH_ROWS, SEARCH_COLS = 80, 32  # where --pitch-search looks for the strip's first cell


def parse_magic(text):
    """'C72C', '0xC72C' or 'c7 2c' -> (0xC7, 0x2C). ValueError otherwise."""
    s = str(text).strip().replace(" ", "")
    if s[:2].lower() == "0x":
        s = s[2:]
    if len(s) != 4 or any(c not in "0123456789abcdefABCDEF" for c in s):
        raise ValueError("magic must be 4 hex digits, e.g. C72C (NeverQuestAlone) or C71A (wow-ai)")
    v = int(s, 16)
    return (v >> 8, v & 0xFF)


def _magic_arg(text):
    try:
        return parse_magic(text)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e))


def build_parser():
    p = argparse.ArgumentParser()
    p.add_argument("--cell", type=int, default=4)
    p.add_argument("--cells", type=int, default=200)
    p.add_argument("--max-rows", type=int, default=48)
    p.add_argument("--interval-ms", type=int, default=250)
    p.add_argument("--process-name", default="WowB")
    p.add_argument("--window-name", default="")
    p.add_argument("--keep-composited", action="store_true",
                   help="ask the compositor not to unredirect the game window (_NET_WM_BYPASS_COMPOSITOR=2)")
    p.add_argument("--magic", type=_magic_arg, default=parse_magic(DEFAULT_MAGIC),
                   help="the strip's two magic bytes as hex: C72C (NeverQuestAlone, default) or C71A (wow-ai)")
    p.add_argument("--pitch-search", action="store_true",
                   help="when --cell doesn't decode, measure the cell pitch between --min-pitch and --max-pitch")
    p.add_argument("--min-pitch", type=float, default=3.0)
    p.add_argument("--max-pitch", type=float, default=6.0)
    p.add_argument("--test-image", default="")
    p.add_argument("--probe", default="")
    return p


def configure(a):
    """Set the module's geometry from parsed arguments (main() and tests)."""
    global args, CELL, CELLS, MAXROWS, W, H, MAGIC, MAGIC16, GRAB_W, GRAB_H
    args = a
    CELL, CELLS, MAXROWS = a.cell, a.cells, a.max_rows
    W, H = CELLS * CELL, MAXROWS * CELL
    MAGIC = tuple(a.magic)
    MAGIC16 = (MAGIC[0] << 8) | MAGIC[1]
    widest = max(CELL, a.max_pitch) if a.pitch_search else CELL
    GRAB_W, GRAB_H = int(math.ceil(CELLS * widest)) + SLACK, int(math.ceil(MAXROWS * widest)) + SLACK


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Decoder: upstream wow-ai's rules (fixed --cell pitch), plus the macOS decoder's
# pitch measurement (StripDecoder.swift: magic runs -> estimate -> least-squares
# refine) behind --pitch-search.
# ---------------------------------------------------------------------------

def cell_bits(rgb):
    rr, gg, bb = rgb
    return (4 if rr >= 128 else 0) + (2 if gg >= 128 else 0) + (1 if bb >= 128 else 0)


def sample(px, x0, y0, pitch, c, r):
    """The cell's value at its center, for a (possibly fractional) pitch. With an
    integer pitch and origin this is ox + c * CELL + CELL // 2, as upstream's decoder sampled."""
    return cell_bits(px(int(math.floor(x0 + (c + 0.5) * pitch)), int(math.floor(y0 + (r + 0.5) * pitch))))


def magic_cells():
    """The magic as the strip draws it: five whole 3-bit cells, then the top bit of the sixth."""
    return [(MAGIC16 >> (13 - 3 * k)) & 7 for k in range(5)], MAGIC16 & 1


def has_magic(px, ox, oy, pitch=None, width=None, height=None):
    pitch = CELL if pitch is None else pitch
    if width is not None and (ox + 6 * pitch > width or oy + pitch > height):
        return False
    whole, top = magic_cells()
    for i in range(5):  # stop at the first wrong cell: most offsets fail on the first
        if sample(px, ox, oy, pitch, i, 0) != whole[i]:
            return False
    return (sample(px, ox, oy, pitch, 5, 0) >> 2) == top


def decode(px, ox=0, oy=0, pitch=None, width=None, height=None):
    """None (no strip), {"error": reason} (strip seen, invalid) or {"id", "text"}."""
    pitch = CELL if pitch is None else pitch
    acc = 0
    nbits = 0
    out = bytearray()
    needed = 6
    total = CELLS * MAXROWS
    for i in range(total):
        c, r = i % CELLS, i // CELLS
        if width is not None:
            x = math.floor(ox + (c + 0.5) * pitch)
            y = math.floor(oy + (r + 0.5) * pitch)
            if x < 0 or y < 0 or x >= width or y >= height:
                return {"error": "truncated"} if len(out) >= 2 else None
        acc = (acc << 3) | sample(px, ox, oy, pitch, c, r)
        nbits += 3
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
            if len(out) == 2 and (out[0] != MAGIC[0] or out[1] != MAGIC[1]):
                return None
            if len(out) == 6:
                length = out[4] * 256 + out[5]
                needed = 8 + length
                if needed > total * 3 // 8:
                    return {"error": "length"}
            if len(out) >= needed:
                break
        if len(out) >= needed:
            break
    if len(out) < needed:
        return {"error": "truncated"}
    length = out[4] * 256 + out[5]
    s1 = s2 = 0
    for k in range(2, 6 + length):
        s1 = (s1 + out[k]) % 255
        s2 = (s2 + s1) % 255
    if out[6 + length] != s1 or out[7 + length] != s2:
        return {"error": "checksum"}
    text = bytes(out[6:6 + length]).decode("utf-8", errors="replace")
    return {"id": out[2] * 256 + out[3], "text": text}


def magic_runs():
    runs = []
    for v in magic_cells()[0]:
        if runs and runs[-1][0] == v:
            runs[-1][1] += 1
        else:
            runs.append([v, 1])
    return runs


def estimate(px, width, height, min_pitch, max_pitch, max_candidates=4):
    """Candidate (x0, y0, pitch): rows near the top whose leftmost pixels start with
    the magic's color runs; the pitch comes from where the runs change."""
    want = magic_runs()
    cells_before = sum(n for _, n in want[:-1])
    found = []
    for y in range(min(SEARCH_ROWS, height)):
        if len(found) >= max_candidates:
            break
        x, max_x = 0, min(SEARCH_COLS, width)
        while x < max_x and cell_bits(px(x, y)) != want[0][0]:
            x += 1
        if x >= max_x:
            continue
        # Runs along the row over a fixed span, ignoring 1-pixel blips (blended edges).
        limit = min(width, x + int(max_pitch * 6) + 4)
        runs, cur, start = [], cell_bits(px(x, y)), x
        for xx in range(x + 1, limit):
            v = cell_bits(px(xx, y))
            if v != cur:
                runs.append([cur, start, xx - start])
                cur, start = v, xx
        runs.append([cur, start, limit - start])
        merged = []
        for r in runs:
            if r[2] <= 1 and merged:
                merged[-1][2] += r[2]
            elif merged and merged[-1][0] == r[0]:
                merged[-1][2] += r[2]
            else:
                merged.append(list(r))
        if len(merged) < len(want) or any(merged[k][0] != want[k][0] for k in range(len(want))):
            continue
        p = (merged[len(want) - 1][1] - merged[0][1]) / float(cells_before)
        if p < min_pitch or p > max_pitch:
            continue
        if any(not (p * want[k][1] * 0.5 <= merged[k][2] <= p * want[k][1] * 1.6) for k in range(len(want) - 1)):
            continue
        g = (float(merged[0][1]), float(y), p)
        if not any(abs(f[0] - g[0]) < 1 and abs(f[2] - g[2]) < 0.3 and abs(f[1] - g[1]) < p for f in found):
            found.append(g)
    return found


def refine(px, width, height, g, min_pitch, max_pitch):
    """Sharpen x0 and the pitch with a least-squares fit of the color changes along
    the first cell row (a change sits on a boundary x0 + k * pitch)."""
    x0, y0, pitch = g
    y = int(y0 + 0.5 * pitch)
    if y < 0 or y >= height:
        return g
    for max_cells in (12, 32, 80, CELLS):
        x_end = min(width, int(x0 + max_cells * pitch))
        xs = max(0, int(x0))
        if xs >= width:
            break
        n = sk = st = skk = skt = 0.0
        prev, last_k = cell_bits(px(xs, y)), -1.0
        for x in range(xs + 1, x_end):
            v = cell_bits(px(x, y))
            if v != prev:
                kf = (x - x0) / pitch
                k = float(math.floor(kf + 0.5))
                if k >= 1 and abs(kf - k) < 0.35 and k != last_k:
                    n += 1
                    sk += k
                    st += x
                    skk += k * k
                    skt += k * x
                    last_k = k
                prev = v
        if n >= 3:
            den = n * skk - sk * sk
            if den > 0:
                p = (n * skt - sk * st) / den
                nx0 = (st - p * sk) / n
                if min_pitch < p < max_pitch and abs(p - pitch) < pitch * 0.2:
                    pitch, x0 = p, nx0
    return (x0, y0, pitch)


def find_and_decode(px, width, height, hint, measure=True):
    """Decode at the last good geometry, else search a small window for the magic at
    --cell, else (with --pitch-search, when measure is true) measure the pitch.
    Returns (msg, hint)."""
    rejected = None
    if hint and len(hint) == 3 and hint[2] != CELL:
        msg = decode(px, hint[0], hint[1], hint[2], width, height)
        if msg and not msg.get("error"):
            return msg, hint
    cands = [hint[:2]] if hint else []
    cands += [(dx, dy) for dy in range(SLACK + 1) for dx in range(SLACK + 1)]
    for ox, oy in cands:
        if ox + W > width or oy + H > height:
            continue
        if has_magic(px, ox, oy):
            msg = decode(px, ox, oy)
            if not args.pitch_search or (msg and not msg.get("error")):
                return msg, (ox, oy, CELL)
            rejected = rejected or (msg, (ox, oy, CELL))
            break
    if not args.pitch_search or not measure:
        return rejected if rejected else (None, hint)
    for est in estimate(px, width, height, args.min_pitch, args.max_pitch):
        g = refine(px, width, height, est, args.min_pitch, args.max_pitch)
        # The fit, one-axis nudges around it, then the raw estimate (at most 13 decodes).
        tries = [g] + [(g[0], g[1], g[2] + dp) for dp in (0.005, -0.005, 0.01, -0.01, 0.02, -0.02)]
        tries += [(g[0], g[1] + dy, g[2]) for dy in (1.0, -1.0, 2.0)] + [(g[0] + dx, g[1], g[2]) for dx in (0.5, -0.5)]
        tries.append(est)
        for t in tries:
            msg = decode(px, t[0], t[1], t[2], width, height)
            if msg and not msg.get("error"):
                return msg, t
            if msg and not rejected:
                rejected = (msg, t)
    # Whole pitches in the range at the slack offsets, for edges too blended to measure.
    for p in range(int(math.ceil(args.min_pitch)), int(math.floor(args.max_pitch)) + 1):
        if p == CELL:
            continue
        for oy in range(SLACK + 1):
            for ox in range(SLACK + 1):
                if has_magic(px, ox, oy, p, width, height):
                    msg = decode(px, ox, oy, p, width, height)
                    if msg and not msg.get("error"):
                        return msg, (ox, oy, p)
                    if msg and not rejected:
                        rejected = (msg, (ox, oy, p))
    return rejected if rejected else (None, hint)


configure(build_parser().parse_args([]))  # defaults, so importing the module (tests) needs no argv


def magic_text(magic=None):
    m = MAGIC if magic is None else magic
    return "%02X%02X" % (m[0], m[1])


def with_magic(magic, fn):
    """Run fn() with the strip's magic set to `magic`, then put the configured one back."""
    saved = args.magic
    args.magic = magic
    configure(args)
    try:
        return fn()
    finally:
        args.magic = saved
        configure(args)


def probe_decode(px, width, height):
    """--probe's verdict: decode with the configured magic; if that finds no strip, try the
    other known magic too, so `npm run probe` answers for NeverQuestAlone's and wow-ai's addons."""
    msg, off = find_and_decode(px, width, height, None)
    out = {"strip": msg, "offset": off, "magic": magic_text()}
    if msg and not msg.get("error"):
        return out
    for text, who in KNOWN_MAGICS.items():
        if text == magic_text():
            continue
        other, other_off = with_magic(parse_magic(text), lambda: find_and_decode(px, width, height, None))
        if other and not other.get("error"):
            out.update(strip=other, offset=other_off, magic=text,
                       note="this is %s's strip (magic %s); capture it with --magic %s" % (who, text, text))
            return out
    return out


# ---------------------------------------------------------------------------
# The game's lifecycle and typed errors (the same lines as the Windows helper)
# ---------------------------------------------------------------------------

class ErrorLimiter:
    """Typed errors: each kind is said when it starts, then at most once a minute, however
    often the condition comes and goes. When an error that was said clears, say "capturing"."""

    def __init__(self, every=60.0):
        self.every = every
        self.said = {}          # kind -> when it was last said
        self.active = False     # an error holds now
        self.announced = False  # ...and the bridge was told about one since the last "capturing"

    def set(self, kind, now):
        """The condition holds: True if the error line should be sent now."""
        self.active = True
        last = self.said.get(kind)
        if last is not None and now - last < self.every:
            return False
        self.said[kind] = now
        self.announced = True
        return True

    def clear(self):
        """Capture works again: True if "capturing" should be sent."""
        say = self.active and self.announced
        self.active = False
        if say:
            self.announced = False
        return say


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class SearchBackoff:
    """How long to wait before looking for the game's window again (SEARCH_WAIT_FIRST, doubling
    while none is found, at most SEARCH_WAIT_MOST; found() starts it over)."""

    def __init__(self, first=SEARCH_WAIT_FIRST, most=SEARCH_WAIT_MOST):
        self.first, self.most, self.wait = first, most, first

    def missed(self):
        wait, self.wait = self.wait, min(self.most, self.wait * 2)
        return wait

    def found(self):
        self.wait = self.first


class GameTracker:
    """The game's lifecycle from its window, as {"game": ...} lines: "absent" when the first
    search finds nothing, "running" when it finds the game, "launched" for a game that
    appears later, "exited" when the window is gone and its process has ended (with no pid
    to watch: when the window has been gone for EXIT_GRACE seconds)."""

    def __init__(self, alive=None, grace=EXIT_GRACE):
        self.alive, self.grace = alive or (lambda pid: pid_alive(pid)), grace
        self.first = True
        self.tracking = False   # a game is attached or was until just now
        self.pid = None
        self.gone_since = None

    def found(self, pid, now):
        events = []
        first, self.first = self.first, False
        self.gone_since = None
        if self.tracking and (pid is None or pid == self.pid):
            return events  # the same game's window, found again
        if self.tracking and self.pid is not None and not self.alive(self.pid):
            events.append({"game": "exited", "pid": self.pid})
        self.tracking, self.pid = True, pid
        ev = {"game": "running" if first else "launched"}
        if pid is not None:
            ev["pid"] = pid
        events.append(ev)
        return events

    def missing(self, now):
        if self.first:
            self.first = False
            return [{"game": "absent"}]
        if not self.tracking:
            return []
        if self.pid is not None:
            if self.alive(self.pid):
                return []  # the window is away (recreated, a loading screen); the game isn't
            ev = {"game": "exited", "pid": self.pid}
        else:
            if self.gone_since is None:
                self.gone_since = now
            if now - self.gone_since < self.grace:
                return []
            ev = {"game": "exited"}
        self.tracking, self.pid, self.gone_since = False, None, None
        return [ev]


def proc_is_game(pid, expect, proc="/proc"):
    """Does /proc say pid is the game? Its command line or name must contain `expect` (the
    process name, or ".exe" when matching by title): a pid from another PID namespace
    (Flatpak) could name an unrelated process here, and the bridge would watch the wrong one."""
    base = os.path.join(proc, str(int(pid)))
    text = ""
    for name in ("cmdline", "comm"):
        try:
            with open(os.path.join(base, name), "rb") as fh:
                text += fh.read(4096).replace(b"\0", b" ").decode("utf-8", "replace") + " "
        except OSError:
            pass
    return bool(text.strip()) and expect.lower() in text.lower()


# ---------------------------------------------------------------------------
# PNG in/out (tests and --probe)
# ---------------------------------------------------------------------------

def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, b""
    width = height = depth = ctype = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("only 8-bit RGB/RGBA PNGs are supported")
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line

    def px(x, y):
        o = x * bpp
        row = rows[y]
        return row[o], row[o + 1], row[o + 2]
    return px, width, height


def write_png(path, px, width, height):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(px(x, y))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


def test_image_main():
    px, w, h = read_png(args.test_image)
    msg, _ = find_and_decode(px, w, h, None)
    emit(msg if msg else {"error": "no valid strip in image"})
    return 0


# ---------------------------------------------------------------------------
# X11 (set up by init_x11(), so importing this file for its decoder needs no display)
# ---------------------------------------------------------------------------

Window = ctypes.c_ulong
Atom = ctypes.c_ulong


class XImage(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int),
        ("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int),
        ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int),
        ("red_mask", ctypes.c_ulong), ("green_mask", ctypes.c_ulong), ("blue_mask", ctypes.c_ulong),
        ("obdata", ctypes.c_void_p),
        ("create_image", ctypes.c_void_p), ("destroy_image", ctypes.c_void_p),
        ("get_pixel", ctypes.c_void_p), ("put_pixel", ctypes.c_void_p),
        ("sub_image", ctypes.c_void_p), ("add_pixel", ctypes.c_void_p),
    ]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p),
        ("root", Window), ("class", ctypes.c_int), ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long), ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class XClassHint(ctypes.Structure):
    # Raw pointers: c_char_p would hand back Python copies, and XFree on those crashes.
    _fields_ = [("res_name", ctypes.c_void_p), ("res_class", ctypes.c_void_p)]


# Xlib's default error handler exits the process; a window that disappears between
# lookup and capture (loading screens, client restart) must only cost one frame.
ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
x_errors = [0]


def _on_x_error(_display, _event):
    x_errors[0] += 1
    return 0


_error_handler_ref = ERROR_HANDLER(_on_x_error)
ZPIXMAP, ALL_PLANES, IS_VIEWABLE = 2, 0xFFFFFFFF, 2
X = dpy = root = None
A_CLIENT_LIST = A_WINDOW = A_CARDINAL = A_BYPASS = A_PID = None


def init_x11():
    """Load libX11 and open the display. False (after an error line) if it can't."""
    global X, dpy, root, A_CLIENT_LIST, A_WINDOW, A_CARDINAL, A_BYPASS, A_PID
    if not os.environ.get("DISPLAY"):
        emit({"error": "DISPLAY is not set; the capture needs the X session the game runs in", "kind": "capture_unsupported"})
        return False
    lib = ctypes.util.find_library("X11")
    if not lib:
        emit({"error": "libX11 not found", "kind": "capture_unsupported"})
        return False
    X = ctypes.cdll.LoadLibrary(lib)
    X.XOpenDisplay.restype = ctypes.c_void_p
    X.XOpenDisplay.argtypes = [ctypes.c_char_p]
    X.XDefaultRootWindow.restype = Window
    X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    X.XInternAtom.restype = Atom
    X.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    X.XGetWindowProperty.argtypes = [ctypes.c_void_p, Window, Atom, ctypes.c_long, ctypes.c_long, ctypes.c_int, Atom,
                                     ctypes.POINTER(Atom), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                     ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
    X.XGetClassHint.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XClassHint)]
    X.XFetchName.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(ctypes.c_void_p)]
    X.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XWindowAttributes)]
    X.XTranslateCoordinates.argtypes = [ctypes.c_void_p, Window, Window, ctypes.c_int, ctypes.c_int,
                                        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(Window)]
    X.XGetImage.restype = ctypes.POINTER(XImage)
    X.XGetImage.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                            ctypes.c_ulong, ctypes.c_int]
    X.XFree.argtypes = [ctypes.c_void_p]
    X.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    X.XChangeProperty.argtypes = [ctypes.c_void_p, Window, Atom, Atom, ctypes.c_int, ctypes.c_int,
                                  ctypes.c_void_p, ctypes.c_int]
    X.XFlush.argtypes = [ctypes.c_void_p]
    X.XSetErrorHandler(_error_handler_ref)
    dpy = X.XOpenDisplay(None)
    if not dpy:
        emit({"error": "cannot open display " + os.environ.get("DISPLAY", ""), "kind": "capture_unsupported"})
        return False
    root = X.XDefaultRootWindow(dpy)
    A_CLIENT_LIST = X.XInternAtom(dpy, b"_NET_CLIENT_LIST", 0)
    A_WINDOW = X.XInternAtom(dpy, b"WINDOW", 0)
    A_CARDINAL = X.XInternAtom(dpy, b"CARDINAL", 0)
    A_BYPASS = X.XInternAtom(dpy, b"_NET_WM_BYPASS_COMPOSITOR", 0)
    A_PID = X.XInternAtom(dpy, b"_NET_WM_PID", 0)
    return True


def client_list():
    typ, fmt = Atom(), ctypes.c_int()
    n, rest, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    if X.XGetWindowProperty(dpy, root, A_CLIENT_LIST, 0, 4096, 0, A_WINDOW, ctypes.byref(typ), ctypes.byref(fmt),
                            ctypes.byref(n), ctypes.byref(rest), ctypes.byref(data)) != 0 or not data:
        return []
    arr = ctypes.cast(data, ctypes.POINTER(Window))
    wins = [arr[i] for i in range(n.value)]
    X.XFree(data)
    return wins


def window_pid(w):
    """The game's pid from _NET_WM_PID (Wine sets it), if /proc confirms it; else None."""
    typ, fmt = Atom(), ctypes.c_int()
    n, rest, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    before = x_errors[0]
    if X.XGetWindowProperty(dpy, w, A_PID, 0, 1, 0, A_CARDINAL, ctypes.byref(typ), ctypes.byref(fmt),
                            ctypes.byref(n), ctypes.byref(rest), ctypes.byref(data)) != 0 or not data:
        return None
    pid = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] if n.value >= 1 and fmt.value == 32 else 0
    X.XFree(data)
    if x_errors[0] != before or pid <= 1:
        return None
    expect = ".exe" if args.window_name else args.process_name
    return int(pid) if proc_is_game(pid, expect) else None


def attrs(w):
    a = XWindowAttributes()
    before = x_errors[0]
    ok = X.XGetWindowAttributes(dpy, w, ctypes.byref(a))
    return a if ok and x_errors[0] == before else None


def window_matches(w):
    if args.window_name:
        name = ctypes.c_void_p()
        if X.XFetchName(dpy, w, ctypes.byref(name)) and name.value:
            hit = args.window_name.lower() in ctypes.string_at(name.value).decode("utf-8", "replace").lower()
            X.XFree(name.value)
            return hit
        return False
    hint = XClassHint()
    if not X.XGetClassHint(dpy, w, ctypes.byref(hint)):
        return False
    want = args.process_name.lower() + ".exe"
    hit = False
    for ptr in (hint.res_name, hint.res_class):
        if ptr:
            hit = hit or ctypes.string_at(ptr).decode("utf-8", "replace").lower() == want
            X.XFree(ptr)
    return hit


def find_window():
    """The largest viewable window of the game (skips launchers, crash reporters, tooltips)."""
    best, area = None, 0
    for w in client_list():
        if not window_matches(w):
            continue
        a = attrs(w)
        if a and a.map_state == IS_VIEWABLE and a.width * a.height > area:
            best, area = w, a.width * a.height
    return best


def keep_composited(w):
    val = ctypes.c_ulong(2)
    X.XChangeProperty(dpy, w, A_BYPASS, A_CARDINAL, 32, 0, ctypes.byref(val), 1)
    X.XFlush(dpy)


def mask_shift(mask):
    s = 0
    while mask and not (mask >> s) & 1:
        s += 1
    return s, (mask >> s) if mask else 1


def grab(w):
    """Capture the strip region of window w from the root window (what is on screen)."""
    a = attrs(w)
    if not a or a.map_state != IS_VIEWABLE:
        return None
    rx, ry, child = ctypes.c_int(), ctypes.c_int(), Window()
    before = x_errors[0]
    X.XTranslateCoordinates(dpy, w, root, 0, 0, ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(child))
    ra = attrs(root)
    if x_errors[0] != before or not ra:
        return None
    x0, y0 = max(0, rx.value), max(0, ry.value)
    gw = min(GRAB_W, a.width, ra.width - x0)
    gh = min(GRAB_H, a.height, ra.height - y0)
    if gw <= 0 or gh <= 0:
        return None
    img = X.XGetImage(dpy, root, x0, y0, gw, gh, ALL_PLANES, ZPIXMAP)
    X.XSync(dpy, 0)
    if not img or x_errors[0] != before:
        return None
    im = img.contents
    try:
        if im.bits_per_pixel not in (24, 32):
            return {"error": "unsupported pixel format: %d bpp" % im.bits_per_pixel, "kind": "capture_unsupported"}
        size = im.bytes_per_line * im.height
        buf = ctypes.string_at(im.data, size)
        bpp = im.bits_per_pixel // 8
        stride = im.bytes_per_line
        order = "little" if im.byte_order == 0 else "big"
        chans = [mask_shift(m) for m in (im.red_mask, im.green_mask, im.blue_mask)]
        width, height = im.width, im.height
    finally:
        destroy = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(XImage))(im.destroy_image)
        destroy(img)

    def px(x, y):
        o = y * stride + x * bpp
        v = int.from_bytes(buf[o:o + bpp], order)
        return tuple(((v >> s) & m) * 255 // m for s, m in chans)
    return px, width, height


def run():
    if args.probe:
        w = find_window()
        if not w:
            emit({"error": "no game window found", "kind": "window_not_found"})
            sys.exit(1)
        if args.keep_composited:
            keep_composited(w)
            time.sleep(0.5)
        g = grab(w)
        if not g or isinstance(g, dict):
            emit(g or {"error": "capture failed"})
            sys.exit(1)
        px, width, height = g
        write_png(args.probe, px, width, height)
        emit(dict({"info": "saved %dx%d to %s" % (width, height, args.probe)}, **probe_decode(px, width, height)))
        return

    last_key = None
    last_warn = 0.0
    last_measure = 0.0  # the pitch search runs at most once a second while nothing decodes
    win = None
    hint = None
    game = GameTracker()
    errors = ErrorLimiter()
    search = SearchBackoff()

    def error(kind, text):
        if errors.set(kind, time.time()):
            emit({"error": text, "kind": kind})

    while True:
        if win is None:
            win = find_window()
            if win is None:
                for ev in game.missing(time.time()):
                    emit(ev)
                # "waiting for ... window" is what the Linux docs tell players to look for.
                error("window_not_found", "waiting for %s window (the game isn't running, or its window has another name)"
                      % (args.window_name or args.process_name))
                time.sleep(search.missed())
                continue
            search.found()
            if args.keep_composited:
                keep_composited(win)
            a = attrs(win)
            pid = window_pid(win)
            for ev in game.found(pid, time.time()):
                emit(ev)
            emit({"info": "attached to window 0x%x (%dx%d)" % (win, a.width if a else 0, a.height if a else 0),
                  "window": {"pid": pid, "width": a.width if a else 0, "height": a.height if a else 0}})
            hint = None
        g = grab(win)
        if g is None:
            a = attrs(win)
            if a is None:  # destroyed: look for it again
                win = None
            elif a.map_state != IS_VIEWABLE:
                error("window_minimized", "World of Warcraft is minimized; restore it to keep chatting")
            time.sleep(1)
            continue
        if isinstance(g, dict):
            error(g.get("kind", "capture_unsupported"), g["error"])
            time.sleep(5)
            continue
        if errors.clear():
            emit({"info": "capturing"})
        px, width, height = g
        measure = time.time() - last_measure >= 1.0
        msg, hint = find_and_decode(px, width, height, hint, measure)
        if args.pitch_search and measure and not (msg and not msg.get("error")):
            last_measure = time.time()
        if msg and msg.get("error"):
            if time.time() - last_warn >= 5:
                last_warn = time.time()
                emit({"warn": "strip seen but rejected: " + msg["error"]})
        elif msg:
            key = "%d:%s" % (msg["id"], msg["text"])
            if key != last_key:
                last_key = key
                emit(msg)
        time.sleep(args.interval_ms / 1000.0)


def main(argv=None):
    configure(build_parser().parse_args(argv))
    if args.test_image:
        return test_image_main()
    if not init_x11():
        return 3
    try:
        run()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    # The bridge reads UTF-8 lines whatever this system's locale is: a record's text may hold any
    # character, which a C, Latin-1 or cp1252 stdout can't write (it raised UnicodeEncodeError).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.exit(main())
