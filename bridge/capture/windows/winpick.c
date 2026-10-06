/* The Windows capture helper's pure decisions (display design DR-05, DR-26; SY-24). See winpick.h. */
#include "winpick.h"

#include <string.h>

#define WC_PATH_MAX 4096

static int fold(int c) { return c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c; }
static int is_sep(int c) { return c == '\\' || c == '/'; }

/* The path as it's compared: "\\?\" and "\??\" gone ("\\?\UNC\" back to "\\"), '/' as '\', ASCII in
 * lower case, no trailing separator. 0 when it doesn't fit. */
static int norm_path(const char *in, char *out, size_t cap) {
  const unsigned char *p = (const unsigned char *)in;
  size_t n = 0;
  if (!in || cap < 3) return 0;
  if ((is_sep(p[0]) && is_sep(p[1]) && p[2] == '?' && is_sep(p[3])) ||
      (is_sep(p[0]) && p[1] == '?' && p[2] == '?' && is_sep(p[3]))) {
    p += 4;
    if (fold(p[0]) == 'u' && fold(p[1]) == 'n' && fold(p[2]) == 'c' && is_sep(p[3])) {
      p += 4;
      out[n++] = '\\';
      out[n++] = '\\';
    }
  }
  for (; *p; p++) {
    if (n + 1 >= cap) return 0;
    out[n++] = is_sep(*p) ? '\\' : (char)fold(*p);
  }
  while (n > 0 && out[n - 1] == '\\') n--;
  out[n] = '\0';
  return 1;
}

const char *wc_pick_base(const char *path) {
  const char *b = path;
  for (; path && *path; path++) {
    if (is_sep((unsigned char)*path)) b = path + 1;
  }
  return b;
}

/* '*' matches any run; the rest matches one character, ASCII case folded. */
static int wild(const char *pat, const char *s) {
  const char *star = NULL, *back = NULL;
  while (*s) {
    if (*pat == '*') {
      star = pat++;
      back = s;
    } else if (*pat && fold((unsigned char)*pat) == fold((unsigned char)*s)) {
      pat++;
      s++;
    } else if (star) {
      pat = star + 1;
      s = ++back;
    } else {
      return 0;
    }
  }
  while (*pat == '*') pat++;
  return *pat == '\0';
}

/* The image's name without ".exe", from a normalized path (so in lower case); 0 when there's none. */
static int stem_of(const char *np, char *out, size_t cap) {
  const char *b = wc_pick_base(np);
  size_t n = strlen(b);
  if (n > 4 && strcmp(b + n - 4, ".exe") == 0) n -= 4;
  if (n == 0 || n >= cap) return 0;
  memcpy(out, b, n);
  out[n] = '\0';
  return 1;
}

/* Does the (lower case) name hold needle, its case folded? */
static int holds(const char *name, const char *needle) {
  size_t n = strlen(needle), i, k;
  if (n == 0) return 0;
  for (i = 0; name[i]; i++) {
    for (k = 0; k < n && name[i + k] && name[i + k] == (char)fold((unsigned char)needle[k]); k++) {
    }
    if (k == n) return 1;
  }
  return 0;
}

/* Is this folder name (len bytes of a normalized path) one of the flavors? */
static int is_flavor(const wc_pick_rules *r, const char *seg, size_t len) {
  int k;
  size_t i;
  for (k = 0; k < r->nflavors; k++) {
    const char *f = r->flavors[k];
    if (len == 0 || strlen(f) != len) continue;
    for (i = 0; i < len && seg[i] == (char)fold((unsigned char)f[i]); i++) {
    }
    if (i == len) return 1;
  }
  return 0;
}

/* Is one of the path's folders (never its file name) a flavor? */
static int in_flavor(const wc_pick_rules *r, const char *np) {
  const char *seg = np, *p;
  for (p = np; *p; p++) {
    if (*p != '\\') continue;
    if (is_flavor(r, seg, (size_t)(p - seg))) return 1;
    seg = p + 1;
  }
  return 0;
}

const char *wc_pick_refused(const wc_pick_rules *r, const wc_window *w) {
  char np[WC_PATH_MAX], stem[256];
  int k, named = 0;
  if (!w->path || !w->path[0] || !norm_path(w->path, np, sizeof np)) return "its path can't be read";
  if (!stem_of(np, stem, sizeof stem)) return "it has no image name";
  for (k = 0; k < r->nnames && !named; k++) named = wild(r->names[k], stem);
  if (!named) return "not a game name";
  for (k = 0; k < r->nnot_game; k++) {
    if (holds(stem, r->not_game[k])) return "the game's helper, not the game";
  }
  if (!in_flavor(r, np)) return "not in a game folder";
  if (!w->iconic && (w->width < 200 || w->height < 150)) return "too small (a launcher or a splash screen)";
  return NULL;
}

int wc_pick_under_exe_dir(const wc_pick_rules *r, const wc_window *w) {
  char np[WC_PATH_MAX], nd[WC_PATH_MAX];
  size_t n;
  if (!r->exe_dir || !r->exe_dir[0] || !w->path) return 0;
  if (!norm_path(w->path, np, sizeof np) || !norm_path(r->exe_dir, nd, sizeof nd)) return 0;
  n = strlen(nd);
  return n > 0 && strncmp(np, nd, n) == 0 && np[n] == '\\';
}

static long long area(const wc_window *w) { return w->iconic ? 0 : (long long)w->width * (long long)w->height; }

/* > 0: a is better than b; < 0: worse; 0: as good. */
static int rank_cmp(const wc_pick_rules *r, const wc_window *a, const wc_window *b) {
  int ea = wc_pick_under_exe_dir(r, a), eb = wc_pick_under_exe_dir(r, b);
  if (ea != eb) return ea - eb;
  if (a->iconic != b->iconic) return a->iconic ? -1 : 1;
  if (area(a) != area(b)) return area(a) > area(b) ? 1 : -1;
  return 0;
}

int wc_pick_best(const wc_pick_rules *r, const wc_window *ws, int n) {
  int k, best = -1;
  for (k = 0; k < n; k++) {
    if (wc_pick_refused(r, &ws[k])) continue;
    if (best < 0 || rank_cmp(r, &ws[k], &ws[best]) > 0) best = k;
  }
  return best;
}

wc_switch wc_pick_switch(const wc_pick_rules *r, const wc_window *ws, int attached, int best) {
  const wc_window *a, *b;
  int ea, eb;
  if (best < 0 || attached == best) return WC_STAY;
  if (attached < 0 || wc_pick_refused(r, &ws[attached])) return WC_SWITCH_GONE;
  a = &ws[attached];
  b = &ws[best];
  ea = wc_pick_under_exe_dir(r, a);
  eb = wc_pick_under_exe_dir(r, b);
  if (ea != eb) return eb ? WC_SWITCH_EXE_DIR : WC_STAY;
  if (a->iconic != b->iconic) return a->iconic ? WC_SWITCH_VISIBLE : WC_STAY;
  return area(b) > area(a) ? WC_SWITCH_LARGER : WC_STAY;
}

const char *wc_switch_text(wc_switch s) {
  switch (s) {
    case WC_SWITCH_GONE: return "the attached window is gone, or no longer the game's";
    case WC_SWITCH_EXE_DIR: return "it is in the game folder the bridge serves, the attached one isn't";
    case WC_SWITCH_VISIBLE: return "it is visible, the attached one is minimized";
    case WC_SWITCH_LARGER: return "it is larger";
    case WC_STAY: break;
  }
  return "";
}

void wc_away_init(wc_away *a) {
  a->locked = 0;
  a->sent = -1;
  a->sent_at = 0;
}

int wc_away_open_failed(wc_away *a, wc_dup_fail why, wc_desk desk) {
  if (why == WC_DUP_OTHER) return 0;
  a->locked = desk != WC_DESK_DEFAULT;
  return a->locked;
}

void wc_away_frame(wc_away *a) { a->locked = 0; }

int wc_away_due(wc_away *a, unsigned long long now_ms) {
  if (a->sent == a->locked) return 0;
  if (a->sent >= 0 && now_ms - a->sent_at < 1000) return 0;
  a->sent = a->locked;
  a->sent_at = now_ms;
  return 1;
}

int wc_open_may_try(wc_open_backoff *b, unsigned long long monitor, unsigned long long now_ms) {
  if (monitor != b->monitor) {
    b->monitor = monitor;
    b->fails = 0;
    b->after = 0;
  }
  return now_ms >= b->after;
}

void wc_open_result(wc_open_backoff *b, unsigned long long monitor, int unsupported, unsigned long long now_ms) {
  if (monitor != b->monitor) {
    b->monitor = monitor;
    b->fails = 0;
  }
  if (!unsupported) {
    b->fails = 0;
    b->after = 0;
    return;
  }
  if (b->fails < 3) b->fails++;
  b->after = now_ms + (b->fails == 1 ? 2000 : b->fails == 2 ? 10000 : 60000);
}
