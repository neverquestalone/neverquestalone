/* nqa-capture.exe: the Windows capture helper (PRD §11.3, DB11; PF-1; K5).
 *
 * Finds World of Warcraft's top-level window: a Wow*.exe in one of the game's
 * flavor folders the bridge names, never an addon manager like WowUp.exe or the
 * game's own voice proxy and crash reporter (winpick.c, display DR-05), looked
 * for again every 5 s while attached. Takes the client area's top-left corner
 * from DXGI Desktop Duplication on the monitor that shows it, decodes the addon's
 * strip (decoder.c, the macOS decoder ported) and writes JSON lines to its
 * stdout, which the bridge reads through the pipe it spawned it with. An
 * anonymous pipe has no name another process could find, so there is no token,
 * hello or server check (systems plan Batch 1, SY-07).
 *
 * The crop starts at 900 x 300 physical pixels (--width, --height) and grows to
 * hold a whole strip at the cell pitch the decoder measures (wc_crop_size): a
 * scaled window with 5 px cells needs about 1008 x 248, with 6.5 px cells about
 * 1308 x 320. It follows the last measurement, and starts over on a new window.
 *
 * Lifetime: capture follows the game. Duplication is opened when the window is
 * found and released when it is gone or the game exits ({"game":"exited"}). In
 * between the helper holds no capture objects and doesn't poll (systems critic
 * SY-30): it sleeps until a top-level window is shown anywhere on the desktop (a
 * WinEvent hook, out of context: no DLL, no admin), then looks for the game's
 * window once; a look every ABSENT_RESCAN_MS (30 s) backs the hook up, and
 * without the hook it looks every ABSENT_SLEEP_MS (2 s). No stats line and no
 * repeated error reach the bridge while the game is closed, so nothing wakes it
 * either. The process itself stays until the bridge goes: its stdin is a pipe
 * the bridge never writes to, read by a thread, and end of file there (the
 * bridge quit or crashed) or a failed write to stdout ends the helper at once.
 * On Windows the helper is what sees the game start (the bridge has no cheaper
 * way).
 *
 * Output lines, the same contract as the macOS app and capture_x11.py:
 *   {"info":...} {"warn":...}                    status (rejects rate-limited)
 *   {"error":"<plain line>","kind":"<kind>"}     (at most once a minute per kind) window_not_found (once
 *                                                each time the window goes), window_minimized,
 *                                                capture_blocked_by_app, access_lost,
 *                                                capture_unsupported
 *   {"info":"capturing","cleared":true}          once, when a frame decodes again after an error
 *   {"away":"locked"} / {"away":null}            the lock screen or a UAC prompt holds capture (DR-26):
 *                                                on every change, at most once a second, never
 *                                                through the limiter above, and once at the start
 *   {"game":"running|launched|exited|absent","pid":N}   ("running" again when it moves to a better window)
 *   {"window":{...,"dpiAwareness"}}              on attach, and on every move to another window
 *   {"info":...,"region":{"width","height"}}     when the crop changes to fit the strip
 *   {"id":N,"text":"...","bytes":N}              once per distinct payload
 *   {"stats":{...}}                              every --stats-sec while a game window is found
 *
 * Per-Monitor-v2 DPI aware (manifest, and SetProcessDpiAwarenessContext as a
 * backstop), so window and desktop coordinates are physical pixels. No network
 * code. The --log file holds counts, timings and typed errors, never record
 * text. DDA captures what is on screen, so a window covering the corner hides
 * the strip (it decodes nothing; nothing leaves the helper but validated strip
 * payloads).
 *
 *   nqa-capture.exe [--process-name Wow*] --flavor-dir _forever_ [--flavor-dir ...]
 *       [--not-game VoiceProxy ...] [--exe-dir DIR] [--width 900] [--height 300]
 *       [--interval-ms 250] [--magic C72C] [--stats-sec 60] [--log FILE]
 *                                               lines to stdout; exits when stdin (a pipe) ends
 *   (with no --flavor-dir no window is the game's: the folders are the bridge's data, never guessed)
 *   nqa-capture.exe --test-image a.ppm      decode one PPM and exit (no capture API)
 *   nqa-capture.exe --test-desktop          say which desktop has the input now, and exit
 *   nqa-capture.exe --version
 * --stdout is still accepted and changes nothing (rig notes used it). */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "decoder.h"
#include "errlimit.h"
#include "jsonl.h"
#include "ppm.h"
#include "winpick.h"

#define WC_VERSION "0.2.0"
#define WC_PROTO 2
#define MAX_NAMES WC_PICK_LIST
#define PATH_UTF8 3200 /* a 1024-character Windows path in UTF-8, with room */
#define RESCAN_MS 5000 /* while attached, how often a better window is looked for (DR-05) */
#define LINE_CAP (1 << 16)
#define LOG_MAX_BYTES (2 * 1024 * 1024)
/* While no game window is found (SY-30): a look after each top-level window shown on the desktop
 * (once it has had ABSENT_SETTLE_MS to size itself), and every ABSENT_RESCAN_MS whatever happens;
 * every ABSENT_SLEEP_MS instead when the hook can't be set. The game takes far longer than any of
 * these to reach its login screen. */
#define ABSENT_RESCAN_MS 30000
#define ABSENT_SLEEP_MS 2000
#define ABSENT_SETTLE_MS 250

#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

typedef struct {
  char names[MAX_NAMES][192];            /* --process-name patterns, UTF-8, without ".exe" */
  int nnames;
  char flavors[WC_PICK_LIST][64];        /* --flavor-dir */
  char not_game[WC_PICK_LIST][64];       /* --not-game */
  char exe_dir[PATH_UTF8];               /* --exe-dir, or "" */
  wc_pick_rules rules;                   /* the above, for winpick.c */
  int width, height, interval_ms, stats_sec;
  wc_spec spec;
  char magic_text[16];
  const wchar_t *log_path;
  const wchar_t *test_image;
  int version;
  int test_desktop;
} options;

static HANDLE g_out = INVALID_HANDLE_VALUE;
static HANDLE g_parent = NULL; /* stdin, when it is the bridge's pipe: its end means the bridge is gone */
static HANDLE g_gone = NULL;   /* set by watch_stdin when that pipe ends */
static volatile LONG g_watch_failed = 0; /* watch_stdin couldn't read the pipe: parent_alive() peeks */
static volatile LONG g_shown = 0;        /* a top-level window was shown since the last look (SY-30) */
static HANDLE g_log = INVALID_HANDLE_VALUE;
static char g_line[LINE_CAP];
static wc_result g_result;

/* ------------------------------------------------------------------ output */

static int write_all(HANDLE h, const char *s, size_t n) {
  while (n > 0) {
    DWORD w = 0;
    if (!WriteFile(h, s, (DWORD)n, &w, NULL) || w == 0) return -1;
    s += w;
    n -= w;
  }
  return 0;
}

static void log_raw(const char *line) {
  SYSTEMTIME t;
  /* Room for any WORD values (44 bytes), though SYSTEMTIME's fit in 26: MinGW gcc's -Werror
     format-truncation check sizes the buffer by the argument types (windows-smoke builds with it). */
  char stamp[48];
  if (g_log == INVALID_HANDLE_VALUE) return;
  GetSystemTime(&t);
  snprintf(stamp, sizeof stamp, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ ", t.wYear, t.wMonth, t.wDay, t.wHour,
           t.wMinute, t.wSecond, t.wMilliseconds);
  write_all(g_log, stamp, strlen(stamp));
  write_all(g_log, line, strlen(line));
}

/* Send a finished line to the bridge; log it too unless it carries record text. */
static void send_line(const char *line, int log_it) {
  if (write_all(g_out, line, strlen(line)) != 0) {
    log_raw("{\"info\":\"the bridge stopped reading; exiting\"}\n");
    ExitProcess(0);
  }
  if (log_it) log_raw(line);
}

static void emit_simple(const char *key, const char *text, const char *kind) {
  wc_json j;
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, key, 1);
  wc_json_cstr(&j, text);
  if (kind) {
    wc_json_key(&j, "kind", 0);
    wc_json_cstr(&j, kind);
  }
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) send_line(g_line, 1);
}

static void emit_warn(const char *text) { emit_simple("warn", text, NULL); }

/* Typed errors: said when they start, then at most once a minute per kind, even
 * when the condition comes and goes in between (errlimit.c). */
static wc_errlimit g_errors;

/* Returns 1 when the line went out (0: said within the minute). */
static int set_error(const char *kind, const char *text) {
  if (!wc_errlimit_set(&g_errors, kind, GetTickCount64())) return 0;
  emit_simple("error", text, kind);
  return 1;
}

/* The session's lock (DR-26, winpick.c): said on its own line, never through the limiter. */
static wc_away g_away;

static void say_away(void) {
  if (wc_away_due(&g_away, GetTickCount64()))
    send_line(g_away.locked ? "{\"away\":\"locked\"}\n" : "{\"away\":null}\n", 1);
}

/* Which desktop has the input: "Default" while the player's desktop is up; the lock screen and a
 * UAC prompt run on "Winlogon", which a normal process can't open at all. */
static wc_desk input_desktop(wchar_t *name, DWORD cap_bytes) {
  DWORD need = 0;
  BOOL ok;
  HDESK h = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (name && cap_bytes >= sizeof(wchar_t)) name[0] = L'\0';
  if (!h) return WC_DESK_UNOPENABLE;
  ok = name && GetUserObjectInformationW(h, UOI_NAME, name, cap_bytes, &need);
  CloseDesktop(h);
  if (!ok) return WC_DESK_OTHER;
  return _wcsicmp(name, L"Default") == 0 ? WC_DESK_DEFAULT : WC_DESK_OTHER;
}

/* One line the bridge can act on: the error it was told about no longer holds. */
static void clear_error(void) {
  if (wc_errlimit_clear(&g_errors)) send_line("{\"info\":\"capturing\",\"cleared\":true}\n", 1);
}

static void emit_game(const char *state, DWORD pid) {
  wc_json j;
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "game", 1);
  wc_json_cstr(&j, state);
  if (pid) {
    wc_json_key(&j, "pid", 0);
    wc_json_int(&j, (long long)pid);
  }
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) send_line(g_line, 1);
}

static void to_utf8(const wchar_t *w, char *out, int cap) {
  if (!WideCharToMultiByte(CP_UTF8, 0, w, -1, out, cap, NULL, NULL)) out[0] = '\0';
}

/* ------------------------------------------------------------------ options */

static int parse_int(const wchar_t *s, int lo, int hi, int *out) {
  wchar_t *end = NULL;
  long v = wcstol(s, &end, 10);
  if (!end || *end || v < lo || v > hi) return -1;
  *out = (int)v;
  return 0;
}

/* "WowB,Wow*" -> names without ".exe", in UTF-8; '*' is a wildcard. */
static int parse_names(const wchar_t *s, options *o) {
  o->nnames = 0;
  while (*s) {
    wchar_t one[64];
    size_t n = 0;
    while (s[n] && s[n] != L',') n++;
    if (n > 0) {
      if (o->nnames == MAX_NAMES || n >= 64) return -1;
      wmemcpy(one, s, n);
      one[n] = L'\0';
      if (n > 4 && _wcsicmp(one + n - 4, L".exe") == 0) one[n - 4] = L'\0';
      to_utf8(one, o->names[o->nnames], (int)sizeof o->names[0]);
      if (!o->names[o->nnames][0]) return -1;
      o->nnames++;
    }
    s += n;
    if (*s == L',') s++;
  }
  return o->nnames > 0 ? 0 : -1;
}

/* A --flavor-dir or --not-game value: 1 to 63 bytes of UTF-8, a name, not a path. */
static int parse_word(const wchar_t *v, char *out, size_t cap) {
  if (!v[0] || wcslen(v) >= cap || wcschr(v, L'\\') || wcschr(v, L'/')) return -1;
  to_utf8(v, out, (int)cap);
  return out[0] ? 0 : -1;
}

static int usage(const char *why) {
  fprintf(stderr, "nqa-capture: %s\n", why);
  fprintf(stderr, "usage: nqa-capture.exe [--process-name Wow*] --flavor-dir _forever_ [--flavor-dir ...] [--not-game Error ...]\n"
                  "       [--exe-dir DIR] [--width 900] [--height 300] [--interval-ms 250]\n"
                  "       [--magic C72C] [--stats-sec 60] [--log FILE]   (JSON lines to stdout; exits when stdin ends)\n"
                  "       nqa-capture.exe --test-image FILE.ppm | --version\n");
  return 2;
}

static int parse_options(int argc, wchar_t **argv, options *o) {
  int i;
  memset(o, 0, sizeof *o);
  wc_spec_default(&o->spec);
  strcpy(o->magic_text, "C72C");
  o->width = 900;
  o->height = 300;
  o->interval_ms = 250;
  o->stats_sec = 60;
  parse_names(L"Wow*", o); /* any Wow*.exe; the window filter (at least 200 x 150, the largest) picks the game */
  for (i = 1; i < argc; i++) {
    const wchar_t *a = argv[i];
    const wchar_t *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (wcscmp(a, L"--version") == 0) { o->version = 1; continue; }
    if (wcscmp(a, L"--test-desktop") == 0) { o->test_desktop = 1; continue; }
    if (wcscmp(a, L"--stdout") == 0) continue; /* always stdout now */
    if (wcscmp(a, L"--pipe") == 0 || wcscmp(a, L"--token") == 0 || wcscmp(a, L"--bridge-pid") == 0)
      return usage("--pipe, --token and --bridge-pid are gone: the helper writes to stdout (0.2.0)");
    if (!v) return usage("missing value");
    i++;
    if (wcscmp(a, L"--process-name") == 0) {
      if (parse_names(v, o) != 0) return usage("bad --process-name");
    } else if (wcscmp(a, L"--flavor-dir") == 0) {
      if (o->rules.nflavors == WC_PICK_LIST || parse_word(v, o->flavors[o->rules.nflavors], sizeof o->flavors[0]) != 0)
        return usage("bad --flavor-dir (a folder's name, like _forever_)");
      o->rules.nflavors++;
    } else if (wcscmp(a, L"--not-game") == 0) {
      if (o->rules.nnot_game == WC_PICK_LIST || parse_word(v, o->not_game[o->rules.nnot_game], sizeof o->not_game[0]) != 0)
        return usage("bad --not-game (part of an exe's name, like VoiceProxy)");
      o->rules.nnot_game++;
    } else if (wcscmp(a, L"--exe-dir") == 0) {
      wchar_t full[1024];
      DWORD got;
      if (!v[0] || wcslen(v) >= 1024) return usage("bad --exe-dir");
      /* In 8.3 short names (a "~", as %TEMP% often is), its long names, as the game's image path gets
         them (image_path), so the two compare. */
      got = wcschr(v, L'~') ? GetLongPathNameW(v, full, (DWORD)(sizeof full / sizeof full[0])) : 0;
      to_utf8(got > 0 && got < (DWORD)(sizeof full / sizeof full[0]) ? full : v, o->exe_dir, (int)sizeof o->exe_dir);
    } else if (wcscmp(a, L"--width") == 0) {
      if (parse_int(v, 64, 8192, &o->width) != 0) return usage("bad --width");
    } else if (wcscmp(a, L"--height") == 0) {
      if (parse_int(v, 16, 8192, &o->height) != 0) return usage("bad --height");
    } else if (wcscmp(a, L"--interval-ms") == 0) {
      if (parse_int(v, 50, 10000, &o->interval_ms) != 0) return usage("bad --interval-ms");
    } else if (wcscmp(a, L"--stats-sec") == 0) {
      if (parse_int(v, 1, 86400, &o->stats_sec) != 0) return usage("bad --stats-sec");
    } else if (wcscmp(a, L"--magic") == 0) {
      char m[16];
      to_utf8(v, m, (int)sizeof m);
      if (wc_parse_magic(m, o->spec.magic) != 0) return usage("--magic must be 4 hex digits, e.g. C72C");
      snprintf(o->magic_text, sizeof o->magic_text, "%02X%02X", o->spec.magic[0], o->spec.magic[1]);
    } else if (wcscmp(a, L"--log") == 0) {
      o->log_path = v;
    } else if (wcscmp(a, L"--test-image") == 0) {
      o->test_image = v;
    } else {
      return usage("unknown option");
    }
  }
  {
    int k;
    for (k = 0; k < o->nnames; k++) o->rules.names[k] = o->names[k];
    o->rules.nnames = o->nnames;
    for (k = 0; k < o->rules.nflavors; k++) o->rules.flavors[k] = o->flavors[k];
    for (k = 0; k < o->rules.nnot_game; k++) o->rules.not_game[k] = o->not_game[k];
    o->rules.exe_dir = o->exe_dir[0] ? o->exe_dir : NULL;
  }
  return 0;
}

/* ------------------------------------------------------------------ DPI */

typedef BOOL(WINAPI *set_dpi_ctx_fn)(HANDLE);
typedef HANDLE(WINAPI *get_thread_dpi_ctx_fn)(void);
typedef BOOL(WINAPI *dpi_ctx_equal_fn)(HANDLE, HANDLE);
typedef UINT(WINAPI *dpi_for_window_fn)(HWND);
typedef HANDLE(WINAPI *window_dpi_ctx_fn)(HWND);
typedef int(WINAPI *awareness_of_ctx_fn)(HANDLE);
#define WC_DPI_PMV2 ((HANDLE)(LONG_PTR)-4)

static dpi_for_window_fn g_dpi_for_window = NULL;
static window_dpi_ctx_fn g_window_dpi_ctx = NULL;
static awareness_of_ctx_fn g_awareness_of_ctx = NULL;
static dpi_ctx_equal_fn g_dpi_ctx_equal = NULL;

/* Per-Monitor v2 (the manifest asks first; this covers a stripped manifest). */
static int enable_dpi_awareness(void) {
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  set_dpi_ctx_fn set_ctx;
  get_thread_dpi_ctx_fn get_ctx;
  dpi_ctx_equal_fn equal;
  if (!user32) return 0;
  set_ctx = (set_dpi_ctx_fn)(void (*)(void))GetProcAddress(user32, "SetProcessDpiAwarenessContext");
  get_ctx = (get_thread_dpi_ctx_fn)(void (*)(void))GetProcAddress(user32, "GetThreadDpiAwarenessContext");
  equal = (dpi_ctx_equal_fn)(void (*)(void))GetProcAddress(user32, "AreDpiAwarenessContextsEqual");
  g_dpi_for_window = (dpi_for_window_fn)(void (*)(void))GetProcAddress(user32, "GetDpiForWindow");
  g_window_dpi_ctx = (window_dpi_ctx_fn)(void (*)(void))GetProcAddress(user32, "GetWindowDpiAwarenessContext");
  g_awareness_of_ctx = (awareness_of_ctx_fn)(void (*)(void))GetProcAddress(user32, "GetAwarenessFromDpiAwarenessContext");
  g_dpi_ctx_equal = equal;
  if (set_ctx) set_ctx(WC_DPI_PMV2); /* fails harmlessly when the manifest already set it */
  return get_ctx && equal && equal(get_ctx(), WC_DPI_PMV2);
}

/* The game window's own DPI awareness, in Task Manager's words (DR-05; display checklist item 9):
 * a System-aware WoW is bitmap-scaled by Windows on a monitor of another DPI, which shrinks the
 * strip's cells (D-19). */
static const char *window_dpi_awareness(HWND hwnd) {
  HANDLE ctx;
  if (!g_window_dpi_ctx || !g_awareness_of_ctx) return "unknown";
  ctx = g_window_dpi_ctx(hwnd);
  if (!ctx) return "unknown";
  if (g_dpi_ctx_equal && g_dpi_ctx_equal(ctx, WC_DPI_PMV2)) return "per-monitor-v2";
  switch (g_awareness_of_ctx(ctx)) {
    case 0: return "unaware";
    case 1: return "system";
    case 2: return "per-monitor";
    default: return "unknown";
  }
}

/* ------------------------------------------------------------------ the game's window */

/* The process's image path in UTF-8; 0 when it can't be read (such a window is never the game's). A
 * path given in 8.3 short names (a "~") gets its long names back, so its flavor folder is named as
 * the bridge names it. */
static int image_path(DWORD pid, char *out, int cap) {
  wchar_t path[1024], full[1024];
  DWORD n = (DWORD)(sizeof path / sizeof path[0]), got;
  int ok;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return 0;
  ok = QueryFullProcessImageNameW(h, 0, path, &n);
  CloseHandle(h);
  if (!ok) return 0;
  if (wcschr(path, L'~')) {
    got = GetLongPathNameW(path, full, (DWORD)(sizeof full / sizeof full[0]));
    if (got > 0 && got < (DWORD)(sizeof full / sizeof full[0])) wcscpy(path, full);
  }
  return WideCharToMultiByte(CP_UTF8, 0, path, -1, out, cap, NULL, NULL) > 0;
}

/* The windows that may be the game's (winpick.c's rules), in the order EnumWindows gives them. */
typedef struct {
  const options *o;
  wc_window w[WC_PICK_LIST];
  char path[WC_PICK_LIST][PATH_UTF8];
  HWND hwnd[WC_PICK_LIST];
  int n;
} find_ctx;

static find_ctx g_find;

static BOOL CALLBACK enum_proc(HWND hwnd, LPARAM lp) {
  find_ctx *c = (find_ctx *)lp;
  wc_window *w;
  DWORD pid = 0;
  RECT rc;
  if (c->n == WC_PICK_LIST) return FALSE;
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER)) return TRUE;
  GetWindowThreadProcessId(hwnd, &pid);
  if (!pid || pid == GetCurrentProcessId()) return TRUE;
  w = &c->w[c->n];
  memset(w, 0, sizeof *w);
  w->id = (unsigned long long)(ULONG_PTR)hwnd;
  w->pid = pid;
  w->path = image_path(pid, c->path[c->n], PATH_UTF8) ? c->path[c->n] : NULL;
  w->iconic = IsIconic(hwnd) ? 1 : 0;
  if (!w->iconic && GetClientRect(hwnd, &rc)) {
    w->width = rc.right - rc.left;
    w->height = rc.bottom - rc.top;
  }
  if (wc_pick_refused(&c->o->rules, w)) return TRUE;
  c->hwnd[c->n++] = hwnd;
  return TRUE;
}

static void names_text(const options *o, char *out, size_t cap) {
  int k;
  out[0] = '\0';
  for (k = 0; k < o->nnames; k++) {
    if (strlen(out) + strlen(o->names[k]) + 8 >= cap) break;
    if (k) strcat(out, ", ");
    strcat(out, o->names[k]);
    strcat(out, ".exe");
  }
}

/* "_forever_ or _classic_beta_", or "" with none. */
static void flavors_text(const options *o, char *out, size_t cap) {
  int k;
  out[0] = '\0';
  for (k = 0; k < o->rules.nflavors; k++) {
    if (strlen(out) + strlen(o->flavors[k]) + 5 >= cap) break;
    if (k) strcat(out, " or ");
    strcat(out, o->flavors[k]);
  }
}

/* ------------------------------------------------------------------ DXGI Desktop Duplication */

typedef struct {
  ID3D11Device *device;
  ID3D11DeviceContext *ctx;
  IDXGIOutputDuplication *dup;
  ID3D11Texture2D *staging;
  UINT staging_w, staging_h;
  DXGI_FORMAT staging_fmt;
  HMONITOR monitor;
  RECT desktop; /* the output's desktop coordinates */
} dda;

static void dda_release(dda *d) {
  if (d->staging) ID3D11Texture2D_Release(d->staging);
  if (d->dup) IDXGIOutputDuplication_Release(d->dup);
  if (d->ctx) ID3D11DeviceContext_Release(d->ctx);
  if (d->device) ID3D11Device_Release(d->device);
  memset(d, 0, sizeof *d);
}

/* 0; OPEN_UNSUPPORTED with capture_unsupported set (tried again after a wait: winpick.c's
 * wc_open_backoff, SY-24); or -1 (the lock, or access_lost), tried again in 2 s. */
#define OPEN_UNSUPPORTED (-2)
static int dda_open(dda *d, HMONITOR monitor) {
  IDXGIFactory1 *factory = NULL;
  IDXGIAdapter1 *adapter = NULL;
  IDXGIOutput *output = NULL;
  IDXGIOutput1 *output1 = NULL;
  DXGI_OUTPUT_DESC desc;
  DXGI_OUTDUPL_DESC dd;
  char msg[200];
  UINT a, k;
  HRESULT hr;

  dda_release(d);
  memset(&desc, 0, sizeof desc); /* set with the output below; zeroed so gcc -O2 sees it initialized */
  hr = CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory);
  if (FAILED(hr)) {
    snprintf(msg, sizeof msg, "DXGI isn't available (CreateDXGIFactory1 0x%08lx)", (unsigned long)hr);
    set_error("capture_unsupported", msg);
    return OPEN_UNSUPPORTED;
  }
  for (a = 0; !output && IDXGIFactory1_EnumAdapters1(factory, a, &adapter) != DXGI_ERROR_NOT_FOUND; a++) {
    IDXGIOutput *o = NULL;
    for (k = 0; IDXGIAdapter1_EnumOutputs(adapter, k, &o) != DXGI_ERROR_NOT_FOUND; k++) {
      if (SUCCEEDED(IDXGIOutput_GetDesc(o, &desc)) && desc.Monitor == monitor) {
        output = o;
        break;
      }
      IDXGIOutput_Release(o);
    }
    if (!output) {
      IDXGIAdapter1_Release(adapter);
      adapter = NULL;
    }
  }
  IDXGIFactory1_Release(factory);
  if (!output) {
    set_error("capture_unsupported", "no display output found for the monitor showing World of Warcraft");
    return OPEN_UNSUPPORTED;
  }
  hr = D3D11CreateDevice((IDXGIAdapter *)adapter, D3D_DRIVER_TYPE_UNKNOWN, NULL, 0, NULL, 0, D3D11_SDK_VERSION,
                         &d->device, NULL, &d->ctx);
  IDXGIAdapter1_Release(adapter);
  if (FAILED(hr)) {
    IDXGIOutput_Release(output);
    snprintf(msg, sizeof msg, "Direct3D 11 isn't available on this display's adapter (0x%08lx)", (unsigned long)hr);
    set_error("capture_unsupported", msg);
    dda_release(d);
    return OPEN_UNSUPPORTED;
  }
  hr = IDXGIOutput_QueryInterface(output, &IID_IDXGIOutput1, (void **)&output1);
  IDXGIOutput_Release(output);
  if (FAILED(hr)) {
    set_error("capture_unsupported", "Desktop Duplication needs Windows 8 or later");
    dda_release(d);
    return OPEN_UNSUPPORTED;
  }
  hr = IDXGIOutput1_DuplicateOutput(output1, (IUnknown *)d->device, &d->dup);
  IDXGIOutput1_Release(output1);
  if (FAILED(hr)) {
    int unsupported = 0;
    if (hr == E_ACCESSDENIED || hr == DXGI_ERROR_SESSION_DISCONNECTED) {
      /* The lock screen, a UAC prompt or a disconnected session: held as away "locked" when the input
         desktop confirms it (DR-26), else the typed access_lost the bridge can restart for. */
      wchar_t desk[64];
      if (!wc_away_open_failed(&g_away, hr == E_ACCESSDENIED ? WC_DUP_ACCESS_DENIED : WC_DUP_SESSION_DISCONNECTED,
                               input_desktop(desk, (DWORD)sizeof desk)))
        set_error("access_lost", hr == E_ACCESSDENIED ? "the screen can't be read right now (access denied)"
                                                      : "the Windows session is disconnected");
    } else if (hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) {
      set_error("capture_unsupported", "too many apps are capturing the screen at once; close one (Windows allows four)");
      unsupported = 1;
    } else {
      snprintf(msg, sizeof msg, "Desktop Duplication isn't supported on this display (0x%08lx)", (unsigned long)hr);
      set_error("capture_unsupported", msg);
      unsupported = 1;
    }
    dda_release(d);
    return unsupported ? OPEN_UNSUPPORTED : -1;
  }
  IDXGIOutputDuplication_GetDesc(d->dup, &dd);
  if (dd.Rotation != DXGI_MODE_ROTATION_IDENTITY && dd.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
    set_error("capture_unsupported", "World of Warcraft is on a rotated display, which capture doesn't support yet");
    dda_release(d);
    return OPEN_UNSUPPORTED;
  }
  d->monitor = monitor;
  d->desktop = desc.DesktopCoordinates;
  return 0;
}

/* 1: a new frame is mapped into px (call dda_unmap); 0: nothing new; -1: error set (reopen). */
static int dda_grab(dda *d, const RECT *crop, wc_pixels *px) {
  DXGI_OUTDUPL_FRAME_INFO info;
  IDXGIResource *res = NULL;
  ID3D11Texture2D *tex = NULL;
  D3D11_TEXTURE2D_DESC td;
  D3D11_BOX box;
  D3D11_MAPPED_SUBRESOURCE map;
  LONG left, top, right, bottom;
  char msg[160];
  HRESULT hr = IDXGIOutputDuplication_AcquireNextFrame(d->dup, 0, &info, &res);
  if (hr == DXGI_ERROR_WAIT_TIMEOUT) return 0;
  if (FAILED(hr)) {
    if (hr == DXGI_ERROR_ACCESS_LOST) {
      set_error("access_lost", "screen capture was interrupted (a mode change, a UAC prompt or a fullscreen switch); resuming");
    } else {
      snprintf(msg, sizeof msg, "screen capture failed (0x%08lx); resuming", (unsigned long)hr);
      set_error("access_lost", msg);
    }
    return -1;
  }
  hr = IDXGIResource_QueryInterface(res, &IID_ID3D11Texture2D, (void **)&tex);
  IDXGIResource_Release(res);
  if (FAILED(hr)) {
    IDXGIOutputDuplication_ReleaseFrame(d->dup);
    set_error("capture_unsupported", "the desktop image isn't a texture");
    return -1;
  }
  ID3D11Texture2D_GetDesc(tex, &td);
  if (td.Format != DXGI_FORMAT_B8G8R8A8_UNORM && td.Format != DXGI_FORMAT_B8G8R8A8_UNORM_SRGB &&
      td.Format != DXGI_FORMAT_R8G8B8A8_UNORM && td.Format != DXGI_FORMAT_R8G8B8A8_UNORM_SRGB) {
    ID3D11Texture2D_Release(tex);
    IDXGIOutputDuplication_ReleaseFrame(d->dup);
    snprintf(msg, sizeof msg, "unsupported desktop format %d", (int)td.Format);
    set_error("capture_unsupported", msg);
    return -1;
  }
  left = crop->left - d->desktop.left;
  top = crop->top - d->desktop.top;
  right = crop->right - d->desktop.left;
  bottom = crop->bottom - d->desktop.top;
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (right > (LONG)td.Width) right = (LONG)td.Width;
  if (bottom > (LONG)td.Height) bottom = (LONG)td.Height;
  if (right <= left || bottom <= top) {
    ID3D11Texture2D_Release(tex);
    IDXGIOutputDuplication_ReleaseFrame(d->dup);
    return 0;
  }
  if (!d->staging || d->staging_w != (UINT)(right - left) || d->staging_h != (UINT)(bottom - top) ||
      d->staging_fmt != td.Format) {
    D3D11_TEXTURE2D_DESC sd;
    if (d->staging) ID3D11Texture2D_Release(d->staging);
    d->staging = NULL;
    memset(&sd, 0, sizeof sd);
    sd.Width = (UINT)(right - left);
    sd.Height = (UINT)(bottom - top);
    sd.MipLevels = 1;
    sd.ArraySize = 1;
    sd.Format = td.Format;
    sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr = ID3D11Device_CreateTexture2D(d->device, &sd, NULL, &d->staging);
    if (FAILED(hr)) {
      ID3D11Texture2D_Release(tex);
      IDXGIOutputDuplication_ReleaseFrame(d->dup);
      snprintf(msg, sizeof msg, "couldn't make a %ux%u staging texture (0x%08lx)", sd.Width, sd.Height, (unsigned long)hr);
      set_error("capture_unsupported", msg);
      return -1;
    }
    d->staging_w = sd.Width;
    d->staging_h = sd.Height;
    d->staging_fmt = td.Format;
  }
  box.left = (UINT)left;
  box.top = (UINT)top;
  box.right = (UINT)right;
  box.bottom = (UINT)bottom;
  box.front = 0;
  box.back = 1;
  ID3D11DeviceContext_CopySubresourceRegion(d->ctx, (ID3D11Resource *)d->staging, 0, 0, 0, 0, (ID3D11Resource *)tex, 0, &box);
  ID3D11Texture2D_Release(tex);
  IDXGIOutputDuplication_ReleaseFrame(d->dup);
  hr = ID3D11DeviceContext_Map(d->ctx, (ID3D11Resource *)d->staging, 0, D3D11_MAP_READ, 0, &map);
  if (FAILED(hr)) {
    snprintf(msg, sizeof msg, "couldn't read the captured frame (0x%08lx)", (unsigned long)hr);
    set_error("access_lost", msg);
    return -1;
  }
  px->width = (int)d->staging_w;
  px->height = (int)d->staging_h;
  px->stride = map.RowPitch;
  px->base = (const uint8_t *)map.pData;
  px->bpp = 4;
  px->bgr = d->staging_fmt == DXGI_FORMAT_B8G8R8A8_UNORM || d->staging_fmt == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
  return 1;
}

static void dda_unmap(dda *d) { ID3D11DeviceContext_Unmap(d->ctx, (ID3D11Resource *)d->staging, 0); }

/* ------------------------------------------------------------------ stats */

typedef struct {
  unsigned long frames, decoded, rejected, idle, unchanged;
  unsigned long last_frames, last_decoded, last_rejected;
  unsigned long checksum, length, truncated;
  double decode_ms, decode_max_ms, grab_ms;
} stats;

static double now_ms(void) {
  static LARGE_INTEGER freq;
  LARGE_INTEGER t;
  if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t);
  return (double)t.QuadPart * 1000.0 / (double)freq.QuadPart;
}

static void emit_stats(stats *s, int attached, const wc_geometry *hint, LONG crop_w, LONG crop_h) {
  wc_json j;
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{\"stats\":{\"interval\":{");
  wc_json_key(&j, "frames", 1);
  wc_json_int(&j, (long long)(s->frames - s->last_frames));
  wc_json_key(&j, "decoded", 0);
  wc_json_int(&j, (long long)(s->decoded - s->last_decoded));
  wc_json_key(&j, "rejected", 0);
  wc_json_int(&j, (long long)(s->rejected - s->last_rejected));
  wc_json_raw(&j, "}");
  wc_json_key(&j, "frames", 0);
  wc_json_int(&j, (long long)s->frames);
  wc_json_key(&j, "decoded", 0);
  wc_json_int(&j, (long long)s->decoded);
  wc_json_key(&j, "rejected", 0);
  wc_json_int(&j, (long long)s->rejected);
  wc_json_key(&j, "idle", 0);
  wc_json_int(&j, (long long)s->idle);
  wc_json_key(&j, "unchanged", 0);
  wc_json_int(&j, (long long)s->unchanged);
  wc_json_key(&j, "decodeAvgMs", 0);
  wc_json_num(&j, s->frames ? s->decode_ms / (double)s->frames : 0);
  wc_json_key(&j, "decodeMaxMs", 0);
  wc_json_num(&j, s->decode_max_ms);
  wc_json_key(&j, "grabAvgMs", 0);
  wc_json_num(&j, s->frames ? s->grab_ms / (double)s->frames : 0);
  wc_json_raw(&j, ",\"rejectReasons\":{");
  wc_json_key(&j, "checksum", 1);
  wc_json_int(&j, (long long)s->checksum);
  wc_json_key(&j, "length", 0);
  wc_json_int(&j, (long long)s->length);
  wc_json_key(&j, "truncated", 0);
  wc_json_int(&j, (long long)s->truncated);
  wc_json_raw(&j, "}");
  wc_json_key(&j, "attached", 0);
  wc_json_raw(&j, attached ? "true" : "false");
  if (crop_w > 0 && crop_h > 0) {
    wc_json_key(&j, "region", 0);
    wc_json_raw(&j, "{");
    wc_json_key(&j, "width", 1);
    wc_json_int(&j, (long long)crop_w);
    wc_json_key(&j, "height", 0);
    wc_json_int(&j, (long long)crop_h);
    wc_json_raw(&j, "}");
  }
  if (hint) {
    wc_json_key(&j, "geometry", 0);
    wc_json_geometry(&j, hint->x0, hint->y0, hint->pitch);
  }
  wc_json_raw(&j, "}}");
  if (wc_json_end(&j) == 0) send_line(g_line, 1);
  s->last_frames = s->frames;
  s->last_decoded = s->decoded;
  s->last_rejected = s->rejected;
}

/* ------------------------------------------------------------------ one decoded frame */

static uint8_t g_last_payload[WC_MAX_FRAME_BYTES];
static size_t g_last_len = 0;
static int g_last_id = -1;

static void emit_payload(const wc_result *r) {
  wc_json j;
  if (r->id == g_last_id && r->len == g_last_len && memcmp(g_last_payload, wc_payload(r), r->len) == 0) return;
  g_last_id = r->id;
  g_last_len = r->len;
  memcpy(g_last_payload, wc_payload(r), r->len);
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "id", 1);
  wc_json_int(&j, r->id);
  wc_json_key(&j, "text", 0);
  wc_json_str(&j, wc_payload(r), r->len);
  wc_json_key(&j, "bytes", 0);
  wc_json_int(&j, (long long)r->len);
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) send_line(g_line, 0); /* record text: never logged */
}

/* ------------------------------------------------------------------ --test-image */

static int test_image(const options *o) {
  wc_ppm img;
  wc_pixels px;
  wc_json j;
  const char *err = NULL;
  FILE *f = _wfopen(o->test_image, L"rb");
  wc_json_init(&j, g_line, sizeof g_line);
  if (!f || wc_ppm_read(f, &img, &err) != 0) {
    if (f) fclose(f);
    wc_json_raw(&j, "{");
    wc_json_key(&j, "error", 1);
    wc_json_cstr(&j, f ? err : "cannot open the image");
    wc_json_raw(&j, "}");
    if (wc_json_end(&j) == 0) fputs(g_line, stdout);
    return 1;
  }
  fclose(f);
  px.width = img.width;
  px.height = img.height;
  px.stride = (size_t)img.width * 3;
  px.base = img.rgb;
  px.bpp = 3;
  px.bgr = 0;
  wc_find_and_decode(&px, &o->spec, NULL, &g_result);
  wc_json_raw(&j, "{");
  if (g_result.status == WC_DECODED) {
    wc_json_key(&j, "id", 1);
    wc_json_int(&j, g_result.id);
    wc_json_key(&j, "text", 0);
    wc_json_str(&j, wc_payload(&g_result), g_result.len);
    wc_json_key(&j, "bytes", 0);
    wc_json_int(&j, (long long)g_result.len);
  } else {
    wc_json_key(&j, "error", 1);
    wc_json_cstr(&j, g_result.status == WC_REJECTED ? g_result.reason : "no valid strip in image");
  }
  if (g_result.status != WC_NONE) {
    wc_json_key(&j, "geometry", 0);
    wc_json_geometry(&j, g_result.geometry.x0, g_result.geometry.y0, g_result.geometry.pitch);
  }
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) fputs(g_line, stdout);
  wc_ppm_free(&img);
  return 0;
}

/* ------------------------------------------------------------------ setup */

static void open_log(const wchar_t *path) {
  LARGE_INTEGER size;
  if (!path) return;
  g_log = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_ALWAYS,
                      FILE_ATTRIBUTE_NORMAL, NULL);
  if (g_log != INVALID_HANDLE_VALUE && GetFileSizeEx(g_log, &size) && size.QuadPart > LOG_MAX_BYTES) {
    CloseHandle(g_log);
    g_log = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, CREATE_ALWAYS,
                        FILE_ATTRIBUTE_NORMAL, NULL);
  }
}

/* The bridge's pipe, read by a thread (it blocks there, so the loop can wait on g_gone instead of
 * looking): anything the bridge sends is read and ignored, and end of file or a broken pipe (it quit
 * or crashed) sets g_gone. A pipe this thread can't read the plain way leaves parent_alive() to peek,
 * as it did before SY-30. */
static DWORD WINAPI watch_stdin(LPVOID unused) {
  char buf[512];
  (void)unused;
  for (;;) {
    DWORD got = 0;
    if (ReadFile(g_parent, buf, (DWORD)sizeof buf, &got, NULL)) {
      if (got == 0) break;
      continue;
    }
    {
      DWORD e = GetLastError();
      if (e == ERROR_BROKEN_PIPE || e == ERROR_HANDLE_EOF || e == ERROR_PIPE_NOT_CONNECTED || e == ERROR_NO_DATA) break;
    }
    InterlockedExchange(&g_watch_failed, 1);
    return 0;
  }
  SetEvent(g_gone);
  return 0;
}

static void start_stdin_watch(void) {
  HANDLE t;
  if (!g_parent) return;
  g_gone = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!g_gone) return;
  t = CreateThread(NULL, 64 * 1024, watch_stdin, NULL, STACK_SIZE_PARAM_IS_A_RESERVATION, NULL);
  if (!t) {
    CloseHandle(g_gone);
    g_gone = NULL;
    return;
  }
  CloseHandle(t);
}

/* True while the bridge is there. It spawns the helper with stdin a pipe it keeps
 * open and never writes to: end of file (it quit or crashed) or a broken pipe
 * means exit. Anything it does send is read and ignored. A console or a file on
 * stdin (a rig run by hand) isn't watched. */
static int parent_alive(void) {
  DWORD avail = 0;
  if (!g_parent) return 1;
  if (g_gone && !g_watch_failed) return WaitForSingleObject(g_gone, 0) != WAIT_OBJECT_0;
  if (!PeekNamedPipe(g_parent, NULL, 0, NULL, &avail, NULL)) return 0;
  while (avail > 0) {
    char buf[512];
    DWORD got = 0;
    if (!ReadFile(g_parent, buf, avail < sizeof buf ? avail : (DWORD)sizeof buf, &got, NULL) || got == 0) return 0;
    avail -= got;
  }
  return 1;
}

static void emit_start(const options *o, int pmv2) {
  wc_json j;
  char names[512], flavors[512];
  names_text(o, names, sizeof names);
  flavors_text(o, flavors, sizeof flavors);
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "info", 1);
  wc_json_cstr(&j, "nqa-capture " WC_VERSION " started");
  wc_json_key(&j, "dpi", 0);
  wc_json_cstr(&j, pmv2 ? "per-monitor-v2" : "not per-monitor-v2");
  wc_json_key(&j, "magic", 0);
  wc_json_cstr(&j, o->magic_text);
  wc_json_key(&j, "intervalMs", 0);
  wc_json_int(&j, o->interval_ms);
  wc_json_key(&j, "region", 0);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "width", 1);
  wc_json_int(&j, o->width);
  wc_json_key(&j, "height", 0);
  wc_json_int(&j, o->height);
  wc_json_raw(&j, "}");
  wc_json_key(&j, "process", 0);
  wc_json_cstr(&j, names);
  wc_json_key(&j, "flavors", 0);
  wc_json_cstr(&j, flavors);
  wc_json_key(&j, "exeDir", 0); /* whether one was given: the path itself may name the player */
  wc_json_raw(&j, o->rules.exe_dir ? "true" : "false");
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) send_line(g_line, 1);
}

/* why: NULL on a first attach, else why the helper moved to this window (winpick.c). */
static void emit_window(HWND hwnd, DWORD pid, const char *path, const RECT *client, int under_exe_dir, const char *why) {
  wc_json j;
  char img[520], text[900];
  snprintf(img, sizeof img, "%s", wc_pick_base(path));
  if (why) snprintf(text, sizeof text, "attached to %s (pid %lu): %s", img, (unsigned long)pid, why);
  else snprintf(text, sizeof text, "attached to %s (pid %lu)", img, (unsigned long)pid);
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "info", 1);
  wc_json_cstr(&j, text);
  wc_json_key(&j, "window", 0);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "pid", 1);
  wc_json_int(&j, (long long)pid);
  wc_json_key(&j, "image", 0);
  wc_json_cstr(&j, img);
  wc_json_key(&j, "width", 0);
  wc_json_int(&j, client->right - client->left);
  wc_json_key(&j, "height", 0);
  wc_json_int(&j, client->bottom - client->top);
  wc_json_key(&j, "dpi", 0);
  wc_json_int(&j, g_dpi_for_window ? (long long)g_dpi_for_window(hwnd) : 0);
  wc_json_key(&j, "dpiAwareness", 0);
  wc_json_cstr(&j, window_dpi_awareness(hwnd));
  wc_json_key(&j, "underExeDir", 0);
  wc_json_raw(&j, under_exe_dir ? "true" : "false");
  wc_json_raw(&j, "}}");
  if (wc_json_end(&j) == 0) send_line(g_line, 1);
}

/* The crop grew or shrank to fit the strip at a newly measured pitch. */
static void emit_region(LONG w, LONG h, double pitch) {
  wc_json j;
  char text[160];
  snprintf(text, sizeof text, "capturing %ldx%ld to fit the strip (%.2f px cells)", (long)w, (long)h, pitch);
  wc_json_init(&j, g_line, sizeof g_line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "info", 1);
  wc_json_cstr(&j, text);
  wc_json_key(&j, "region", 0);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "width", 1);
  wc_json_int(&j, (long long)w);
  wc_json_key(&j, "height", 0);
  wc_json_int(&j, (long long)h);
  wc_json_raw(&j, "}}");
  if (wc_json_end(&j) == 0) send_line(g_line, 1);
}

/* ------------------------------------------------------------------ the loop */

typedef struct {
  HWND hwnd;
  DWORD pid;
  HANDLE process; /* SYNCHRONIZE, to see the game exit */
} game_state;

static void game_forget(game_state *g) {
  if (g->process) CloseHandle(g->process);
  g->process = NULL;
  g->hwnd = NULL;
  g->pid = 0;
}

/* The game's process ended: say so once. */
static void check_game_exit(game_state *g) {
  if (g->process && WaitForSingleObject(g->process, 0) == WAIT_OBJECT_0) {
    emit_game("exited", g->pid);
    game_forget(g);
  }
}

static int window_still_valid(const game_state *g) {
  DWORD pid = 0;
  if (!g->hwnd || !IsWindow(g->hwnd) || !IsWindowVisible(g->hwnd)) return 0;
  GetWindowThreadProcessId(g->hwnd, &pid);
  return pid == g->pid;
}

/* A window was shown on the desktop (SY-30): top-level and unowned, as the game's is. Nothing is
 * looked at here; the loop looks once it wakes. */
static void CALLBACK on_window_shown(HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG obj, LONG child, DWORD thread,
                                     DWORD ms) {
  (void)hook;
  (void)event;
  (void)thread;
  (void)ms;
  if (!hwnd || obj != OBJID_WINDOW || child != CHILDID_SELF) return;
  if (GetAncestor(hwnd, GA_ROOT) != hwnd || GetWindow(hwnd, GW_OWNER)) return;
  InterlockedExchange(&g_shown, 1);
}

/* The wait while no game window is found (SY-30): until a window is shown (with the hook), the
 * game's process ends (a window that went while the game quits: its exit is said at once), the
 * rescan time passes, or the bridge goes. The hook's events come through this thread's message
 * queue, which is pumped here only. Returns 0 when the bridge is gone, 1 to look again. */
static int wait_absent(int hooked, HANDLE game_process) {
  DWORD budget = hooked ? ABSENT_RESCAN_MS : ABSENT_SLEEP_MS;
  HANDLE waits[2];
  DWORD n = 0, gone_at = MAXDWORD;
  ULONGLONG until;
  if (g_gone && !g_watch_failed) {
    gone_at = n;
    waits[n++] = g_gone;
  } else if (g_parent && budget > 1000) {
    budget = 1000; /* parent_alive() has to peek: as often as before */
  }
  if (game_process) waits[n++] = game_process;
  until = GetTickCount64() + budget;
  for (;;) {
    ULONGLONG now = GetTickCount64();
    DWORD left = now >= until ? 0 : (DWORD)(until - now);
    DWORD r = MsgWaitForMultipleObjects(n, n ? waits : NULL, FALSE, left, QS_ALLINPUT);
    if (gone_at != MAXDWORD && r == WAIT_OBJECT_0 + gone_at) return 0;
    if (r < WAIT_OBJECT_0 + n) return 1; /* the game's process ended: the loop says so */
    if (r == WAIT_OBJECT_0 + n) {
      MSG m;
      while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) DispatchMessageW(&m);
      if (InterlockedExchange(&g_shown, 0)) {
        Sleep(ABSENT_SETTLE_MS);
        return 1;
      }
      if (left == 0) return 1;
      continue;
    }
    if (r == WAIT_TIMEOUT) return 1; /* the rescan time */
    Sleep(ABSENT_SLEEP_MS);           /* a failed wait: look every ABSENT_SLEEP_MS, as the old loop did */
    return 1;
  }
}

static void run(const options *o) {
  game_state game;
  dda d;
  stats st;
  wc_geometry hint = {0, 0, 0};
  wc_geometry measured = {0, 0, 0}; /* sizes the crop (a decode, or a strip cut off at a known pitch) */
  wc_open_backoff open_wait;        /* the wait between tries on an unsupported monitor (SY-24) */
  int have_hint = 0, have_measured = 0, first_scan = 1;
  int said_absent = 0;              /* this absence's window_not_found went out (SY-30: once, not each minute) */
  HWINEVENTHOOK hook = NULL;        /* while no game window is found (SY-30) */
  LONG crop_w = 0, crop_h = 0;      /* the last crop, to say when it changes */
  ULONGLONG last_stats = GetTickCount64(), last_reject_warn = 0, last_offscreen_warn = 0, last_scan = 0;
  char names[512], flavors[512], msg[1200];

  memset(&game, 0, sizeof game);
  memset(&d, 0, sizeof d);
  memset(&st, 0, sizeof st);
  memset(&open_wait, 0, sizeof open_wait);
  names_text(o, names, sizeof names);
  flavors_text(o, flavors, sizeof flavors);

  for (;;) {
    double t0 = now_ms(), t1 = 0, t2 = 0;
    int sleep_ms = o->interval_ms, got, grows = 0;
    RECT client, crop;
    POINT tl = {0, 0};
    HMONITOR mon;
    DWORD affinity = 0;
    wc_pixels px;

    if (!parent_alive()) {
      log_raw("{\"info\":\"the bridge is gone (stdin ended); exiting\"}\n");
      return;
    }
    say_away();
    /* Stats while there is a game window to report on: with the game closed, nothing changes and
     * nothing is said (SY-30). */
    if (game.hwnd && GetTickCount64() - last_stats >= (ULONGLONG)o->stats_sec * 1000) {
      emit_stats(&st, d.dup != NULL, have_hint ? &hint : NULL, crop_w, crop_h);
      last_stats = GetTickCount64();
    }
    check_game_exit(&game);

    /* The game's window: looked for while there is none, and every RESCAN_MS while attached, so a
       better one (the game in the served folder, a visible one, a larger one) takes over (DR-05). */
    if (!window_still_valid(&game) || GetTickCount64() - last_scan >= RESCAN_MS) {
      find_ctx *c = &g_find;
      int best, attached = -1, k, still = window_still_valid(&game);
      wc_switch sw;
      c->o = o;
      c->n = 0;
      EnumWindows(enum_proc, (LPARAM)c);
      last_scan = GetTickCount64();
      best = wc_pick_best(&o->rules, c->w, c->n);
      if (best < 0) {
        if (first_scan) emit_game("absent", 0);
        first_scan = 0;
        if (game.hwnd) game.hwnd = NULL;
        /* Said once each time the window goes (retried until the minute's limit lets it out), not
         * every minute the game stays closed: that line woke the bridge all day (SY-30). */
        if (!said_absent) {
          if (flavors[0]) snprintf(msg, sizeof msg, "World of Warcraft's window wasn't found (looking for %s in a %s folder)", names, flavors);
          else snprintf(msg, sizeof msg, "World of Warcraft's window wasn't found (no game folder was given to look in)");
          said_absent = set_error("window_not_found", msg);
        }
        dda_release(&d);
        /* No polling while the game is closed (SY-30): look again when a window is shown. */
        if (!hook) {
          InterlockedExchange(&g_shown, 0);
          hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, NULL, on_window_shown, 0, 0,
                                 WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        }
        wait_absent(hook != NULL, game.process); /* 0, the bridge gone: the top of the loop says so and exits */
        continue;
      }
      said_absent = 0;
      if (hook) {
        /* A game window again: its capture loop pumps no messages, so the hook goes until it's gone. */
        MSG m;
        UnhookWinEvent(hook);
        hook = NULL;
        while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) DispatchMessageW(&m);
        InterlockedExchange(&g_shown, 0);
      }
      for (k = 0; k < c->n; k++) {
        if (game.hwnd && c->hwnd[k] == game.hwnd) attached = k;
      }
      sw = still ? wc_pick_switch(&o->rules, c->w, attached, best) : WC_SWITCH_GONE;
      if (sw != WC_STAY) {
        HWND h = c->hwnd[best];
        DWORD pid = (DWORD)c->w[best].pid;
        /* A move from a window that's still there says why; its game is "running", not new. */
        const char *why = still ? wc_switch_text(sw) : NULL;
        if (pid != game.pid) {
          game_forget(&game);
          game.process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
          game.pid = pid;
          emit_game(first_scan || why ? "running" : "launched", pid);
        }
        first_scan = 0;
        game.hwnd = h;
        have_hint = 0;
        have_measured = 0;
        GetClientRect(h, &client);
        emit_window(h, pid, c->w[best].path, &client, wc_pick_under_exe_dir(&o->rules, &c->w[best]), why);
      }
    }

    if (IsIconic(game.hwnd)) {
      set_error("window_minimized", "World of Warcraft is minimized; restore it to keep chatting");
      Sleep(1000);
      continue;
    }
    if (GetWindowDisplayAffinity(game.hwnd, &affinity) && affinity != WDA_NONE) {
      set_error("capture_blocked_by_app", affinity == WDA_EXCLUDEFROMCAPTURE
                ? "World of Warcraft's window is excluded from screen capture (SetWindowDisplayAffinity)"
                : "World of Warcraft's window shows blank to screen capture (SetWindowDisplayAffinity)");
      Sleep(2000);
      continue;
    }
    if (!GetClientRect(game.hwnd, &client) || !ClientToScreen(game.hwnd, &tl) || client.right <= 0 || client.bottom <= 0) {
      set_error("window_minimized", "World of Warcraft's window has no visible area");
      Sleep(1000);
      continue;
    }
    {
      int want_w, want_h;
      LONG w, h;
      wc_crop_size(&o->spec, have_measured ? &measured : NULL, o->width, o->height, &want_w, &want_h);
      w = client.right < want_w ? client.right : want_w;
      h = client.bottom < want_h ? client.bottom : want_h;
      if (crop_w && (w != crop_w || h != crop_h) && have_measured) emit_region(w, h, measured.pitch);
      crop_w = w;
      crop_h = h;
      crop.left = tl.x;
      crop.top = tl.y;
      crop.right = tl.x + w;
      crop.bottom = tl.y + h;
    }

    mon = MonitorFromPoint(tl, MONITOR_DEFAULTTONULL);
    if (!mon) {
      if (GetTickCount64() - last_offscreen_warn > 60000) {
        emit_warn("World of Warcraft's top-left corner is off-screen; move the window onto a display");
        last_offscreen_warn = GetTickCount64();
      }
      Sleep(1000);
      continue;
    }
    if (!d.dup || d.monitor != mon) {
      int opened;
      /* An unsupported monitor is tried again after 2 s, 10 s, then every 60 s (SY-24), while the loop
         still watches the window, the game and the bridge each second; another monitor starts over. */
      if (!wc_open_may_try(&open_wait, (unsigned long long)(ULONG_PTR)mon, GetTickCount64())) {
        Sleep(1000);
        continue;
      }
      opened = dda_open(&d, mon);
      wc_open_result(&open_wait, (unsigned long long)(ULONG_PTR)mon, opened == OPEN_UNSUPPORTED, GetTickCount64());
      /* The lock dda_open just decided is said now, not after the wait below: the lock screen's
         access_lost (dda_grab's) reaches the bridge half a second before it, not 2.5 s (DR-26). */
      say_away();
      if (opened != 0) {
        Sleep(opened == OPEN_UNSUPPORTED ? 1000 : 2000);
        continue;
      }
      have_hint = 0;
    }

    got = dda_grab(&d, &crop, &px);
    if (got < 0) {
      dda_release(&d);
      Sleep(500);
      continue;
    }
    if (got == 0) {
      st.unchanged++;
    } else {
      t1 = now_ms();
      wc_find_and_decode(&px, &o->spec, have_hint ? &hint : NULL, &g_result);
      t2 = now_ms();
      dda_unmap(&d);
      st.frames++;
      st.grab_ms += t1 - t0;
      st.decode_ms += t2 - t1;
      if (t2 - t1 > st.decode_max_ms) st.decode_max_ms = t2 - t1;
      clear_error();
      wc_away_frame(&g_away);
      if (wc_measured(&g_result, &measured)) {
        /* A decode, or a strip cut off at a known pitch: the next crop holds it whole. */
        int want_w, want_h;
        have_measured = 1;
        wc_crop_size(&o->spec, &measured, o->width, o->height, &want_w, &want_h);
        grows = (want_w > crop_w && crop_w < client.right) || (want_h > crop_h && crop_h < client.bottom);
      }
      if (g_result.status == WC_DECODED) {
        st.decoded++;
        hint = g_result.geometry;
        have_hint = 1;
        emit_payload(&g_result);
      } else if (g_result.status == WC_REJECTED) {
        st.rejected++;
        if (strcmp(g_result.reason, "checksum") == 0) st.checksum++;
        else if (strcmp(g_result.reason, "length") == 0) st.length++;
        else st.truncated++;
        /* A strip cut off by a crop that is about to grow is expected once: no warning. */
        if (!grows && GetTickCount64() - last_reject_warn >= 5000) {
          wc_json j;
          last_reject_warn = GetTickCount64();
          snprintf(msg, sizeof msg, "strip seen but rejected: %s", g_result.reason);
          wc_json_init(&j, g_line, sizeof g_line);
          wc_json_raw(&j, "{");
          wc_json_key(&j, "warn", 1);
          wc_json_cstr(&j, msg);
          wc_json_key(&j, "geometry", 0);
          wc_json_geometry(&j, g_result.geometry.x0, g_result.geometry.y0, g_result.geometry.pitch);
          wc_json_raw(&j, "}");
          if (wc_json_end(&j) == 0) send_line(g_line, 1);
        }
      } else {
        st.idle++;
      }
    }
    sleep_ms = o->interval_ms - (int)(now_ms() - t0);
    if (sleep_ms < 10) sleep_ms = 10;
    Sleep((DWORD)sleep_ms);
  }
}

int wmain(int argc, wchar_t **argv) {
  options o;
  int pmv2;
  if (parse_options(argc, argv, &o) != 0) return 2;
  if (o.version) {
    printf("nqa-capture %s (protocol %d)\n", WC_VERSION, WC_PROTO);
    return 0;
  }
  wc_errlimit_init(&g_errors, 60000);
  wc_away_init(&g_away);
  pmv2 = enable_dpi_awareness();
  if (o.test_image) return test_image(&o);
  if (o.test_desktop) {
    /* Tests: the input desktop's name as DR-26 reads it (on an unlocked runner, "Default"). */
    wchar_t name[64];
    char utf8[200];
    wc_json j;
    wc_desk k = input_desktop(name, (DWORD)sizeof name);
    to_utf8(name, utf8, (int)sizeof utf8);
    wc_json_init(&j, g_line, sizeof g_line);
    wc_json_raw(&j, "{");
    wc_json_key(&j, "inputDesktop", 1);
    wc_json_cstr(&j, utf8);
    wc_json_key(&j, "verdict", 0);
    wc_json_cstr(&j, k == WC_DESK_DEFAULT ? "default" : k == WC_DESK_OTHER ? "other" : "unopenable");
    wc_json_raw(&j, "}");
    if (wc_json_end(&j) == 0) fputs(g_line, stdout);
    return 0;
  }
  open_log(o.log_path);
  g_out = GetStdHandle(STD_OUTPUT_HANDLE);
  if (g_out == NULL || g_out == INVALID_HANDLE_VALUE) return usage("no stdout to write to");
  {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    if (in && in != INVALID_HANDLE_VALUE && GetFileType(in) == FILE_TYPE_PIPE) g_parent = in;
  }
  start_stdin_watch();
  emit_start(&o, pmv2);
  say_away();
  if (!pmv2) emit_warn("not Per-Monitor v2 DPI aware: window coordinates may be scaled on high-DPI displays");
  run(&o);
  return 0;
}
