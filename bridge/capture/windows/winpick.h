/* The Windows capture helper's pure decisions (display design DR-05 and DR-26, and SY-24's retry
 * wait), portable C with no
 * Windows headers, like decoder.c and errlimit.c: the helper (main.c) and the native test harness
 * (decode_raw.c --pick, --lock, --open) run the same code. The window pick is the counterpart of the Mac
 * helper's WindowPick.
 *
 * Which window is the game's. The helper took any Wow*.exe's largest window for the game, WowUp.exe
 * (the addon manager) included, and never looked again while that window stayed up (display audit
 * D-03). Now a window may be the game's only when:
 *   - its process image's name matches --process-name (Wow* by default; ".exe" aside);
 *   - its image's full path has a folder named as one of the bridge's --flavor-dir (FOREVER_FLAVORS:
 *     _forever_, _classic_beta_), compared without case. No exe name is guessed: any Wow*.exe in an
 *     install's flavor folder is the game, and WowUp (%LOCALAPPDATA%\Programs\WowUp) never is. With
 *     no --flavor-dir nothing is;
 *   - its name holds no --not-game stem (VoiceProxy, Error: the game's own voice proxy and crash
 *     reporter live in the flavor folder, and the crash reporter's dialog is big enough to pass;
 *     systems critic SY-05);
 *   - its path could be read;
 *   - minimized, or at least 200 x 150 (smaller is a launcher or a splash screen).
 * Among those the best is: under --exe-dir (the install the bridge serves; a case, 8.3, junction or
 * SUBST difference only loses this preference), then visible over minimized, then the largest.
 * Paths are UTF-8, "\\?\" and "\??\" prefixes aside, either slash; case is folded for ASCII only
 * (flavor folders and exe names are ASCII). */
#ifndef NQA_WINPICK_H
#define NQA_WINPICK_H

#include <stddef.h>

#define WC_PICK_LIST 16

typedef struct {
  const char *names[WC_PICK_LIST];     /* --process-name patterns, without ".exe"; '*' is a wildcard */
  int nnames;
  const char *flavors[WC_PICK_LIST];   /* --flavor-dir: folder names */
  int nflavors;
  const char *not_game[WC_PICK_LIST];  /* --not-game: stems an image name mustn't hold */
  int nnot_game;
  const char *exe_dir;                 /* --exe-dir, or NULL */
} wc_pick_rules;

typedef struct {
  unsigned long long id;               /* the window */
  unsigned long pid;
  const char *path;                    /* the process image's full path, UTF-8; NULL when unreadable */
  int iconic;                          /* minimized */
  long width, height;                  /* the client area (nothing counts while minimized) */
} wc_window;

/* NULL when w may be the game's window, else why not (a static string). */
const char *wc_pick_refused(const wc_pick_rules *r, const wc_window *w);

/* 1 when w's image is under --exe-dir. */
int wc_pick_under_exe_dir(const wc_pick_rules *r, const wc_window *w);

/* The best of the n windows, the refused ones skipped: its index, or -1. A tie keeps the first. */
int wc_pick_best(const wc_pick_rules *r, const wc_window *ws, int n);

typedef enum {
  WC_STAY = 0,
  WC_SWITCH_GONE,       /* the attached window is gone, or no longer the game's */
  WC_SWITCH_EXE_DIR,    /* the best is under --exe-dir, the attached one isn't */
  WC_SWITCH_VISIBLE,    /* the best is visible, the attached one minimized */
  WC_SWITCH_LARGER      /* the best is larger */
} wc_switch;

/* Attached to ws[attached] (-1: gone), with ws[best] the best (-1: none): whether to move there. Only
 * for a better window by the order above, never for the same one; a tie stays. */
wc_switch wc_pick_switch(const wc_pick_rules *r, const wc_window *ws, int attached, int best);

/* Why, for the helper's log line. */
const char *wc_switch_text(wc_switch s);

/* The image's file name (after the last slash). */
const char *wc_pick_base(const char *path);

/* Is the session locked (display design DR-26)? The lock screen and a UAC prompt run on the
 * "Winlogon" desktop, and Desktop Duplication can't read it: DuplicateOutput fails with
 * E_ACCESSDENIED (or DXGI_ERROR_SESSION_DISCONNECTED for a disconnected session). That is "locked"
 * only when the input desktop confirms it: not "Default", or not even openable (a normal process
 * can't open Winlogon's). Any other access denied stays the typed access_lost, which the bridge can
 * restart for. The first frame grabbed clears it. The helper says it on a line of its own,
 * {"away":"locked"} or {"away":null}, on every change (at most once a second, never through the
 * typed errors' once-a-minute limiter) and once when it starts. */
typedef enum { WC_DUP_OTHER = 0, WC_DUP_ACCESS_DENIED, WC_DUP_SESSION_DISCONNECTED } wc_dup_fail;
typedef enum { WC_DESK_DEFAULT = 0, WC_DESK_OTHER, WC_DESK_UNOPENABLE } wc_desk;

typedef struct {
  int locked;                 /* now */
  int sent;                   /* what the bridge was told: -1 nothing yet, 0 null, 1 locked */
  unsigned long long sent_at; /* when (ms) */
} wc_away;

void wc_away_init(wc_away *a);

/* DuplicateOutput failed this way while the input desktop is this: 1 when that's the lock (no typed
 * access_lost then), 0 when access_lost stays typed. Another failure changes nothing and says 0. */
int wc_away_open_failed(wc_away *a, wc_dup_fail why, wc_desk desk);

/* A frame was grabbed: nothing is locked. */
void wc_away_frame(wc_away *a);

/* 1 when the away line is due at now_ms (and it counts as sent): the state differs from what the
 * bridge was told, and a second has passed since the last line (the first goes at once). */
int wc_away_due(wc_away *a, unsigned long long now_ms);

/* Opening Desktop Duplication on a monitor where it's unsupported (a hybrid-GPU laptop's panel seen
 * from the other GPU, more than four capturers, a rotated display, no D3D11) fails the same way every
 * time: tried again after 2 s, then 10 s, then every 60 s, not every 2 s forever (a D3D11 device
 * each time; systems critic r5 SY-24). Another monitor, a success or any other failure (the lock, which
 * must come back within 2 s of the unlock) starts over. */
typedef struct {
  unsigned long long monitor;   /* the monitor the failures were on */
  int fails;                    /* unsupported failures in a row there */
  unsigned long long after;     /* no try before this (ms) */
} wc_open_backoff;

/* May the helper try to open duplication on this monitor at now_ms? */
int wc_open_may_try(wc_open_backoff *b, unsigned long long monitor, unsigned long long now_ms);

/* What the try on this monitor at now_ms gave: 1 unsupported, 0 anything else. */
void wc_open_result(wc_open_backoff *b, unsigned long long monitor, int unsupported, unsigned long long now_ms);

#endif
