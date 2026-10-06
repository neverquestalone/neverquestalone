"""capture_x11.py's --magic, --pitch-search, --probe verdict, typed errors and game
lifecycle (PRD §11.1, §11.3, PF-7), as unit tests.

Run by tests/byok/capture_x11_test.mjs (python3 tests/byok/capture_x11_test.py).
Imports the script as a module (its X11 setup only runs from main()), builds
strips in memory with the same frame layout as the addon's Codec.lua, and
decodes them through the script's own functions. No display, no packages.
"""

import argparse
import importlib.util
import math
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "bridge", "capture_x11.py")
_spec = importlib.util.spec_from_file_location("capture_x11", SCRIPT)
cx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cx)


def frame_cells(frame_id, payload, magic):
    data = bytes([magic[0], magic[1], frame_id >> 8, frame_id & 255, len(payload) >> 8, len(payload) & 255]) + payload
    s1 = s2 = 0
    for b in data[2:]:
        s1 = (s1 + b) % 255
        s2 = (s2 + s1) % 255
    data += bytes([s1, s2])
    cells, acc, nbits = [], 0, 0
    for b in data:
        acc = (acc << 8) | b
        nbits += 8
        while nbits >= 3:
            cells.append((acc >> (nbits - 3)) & 7)
            nbits -= 3
            acc &= (1 << nbits) - 1
    if nbits:
        cells.append((acc << (3 - nbits)) & 7)
    return cells


def image(cells, pitch, x0=0, y0=0, width=1300, height=320, cells_per_row=200):
    """Point-sampled rendering: each pixel shows the cell under its center."""
    def px(x, y):
        c = int(math.floor((x + 0.5 - x0) / pitch))
        r = int(math.floor((y + 0.5 - y0) / pitch))
        if x < x0 or y < y0 or c >= cells_per_row or c < 0 or r < 0:
            return (0x30, 0x2A, 0x26)
        i = r * cells_per_row + c
        v = cells[i] if i < len(cells) else 0
        return (255 if v & 4 else 0, 255 if v & 2 else 0, 255 if v & 1 else 0)
    return px, width, height


def use(argv):
    cx.configure(cx.build_parser().parse_args(argv))


class ParseMagic(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(cx.parse_magic("C72C"), (0xC7, 0x2C))
        self.assertEqual(cx.parse_magic("c71a"), (0xC7, 0x1A))
        self.assertEqual(cx.parse_magic("0xC72C"), (0xC7, 0x2C))
        self.assertEqual(cx.parse_magic(" C7 2C "), (0xC7, 0x2C))

    def test_rejects(self):
        for bad in ("", "C72", "C72C0", "XYZW", "0x", "C7-2C"):
            with self.assertRaises(ValueError, msg=bad):
                cx.parse_magic(bad)

    def test_argparse_default_is_nqa(self):
        a = cx.build_parser().parse_args([])
        self.assertEqual(a.magic, (0xC7, 0x2C))
        self.assertFalse(a.pitch_search)
        self.assertEqual((a.min_pitch, a.max_pitch), (3.0, 6.0))

    def test_argparse_upstream_magic_stays_reachable(self):
        self.assertEqual(cx.build_parser().parse_args(["--magic", "C71A"]).magic, (0xC7, 0x1A))

    def test_argparse_rejects_bad_magic(self):
        parser = cx.build_parser()
        parser.error = lambda msg: (_ for _ in ()).throw(argparse.ArgumentError(None, msg))
        with self.assertRaises(argparse.ArgumentError):
            parser.parse_args(["--magic", "nope"])

    def test_configure_sets_the_magic_everywhere(self):
        use(["--magic", "C71A"])
        self.assertEqual(cx.MAGIC, (0xC7, 0x1A))
        self.assertEqual(cx.MAGIC16, 0xC71A)
        use([])
        self.assertEqual(cx.MAGIC16, 0xC72C)


class Decode(unittest.TestCase):
    def tearDown(self):
        use([])

    def test_default_magic_decodes_nqa_and_not_upstream(self):
        use([])
        text = "hello ✓".encode("utf-8")
        px, w, h = image(frame_cells(7, text, (0xC7, 0x2C)), 4)
        msg, hint = cx.find_and_decode(px, w, h, None)
        self.assertEqual(msg, {"id": 7, "text": "hello ✓"})
        self.assertEqual(hint, (0, 0, 4))
        px, w, h = image(frame_cells(7, text, (0xC7, 0x1A)), 4)
        self.assertEqual(cx.find_and_decode(px, w, h, None)[0], None)

    def test_upstream_magic_with_flag(self):
        use(["--magic", "C71A"])
        px, w, h = image(frame_cells(9, b"v1 strip", (0xC7, 0x1A)), 4)
        self.assertEqual(cx.find_and_decode(px, w, h, None)[0], {"id": 9, "text": "v1 strip"})
        self.assertTrue(cx.has_magic(px, 0, 0))

    def test_checksum_rejected(self):
        use([])
        cells = frame_cells(3, b"checksum victim", (0xC7, 0x2C))
        cells[30] ^= 5
        px, w, h = image(cells, 4)
        self.assertEqual(cx.find_and_decode(px, w, h, None)[0], {"error": "checksum"})

    def test_other_pitches_need_pitch_search(self):
        payload = ("z" * 700).encode()
        for pitch in (3, 3.5, 5, 5.4, 6):
            with self.subTest(pitch=pitch):
                px, w, h = image(frame_cells(11, payload, (0xC7, 0x2C)), pitch, x0=2, y0=1)
                use([])
                self.assertNotIn("text", cx.find_and_decode(px, w, h, None)[0] or {})  # nothing, or a reject
                use(["--pitch-search"])
                msg, hint = cx.find_and_decode(px, w, h, None)
                self.assertEqual(msg, {"id": 11, "text": payload.decode()})
                self.assertAlmostEqual(hint[2], pitch, delta=0.05)
                # The measured geometry is reused on the next frame.
                self.assertEqual(cx.find_and_decode(px, w, h, hint), (msg, hint))

    def test_measuring_can_be_skipped_between_searches(self):
        use(["--pitch-search"])
        px, w, h = image(frame_cells(13, b"measured later", (0xC7, 0x2C)), 5)
        self.assertNotIn("text", cx.find_and_decode(px, w, h, None, measure=False)[0] or {})
        self.assertEqual(cx.find_and_decode(px, w, h, None, measure=True)[0], {"id": 13, "text": "measured later"})

    def test_pitch_search_stays_in_range(self):
        use(["--pitch-search"])
        px, w, h = image(frame_cells(12, b"too big", (0xC7, 0x2C)), 8, width=1700)
        self.assertIsNone(cx.find_and_decode(px, w, h, None)[0])

    def test_grab_region_covers_the_widest_pitch(self):
        use(["--pitch-search"])
        self.assertGreaterEqual(cx.GRAB_W, 200 * 6)
        self.assertGreaterEqual(cx.GRAB_H, 48 * 6)
        use([])
        self.assertEqual((cx.GRAB_W, cx.GRAB_H), (800 + cx.SLACK, 192 + cx.SLACK))


class Probe(unittest.TestCase):
    """npm run probe runs with the default magic; it must still answer for a wow-ai strip."""

    def tearDown(self):
        use([])

    def test_the_configured_magic_first(self):
        use([])
        px, w, h = image(frame_cells(4, b"claw", (0xC7, 0x2C)), 4)
        self.assertEqual(cx.probe_decode(px, w, h), {"strip": {"id": 4, "text": "claw"}, "offset": (0, 0, 4), "magic": "C72C"})

    def test_a_wow_ai_strip_is_found_and_named(self):
        use([])
        px, w, h = image(frame_cells(5, b"upstream", (0xC7, 0x1A)), 4)
        out = cx.probe_decode(px, w, h)
        self.assertEqual(out["strip"], {"id": 5, "text": "upstream"})
        self.assertEqual(out["magic"], "C71A")
        self.assertIn("--magic C71A", out["note"])
        self.assertEqual(cx.MAGIC16, 0xC72C, "the configured magic is put back")

    def test_and_the_other_way_round(self):
        use(["--magic", "C71A"])
        px, w, h = image(frame_cells(6, b"claw", (0xC7, 0x2C)), 4)
        out = cx.probe_decode(px, w, h)
        self.assertEqual((out["strip"], out["magic"]), ({"id": 6, "text": "claw"}, "C72C"))
        self.assertEqual(cx.MAGIC16, 0xC71A)

    def test_nothing_is_nothing(self):
        use([])
        px, w, h = image([], 4)
        out = cx.probe_decode(px, w, h)
        self.assertEqual((out["strip"], out["magic"]), (None, "C72C"))
        self.assertNotIn("note", out)


class Errors(unittest.TestCase):
    def test_said_once_a_minute_per_kind_however_often_it_flaps(self):
        e = cx.ErrorLimiter()
        self.assertTrue(e.set("access_lost", 0))
        self.assertTrue(e.clear())             # "capturing"
        for t in (5, 10, 30, 59):              # comes and goes within the minute
            self.assertFalse(e.set("access_lost", t))
            self.assertFalse(e.clear())
        self.assertTrue(e.set("access_lost", 60))
        self.assertTrue(e.set("window_not_found", 61))   # another kind has its own minute
        self.assertFalse(e.set("window_not_found", 90))
        self.assertTrue(e.clear())
        self.assertFalse(e.clear())

    def test_a_held_error_repeats_once_a_minute(self):
        e = cx.ErrorLimiter()
        said = [t for t in range(0, 200, 3) if e.set("window_not_found", t)]
        self.assertEqual(said, [0, 60, 120, 180])


class Game(unittest.TestCase):
    def test_absent_then_launched_then_exited(self):
        dead = set()
        g = cx.GameTracker(alive=lambda pid: pid not in dead)
        self.assertEqual(g.missing(0), [{"game": "absent"}])
        self.assertEqual(g.missing(3), [])
        self.assertEqual(g.found(4242, 6), [{"game": "launched", "pid": 4242}])
        self.assertEqual(g.found(4242, 7), [])                 # the same window, found again
        self.assertEqual(g.missing(8), [])                     # window away, process alive
        self.assertEqual(g.found(4242, 9), [])
        dead.add(4242)
        self.assertEqual(g.missing(10), [{"game": "exited", "pid": 4242}])
        self.assertEqual(g.missing(13), [])
        self.assertEqual(g.found(5000, 20), [{"game": "launched", "pid": 5000}])

    def test_running_at_start(self):
        g = cx.GameTracker(alive=lambda pid: True)
        self.assertEqual(g.found(77, 0), [{"game": "running", "pid": 77}])

    def test_no_pid_waits_out_the_grace(self):
        g = cx.GameTracker(alive=lambda pid: self.fail("no pid to check"), grace=10)
        self.assertEqual(g.found(None, 0), [{"game": "running"}])
        self.assertEqual(g.missing(1), [])
        self.assertEqual(g.found(None, 5), [])                 # back within the grace: nothing
        self.assertEqual(g.missing(6), [])
        self.assertEqual(g.missing(15), [])
        self.assertEqual(g.missing(16), [{"game": "exited"}])
        self.assertEqual(g.missing(30), [])

    def test_a_new_game_after_the_old_one_died_unseen(self):
        dead = set()
        g = cx.GameTracker(alive=lambda pid: pid not in dead)
        g.found(10, 0)
        dead.add(10)
        self.assertEqual(g.found(11, 1), [{"game": "exited", "pid": 10}, {"game": "launched", "pid": 11}])

    def test_proc_confirms_the_pid_is_the_game(self):
        with tempfile.TemporaryDirectory() as proc:
            def fake(pid, cmdline, comm):
                os.makedirs(os.path.join(proc, str(pid)))
                with open(os.path.join(proc, str(pid), "cmdline"), "wb") as fh:
                    fh.write(cmdline)
                with open(os.path.join(proc, str(pid), "comm"), "wb") as fh:
                    fh.write(comm)
            fake(100, b"C:\\Program Files\\World of Warcraft\\_classic_beta_\\WowB.exe\0-launcherlogin\0", b"WowB.exe\n")
            fake(200, b"/usr/bin/bash\0", b"bash\n")
            self.assertTrue(cx.proc_is_game(100, "WowB", proc))
            self.assertTrue(cx.proc_is_game(100, ".exe", proc))
            self.assertFalse(cx.proc_is_game(200, "WowB", proc))   # another namespace's pid, say
            self.assertFalse(cx.proc_is_game(300, "WowB", proc))   # no such process


class Search(unittest.TestCase):
    """Code health BR-15 (PF-09): the window search backs off while the game stays closed."""

    def test_doubles_to_a_minute_while_none_is_found_and_starts_over_once_one_is(self):
        b = cx.SearchBackoff()
        self.assertEqual([b.missed() for _ in range(7)], [3.0, 6.0, 12.0, 24.0, 48.0, 60.0, 60.0])
        b.found()
        self.assertEqual([b.missed(), b.missed()], [3.0, 6.0])


class Loop(unittest.TestCase):
    """run() with X11 replaced by a scripted world: the lines a player's session produces."""

    class Stop(Exception):
        pass

    def setUp(self):
        use([])
        self.saved = {k: getattr(cx, k) for k in ("emit", "find_window", "grab", "attrs", "window_pid", "pid_alive", "time")}

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(cx, k, v)
        use([])

    def test_a_session(self):
        strip = image(frame_cells(7, "hello ✓".encode(), (0xC7, 0x2C)), 4)
        viewable, unmapped = 2, 0
        # One world state per loop turn: (window or None, its map state, grab result).
        world = [
            (None, None, None),              # the game isn't running yet
            (None, None, None),
            (0x10, viewable, strip),         # launched: attach, decode
            (0x10, unmapped, None),          # minimized
            (0x10, viewable, strip),         # restored: "capturing", the same payload isn't repeated
            ("gone", None, None),            # the window is destroyed
            (None, None, None),              # ...and the process has ended
        ]
        out, clock, dead = [], [0.0], set()
        state = {"i": 0}

        def now_state():
            return world[state["i"]]

        class FakeTime:
            @staticmethod
            def time():
                return clock[0]

            @staticmethod
            def sleep(sec):
                clock[0] += sec
                state["i"] += 1
                if state["i"] == 6:
                    dead.add(4242)
                if state["i"] >= len(world):
                    raise Loop.Stop()

        class Attrs:
            def __init__(self, m):
                self.width, self.height, self.map_state = 1920, 1080, m

        cx.emit = out.append
        cx.time = FakeTime
        cx.find_window = lambda: now_state()[0] if now_state()[0] not in (None, "gone") else None
        cx.attrs = lambda w: Attrs(now_state()[1]) if now_state()[0] not in (None, "gone") else None
        cx.grab = lambda w: now_state()[2] if now_state()[1] == viewable else None
        cx.window_pid = lambda w: 4242
        cx.pid_alive = lambda pid: pid not in dead
        with self.assertRaises(Loop.Stop):
            cx.run()
        wait = "waiting for WowB window (the game isn't running, or its window has another name)"
        self.assertEqual(out, [
            {"game": "absent"},
            {"error": wait, "kind": "window_not_found"},
            {"game": "launched", "pid": 4242},
            {"info": "attached to window 0x10 (1920x1080)", "window": {"pid": 4242, "width": 1920, "height": 1080}},
            {"info": "capturing"},           # the window_not_found that was said has cleared
            {"id": 7, "text": "hello ✓"},
            {"error": "World of Warcraft is minimized; restore it to keep chatting", "kind": "window_minimized"},
            {"info": "capturing"},
            {"game": "exited", "pid": 4242},
        ])


    def test_the_search_waits_longer_while_the_game_stays_closed(self):
        strip = image(frame_cells(7, "hi".encode(), (0xC7, 0x2C)), 4)
        world = [None] * 8 + [0x10, "gone", None, None]
        sleeps, clock, state = [], [0.0], {"i": 0}

        class FakeTime:
            @staticmethod
            def time():
                return clock[0]

            @staticmethod
            def sleep(sec):
                sleeps.append(sec)
                clock[0] += sec
                state["i"] += 1
                if state["i"] >= len(world):
                    raise Loop.Stop()

        class Attrs:
            width, height, map_state = 1920, 1080, 2

        here = lambda: world[state["i"]] not in (None, "gone")
        cx.emit = lambda line: None
        cx.time = FakeTime
        cx.find_window = lambda: world[state["i"]] if here() else None
        cx.attrs = lambda w: Attrs() if here() else None
        cx.grab = lambda w: strip if here() else None
        cx.window_pid = lambda w: 4242
        cx.pid_alive = lambda pid: False
        with self.assertRaises(Loop.Stop):
            cx.run()
        # Closed: 3, 6, 12... at most a minute; the window: one frame; gone: a second's look, then 3 s again.
        self.assertEqual(sleeps, [3.0, 6.0, 12.0, 24.0, 48.0, 60.0, 60.0, 60.0, 0.25, 1, 3.0, 6.0])

if __name__ == "__main__":
    unittest.main(verbosity=1)
