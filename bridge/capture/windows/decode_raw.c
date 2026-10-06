/* Native test harness for the Windows helper's portable parts (PRD §11.3, DB11).
 *
 * Built with the host's cc by tests/byok/capture_windows_decoder_test.mjs; the
 * Windows helper never includes it. Decodes binary PPM fixtures (raw RGB) and
 * prints one JSON line per file, through the same JSON writer the helper uses:
 *
 *   decode_raw [--magic C72C] [--hint x0,y0,pitch] [--repeat N]
 *              [--bgra-stride N | --rgba-stride N] [--crop WxH [--frames N]] a.ppm [b.ppm ...]
 *   -> {"file":"a.ppm","status":"decoded","id":7,"bytes":12,"text":"...","geometry":{...},"ms":0.4}
 *      {"file":"b.ppm","status":"rejected","reason":"checksum","geometry":{...},"ms":0.9}
 *      {"file":"c.ppm","status":"none","ms":0.2}
 *
 *   --bgra-stride N   hand the decoder what DXGI maps: 4 bytes a pixel in B, G, R, A
 *                     order, rows N bytes apart (N >= 4 * width; 0 means 4 * width),
 *                     the padding and alpha filled with junk. --rgba-stride: R, G, B, A.
 *   --crop WxH        decode the top-left W x H, the way the helper crops the window,
 *   --frames N        for N frames of the same image, each crop sized by the helper's
 *                     own rule (wc_crop_size after wc_measured); the line adds "crop".
 *
 *   decode_raw --errors < script   the helper's typed-error limiter (errlimit.c): each
 *                     input line "MS set KIND" or "MS clear" prints "error KIND",
 *                     "capturing" or "quiet".
 *
 *   decode_raw --pick < script     which window is the game's (winpick.c, DR-05). Lines:
 *                     "name Wow*", "flavor _forever_", "notgame Error", "exedir <path>",
 *                     "window ID PID ICONIC WIDTH HEIGHT <path to the end of the line, or ->",
 *                     "attached ID"; prints one line:
 *                     {"best":ID|null,"switch":"why"|null,"windows":[{"id","refused","underExeDir"}]}
 *
 *   decode_raw --lock < script     the session lock and its away line (winpick.c, DR-26). Lines
 *                     "MS open denied|disconnected|other DESK" (DESK: default, other, unopenable),
 *                     "MS frame" or "MS tick" each print what the helper would send after it:
 *                     "access_lost", "away locked", "away null", joined by " + ", or "quiet".
 *
 *   decode_raw --open < script     the wait between tries to open duplication (winpick.c, SY-24).
 *                     "MS try MONITOR" prints "try" or "wait"; "MS unsupported MONITOR" and
 *                     "MS ok MONITOR" say what a try gave, and print nothing. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "decoder.h"
#include "errlimit.h"
#include "jsonl.h"
#include "ppm.h"
#include "winpick.h"

static char line[1 << 16];
static wc_result result;

typedef struct {
  const wc_geometry *hint;
  int repeat;
  int bpp4;          /* 0: RGB as read; 1: BGRA; 2: RGBA */
  size_t stride4;    /* bytes per row with bpp4 (0: 4 * width) */
  int crop_w, crop_h, frames;
} run_opts;

static void print_error(const char *file, const char *msg) {
  wc_json j;
  wc_json_init(&j, line, sizeof line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "file", 1);
  wc_json_cstr(&j, file);
  wc_json_key(&j, "error", 0);
  wc_json_cstr(&j, msg);
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) fputs(line, stdout);
}

/* The RGB image as 4-byte pixels with padded rows; junk in the alpha and the padding. */
static uint8_t *four_bytes(const wc_ppm *img, int bgra, size_t stride) {
  uint8_t *out = malloc(stride * (size_t)img->height);
  int x, y;
  if (!out) return NULL;
  memset(out, 0xAB, stride * (size_t)img->height);
  for (y = 0; y < img->height; y++) {
    for (x = 0; x < img->width; x++) {
      const uint8_t *s = img->rgb + ((size_t)y * (size_t)img->width + (size_t)x) * 3;
      uint8_t *d = out + (size_t)y * stride + (size_t)x * 4;
      d[0] = bgra ? s[2] : s[0];
      d[1] = s[1];
      d[2] = bgra ? s[0] : s[2];
      d[3] = 0x5A;
    }
  }
  return out;
}

static void decode_file(const char *file, const wc_spec *spec, const run_opts *ro) {
  wc_ppm img;
  wc_pixels px, view;
  wc_json j;
  wc_geometry measured, hint;
  const wc_geometry *use_hint = ro->hint;
  uint8_t *pixels4 = NULL;
  const char *err = NULL;
  clock_t t0;
  double ms;
  int k, frame, have_measured = 0, cw = 0, ch = 0;
  FILE *f = fopen(file, "rb");
  if (!f) {
    print_error(file, "cannot open");
    return;
  }
  if (wc_ppm_read(f, &img, &err) != 0) {
    fclose(f);
    print_error(file, err);
    return;
  }
  fclose(f);
  px.width = img.width;
  px.height = img.height;
  if (ro->bpp4) {
    size_t stride = ro->stride4 ? ro->stride4 : (size_t)img.width * 4;
    if (stride < (size_t)img.width * 4) {
      print_error(file, "--bgra-stride/--rgba-stride is narrower than the image");
      wc_ppm_free(&img);
      return;
    }
    pixels4 = four_bytes(&img, ro->bpp4 == 1, stride);
    if (!pixels4) {
      print_error(file, "out of memory");
      wc_ppm_free(&img);
      return;
    }
    px.stride = stride;
    px.base = pixels4;
    px.bpp = 4;
    px.bgr = ro->bpp4 == 1;
  } else {
    px.stride = (size_t)img.width * 3;
    px.base = img.rgb;
    px.bpp = 3;
    px.bgr = 0;
  }

  t0 = clock();
  for (frame = 0; frame < (ro->crop_w ? ro->frames : 1); frame++) {
    view = px;
    if (ro->crop_w) {
      /* The helper's rule: the configured region, grown to the last measurement. */
      wc_crop_size(spec, have_measured ? &measured : NULL, ro->crop_w, ro->crop_h, &cw, &ch);
      if (cw < view.width) view.width = cw;
      if (ch < view.height) view.height = ch;
      cw = view.width;
      ch = view.height;
    }
    for (k = 0; k < ro->repeat; k++) wc_find_and_decode(&view, spec, use_hint, &result);
    if (wc_measured(&result, &measured)) have_measured = 1;
    if (result.status == WC_DECODED) {
      hint = result.geometry;
      use_hint = &hint;
    }
  }
  ms = (double)(clock() - t0) * 1000.0 / CLOCKS_PER_SEC / ro->repeat / (ro->crop_w ? ro->frames : 1);

  wc_json_init(&j, line, sizeof line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "file", 1);
  wc_json_cstr(&j, file);
  wc_json_key(&j, "status", 0);
  wc_json_cstr(&j, result.status == WC_DECODED ? "decoded" : result.status == WC_REJECTED ? "rejected" : "none");
  if (result.status == WC_DECODED) {
    wc_json_key(&j, "id", 0);
    wc_json_int(&j, result.id);
    wc_json_key(&j, "bytes", 0);
    wc_json_int(&j, (long long)result.len);
    wc_json_key(&j, "text", 0);
    wc_json_str(&j, wc_payload(&result), result.len);
  }
  if (result.status == WC_REJECTED) {
    wc_json_key(&j, "reason", 0);
    wc_json_cstr(&j, result.reason);
  }
  if (result.status != WC_NONE) {
    wc_json_key(&j, "geometry", 0);
    wc_json_geometry(&j, result.geometry.x0, result.geometry.y0, result.geometry.pitch);
  }
  if (ro->crop_w) {
    wc_json_key(&j, "crop", 0);
    wc_json_raw(&j, "{");
    wc_json_key(&j, "width", 1);
    wc_json_int(&j, cw);
    wc_json_key(&j, "height", 0);
    wc_json_int(&j, ch);
    wc_json_raw(&j, "}");
  }
  wc_json_key(&j, "ms", 0);
  wc_json_num(&j, ms);
  wc_json_raw(&j, "}");
  if (wc_json_end(&j) == 0) fputs(line, stdout);
  else print_error(file, "output line too long");
  free(pixels4);
  wc_ppm_free(&img);
}

/* The typed-error limiter, driven by "MS set KIND" / "MS clear" lines on stdin. */
static int run_errors(void) {
  static char kinds[64][40];
  wc_errlimit e;
  char buf[200];
  int nkinds = 0;
  wc_errlimit_init(&e, 60000);
  while (fgets(buf, sizeof buf, stdin)) {
    unsigned long long ms;
    char verb[16], kind[40];
    int n = sscanf(buf, "%llu %15s %39s", &ms, verb, kind);
    if (n >= 2 && strcmp(verb, "clear") == 0) {
      puts(wc_errlimit_clear(&e) ? "capturing" : "quiet");
    } else if (n == 3 && strcmp(verb, "set") == 0) {
      /* The helper passes static strings; keep one stable copy per distinct kind. */
      const char *stable = NULL;
      int k;
      for (k = 0; k < nkinds; k++) if (strcmp(kinds[k], kind) == 0) stable = kinds[k];
      if (!stable && nkinds < 64) stable = strcpy(kinds[nkinds++], kind);
      if (!stable) return 2;
      if (wc_errlimit_set(&e, stable, ms)) printf("error %s\n", stable);
      else puts("quiet");
    } else {
      fprintf(stderr, "decode_raw --errors: bad line %s", buf);
      return 2;
    }
  }
  return 0;
}

/* winpick.c's decision on a list of windows, driven by a script on stdin (see the top). */
#define PICK_WINDOWS 32
static int run_pick(void) {
  static char names[WC_PICK_LIST][64], flavors[WC_PICK_LIST][64], not_game[WC_PICK_LIST][64], exe_dir[4096];
  static char paths[PICK_WINDOWS][4096];
  wc_window ws[PICK_WINDOWS];
  wc_pick_rules r;
  char buf[4300];
  unsigned long long attached_id = 0;
  int n = 0, have_attached = 0, best, attached = -1, k;
  wc_switch sw;
  wc_json j;
  memset(&r, 0, sizeof r);
  while (fgets(buf, sizeof buf, stdin)) {
    size_t len = strlen(buf);
    char *v;
    while (len > 0 && (buf[len - 1] == '\n' || buf[len - 1] == '\r')) buf[--len] = '\0';
    v = strchr(buf, ' ');
    if (!v) continue;
    *v++ = '\0';
    if (strcmp(buf, "name") == 0 && r.nnames < WC_PICK_LIST && strlen(v) < 64) {
      r.names[r.nnames] = strcpy(names[r.nnames], v);
      r.nnames++;
    } else if (strcmp(buf, "flavor") == 0 && r.nflavors < WC_PICK_LIST && strlen(v) < 64) {
      r.flavors[r.nflavors] = strcpy(flavors[r.nflavors], v);
      r.nflavors++;
    } else if (strcmp(buf, "notgame") == 0 && r.nnot_game < WC_PICK_LIST && strlen(v) < 64) {
      r.not_game[r.nnot_game] = strcpy(not_game[r.nnot_game], v);
      r.nnot_game++;
    } else if (strcmp(buf, "exedir") == 0 && strlen(v) < sizeof exe_dir) {
      r.exe_dir = strcpy(exe_dir, v);
    } else if (strcmp(buf, "window") == 0 && n < PICK_WINDOWS) {
      int iconic = 0, used = 0;
      long w = 0, h = 0;
      unsigned long long id = 0;
      unsigned long pid = 0;
      if (sscanf(v, "%llu %lu %d %ld %ld %n", &id, &pid, &iconic, &w, &h, &used) < 5 || used == 0) {
        fprintf(stderr, "decode_raw --pick: bad window line: %s\n", v);
        return 2;
      }
      ws[n].id = id;
      ws[n].pid = pid;
      ws[n].iconic = iconic;
      ws[n].width = w;
      ws[n].height = h;
      ws[n].path = strcmp(v + used, "-") == 0 ? NULL : strcpy(paths[n], v + used);
      n++;
    } else if (strcmp(buf, "attached") == 0) {
      attached_id = strtoull(v, NULL, 10);
      have_attached = 1;
    } else {
      fprintf(stderr, "decode_raw --pick: bad line: %s %s\n", buf, v);
      return 2;
    }
  }
  for (k = 0; k < n; k++) if (have_attached && ws[k].id == attached_id) attached = k;
  best = wc_pick_best(&r, ws, n);
  sw = have_attached ? wc_pick_switch(&r, ws, attached, best) : WC_STAY;
  wc_json_init(&j, line, sizeof line);
  wc_json_raw(&j, "{");
  wc_json_key(&j, "best", 1);
  if (best < 0) wc_json_raw(&j, "null");
  else wc_json_int(&j, (long long)ws[best].id);
  wc_json_key(&j, "switch", 0);
  if (sw == WC_STAY) wc_json_raw(&j, "null");
  else wc_json_cstr(&j, wc_switch_text(sw));
  wc_json_key(&j, "windows", 0);
  wc_json_raw(&j, "[");
  for (k = 0; k < n; k++) {
    const char *why = wc_pick_refused(&r, &ws[k]);
    if (k) wc_json_raw(&j, ",");
    wc_json_raw(&j, "{");
    wc_json_key(&j, "id", 1);
    wc_json_int(&j, (long long)ws[k].id);
    wc_json_key(&j, "refused", 0);
    if (why) wc_json_cstr(&j, why);
    else wc_json_raw(&j, "null");
    wc_json_key(&j, "underExeDir", 0);
    wc_json_raw(&j, wc_pick_under_exe_dir(&r, &ws[k]) ? "true" : "false");
    wc_json_raw(&j, "}");
  }
  wc_json_raw(&j, "]}");
  if (wc_json_end(&j) != 0) return 2;
  fputs(line, stdout);
  return 0;
}

/* winpick.c's lock decision and away line, driven by a script on stdin (see the top). */
static int run_lock(void) {
  wc_away a;
  char buf[200];
  wc_away_init(&a);
  while (fgets(buf, sizeof buf, stdin)) {
    unsigned long long ms;
    char verb[16], why[16] = "", desk[16] = "";
    char said[64] = "";
    int n = sscanf(buf, "%llu %15s %15s %15s", &ms, verb, why, desk);
    if (n >= 2 && strcmp(verb, "open") == 0 && n == 4) {
      wc_dup_fail f = strcmp(why, "denied") == 0 ? WC_DUP_ACCESS_DENIED : strcmp(why, "disconnected") == 0 ? WC_DUP_SESSION_DISCONNECTED : WC_DUP_OTHER;
      wc_desk d = strcmp(desk, "default") == 0 ? WC_DESK_DEFAULT : strcmp(desk, "unopenable") == 0 ? WC_DESK_UNOPENABLE : WC_DESK_OTHER;
      if (!wc_away_open_failed(&a, f, d) && f != WC_DUP_OTHER) strcat(said, "access_lost");
    } else if (n == 2 && strcmp(verb, "frame") == 0) {
      wc_away_frame(&a);
    } else if (!(n == 2 && strcmp(verb, "tick") == 0)) {
      fprintf(stderr, "decode_raw --lock: bad line %s", buf);
      return 2;
    }
    if (wc_away_due(&a, ms)) {
      if (said[0]) strcat(said, " + ");
      strcat(said, a.locked ? "away locked" : "away null");
    }
    puts(said[0] ? said : "quiet");
  }
  return 0;
}

/* winpick.c's wait between tries to open duplication, driven by a script on stdin (see the top). */
static int run_open(void) {
  wc_open_backoff b;
  char buf[200];
  memset(&b, 0, sizeof b);
  while (fgets(buf, sizeof buf, stdin)) {
    unsigned long long ms, monitor;
    char verb[16];
    if (sscanf(buf, "%llu %15s %llu", &ms, verb, &monitor) != 3) {
      fprintf(stderr, "decode_raw --open: bad line %s", buf);
      return 2;
    }
    if (strcmp(verb, "try") == 0) puts(wc_open_may_try(&b, monitor, ms) ? "try" : "wait");
    else if (strcmp(verb, "unsupported") == 0 || strcmp(verb, "ok") == 0) wc_open_result(&b, monitor, verb[0] == 'u', ms);
    else {
      fprintf(stderr, "decode_raw --open: bad line %s", buf);
      return 2;
    }
  }
  return 0;
}

static int parse_size(const char *s, int *w, int *h) {
  return sscanf(s, "%dx%d", w, h) == 2 && *w > 0 && *h > 0 ? 0 : -1;
}

/* --hint x0,y0,pitch. "nan", "inf" and "-inf" are read here rather than by the C library, whose
 * scanf on some Windows runtimes reads neither: the decoder's check of a geometry that isn't
 * finite (decoder.c, code health LS-12) is tested with them. */
static int parse_hint_value(const char *s, size_t n, double *v) {
  char buf[64], *end;
  if (n == 0 || n >= sizeof buf) return -1;
  memcpy(buf, s, n);
  buf[n] = '\0';
  if (strcmp(buf, "nan") == 0) { *v = NAN; return 0; }
  if (strcmp(buf, "inf") == 0) { *v = INFINITY; return 0; }
  if (strcmp(buf, "-inf") == 0) { *v = -INFINITY; return 0; }
  *v = strtod(buf, &end);
  return *end == '\0' ? 0 : -1;
}

static int parse_hint(const char *s, wc_geometry *g) {
  double *out[3];
  int k;
  out[0] = &g->x0;
  out[1] = &g->y0;
  out[2] = &g->pitch;
  for (k = 0; k < 3; k++) {
    const char *comma = strchr(s, ',');
    size_t n = k < 2 ? (comma ? (size_t)(comma - s) : 0) : strlen(s);
    if ((k < 2 && !comma) || (k == 2 && comma) || parse_hint_value(s, n, out[k]) != 0) return -1;
    if (k < 2) s = comma + 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  wc_spec spec;
  wc_geometry hint;
  run_opts ro;
  int i;
  wc_spec_default(&spec);
  memset(&ro, 0, sizeof ro);
  ro.repeat = 1;
  ro.frames = 1;
  if (argc == 2 && strcmp(argv[1], "--errors") == 0) return run_errors();
  if (argc == 2 && strcmp(argv[1], "--pick") == 0) return run_pick();
  if (argc == 2 && strcmp(argv[1], "--lock") == 0) return run_lock();
  if (argc == 2 && strcmp(argv[1], "--open") == 0) return run_open();
  for (i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--magic") == 0 && i + 1 < argc) {
      if (wc_parse_magic(argv[++i], spec.magic) != 0) {
        fprintf(stderr, "decode_raw: bad --magic %s\n", argv[i]);
        return 2;
      }
    } else if (strcmp(argv[i], "--hint") == 0 && i + 1 < argc) {
      if (parse_hint(argv[++i], &hint) != 0) {
        fprintf(stderr, "decode_raw: bad --hint %s\n", argv[i]);
        return 2;
      }
      ro.hint = &hint;
    } else if (strcmp(argv[i], "--repeat") == 0 && i + 1 < argc) {
      ro.repeat = atoi(argv[++i]);
      if (ro.repeat < 1) ro.repeat = 1;
    } else if ((strcmp(argv[i], "--bgra-stride") == 0 || strcmp(argv[i], "--rgba-stride") == 0) && i + 1 < argc) {
      ro.bpp4 = argv[i][2] == 'b' ? 1 : 2;
      ro.stride4 = (size_t)strtoul(argv[++i], NULL, 10);
    } else if (strcmp(argv[i], "--crop") == 0 && i + 1 < argc) {
      if (parse_size(argv[++i], &ro.crop_w, &ro.crop_h) != 0) {
        fprintf(stderr, "decode_raw: bad --crop %s (WxH)\n", argv[i]);
        return 2;
      }
    } else if (strcmp(argv[i], "--frames") == 0 && i + 1 < argc) {
      ro.frames = atoi(argv[++i]);
      if (ro.frames < 1) ro.frames = 1;
    } else {
      decode_file(argv[i], &spec, &ro);
    }
  }
  return 0;
}
