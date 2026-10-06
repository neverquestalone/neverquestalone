/* NeverQuestAlone strip decoder, portable C (PRD §11.3, DB11). See decoder.h.
 * Each function mirrors its namesake in StripDecoder.swift; keep them in step. */
#include "decoder.h"

#include <math.h>
#include <string.h>

void wc_spec_default(wc_spec *spec) {
  spec->cells = 200;
  spec->rows = 48;
  spec->magic[0] = 0xC7;
  spec->magic[1] = 0x2C;
  spec->search_rows = 80;
  spec->search_cols = 32;
  spec->min_pitch = 2.5;
  spec->max_pitch = 12.0;
}

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int wc_parse_magic(const char *text, uint8_t magic[2]) {
  int digits[4];
  int n = 0;
  if (!text) return -1;
  if (text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) text += 2;
  for (; *text; text++) {
    int d;
    if (*text == ' ') continue;
    d = hex_digit(*text);
    if (d < 0 || n == 4) return -1;
    digits[n++] = d;
  }
  if (n != 4) return -1;
  magic[0] = (uint8_t)(digits[0] << 4 | digits[1]);
  magic[1] = (uint8_t)(digits[2] << 4 | digits[3]);
  return 0;
}

int wc_cell(const wc_pixels *px, int x, int y) {
  const uint8_t *p = px->base + (size_t)y * px->stride + (size_t)x * (size_t)px->bpp;
  int r = px->bgr ? p[2] : p[0];
  int g = p[1];
  int b = px->bgr ? p[0] : p[2];
  return (r >= 128 ? 4 : 0) | (g >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0);
}

static void set_none(wc_result *out, const wc_geometry *g) {
  out->status = WC_NONE;
  out->reason = NULL;
  out->geometry = *g;
  out->id = 0;
  out->len = 0;
}

static void set_rejected(wc_result *out, const wc_geometry *g, const char *reason) {
  set_none(out, g);
  out->status = WC_REJECTED;
  out->reason = reason;
}

/* A geometry from outside the search (a caller's hint) may be NaN or infinite. Every
 * comparison with NaN is false, so such a geometry would pass the bounds checks below
 * and turn into a pixel far outside the picture: (int)NaN is INT_MIN on x86-64
 * (code health LS-12). */
static int geometry_finite(const wc_geometry *g) {
  return isfinite(g->x0) && isfinite(g->y0) && isfinite(g->pitch);
}

void wc_decode(const wc_pixels *px, const wc_geometry *g, const wc_spec *spec, wc_result *out) {
  uint32_t acc = 0;
  int nbits = 0;
  size_t n = 0, needed = 6, len, k;
  long total = (long)spec->cells * (long)spec->rows;
  size_t limit = (size_t)(total * 3 / 8);
  long i;
  int s1 = 0, s2 = 0;

  if (limit > WC_MAX_FRAME_BYTES) limit = WC_MAX_FRAME_BYTES;
  set_none(out, g);
  if (!geometry_finite(g)) return;
  for (i = 0; i < total && n < needed; i++) {
    long c = i % spec->cells, r = i / spec->cells;
    double fx = floor(g->x0 + ((double)c + 0.5) * g->pitch);
    double fy = floor(g->y0 + ((double)r + 0.5) * g->pitch);
    if (fx < 0 || fy < 0 || fx >= px->width || fy >= px->height) {
      if (n >= 2) set_rejected(out, g, "truncated");
      return;
    }
    acc = (acc << 3) | (uint32_t)wc_cell(px, (int)fx, (int)fy);
    nbits += 3;
    while (nbits >= 8) {
      out->bytes[n++] = (uint8_t)((acc >> (nbits - 8)) & 0xFF);
      nbits -= 8;
      acc &= (1u << nbits) - 1u;
      if (n == 2 && (out->bytes[0] != spec->magic[0] || out->bytes[1] != spec->magic[1])) return;
      if (n == 6) {
        needed = 8 + ((size_t)out->bytes[4] << 8 | out->bytes[5]);
        if (needed > limit) {
          set_rejected(out, g, "length");
          return;
        }
      }
      if (n >= needed) break;
    }
  }
  if (n < needed) {
    set_rejected(out, g, "truncated");
    return;
  }
  len = (size_t)out->bytes[4] << 8 | out->bytes[5];
  for (k = 2; k < 6 + len; k++) {
    s1 = (s1 + out->bytes[k]) % 255;
    s2 = (s2 + s1) % 255;
  }
  if (out->bytes[6 + len] != s1 || out->bytes[7 + len] != s2) {
    set_rejected(out, g, "checksum");
    return;
  }
  out->status = WC_DECODED;
  out->id = out->bytes[2] << 8 | out->bytes[3];
  out->len = len;
}

/* The first cells of any strip, from the magic bytes: 16 bits make five whole
 * 3-bit cells (the sixth mixes in the id). Equal neighbours merge into one run. */
typedef struct { int value, cells; } magic_run;

static int magic_runs(const wc_spec *spec, magic_run runs[5]) {
  uint32_t m = (uint32_t)spec->magic[0] << 8 | spec->magic[1];
  int count = 0, k;
  for (k = 0; k < 5; k++) {
    int v = (int)((m >> (13 - 3 * k)) & 7);
    if (count > 0 && runs[count - 1].value == v) {
      runs[count - 1].cells += 1;
    } else {
      runs[count].value = v;
      runs[count].cells = 1;
      count++;
    }
  }
  return count;
}

typedef struct { int value, start, len; } pixel_run;

#define WC_MAX_RUNS 1024

int wc_estimate(const wc_pixels *px, const wc_spec *spec, wc_geometry *found, int max_found) {
  magic_run want[5];
  pixel_run runs[WC_MAX_RUNS], merged[WC_MAX_RUNS];
  int nwant = magic_runs(spec, want);
  int nfound = 0, y;
  int max_y = spec->search_rows < px->height ? spec->search_rows : px->height;
  int max_x = spec->search_cols < px->width ? spec->search_cols : px->width;

  if (nwant < 2) return 0;
  for (y = 0; y < max_y && nfound < max_found; y++) {
    int x = 0, limit, xx, cur, start, nruns = 0, nmerged = 0, k, ok, cells_before = 0, dup;
    double p;
    while (x < max_x && wc_cell(px, x, y) != want[0].value) x++;
    if (x >= max_x) continue;
    /* Run lengths along the row, ignoring 1-pixel blips (blended edges). Scan a
     * fixed span (six cells at the largest pitch) rather than a run count: blips
     * are runs too, and counting them would cut the last magic run short. */
    limit = x + (int)(spec->max_pitch * 6) + 4;
    if (limit > px->width) limit = px->width;
    if (limit - x > WC_MAX_RUNS - 1) limit = x + WC_MAX_RUNS - 1;
    cur = wc_cell(px, x, y);
    start = x;
    for (xx = x + 1; xx < limit; xx++) {
      int v = wc_cell(px, xx, y);
      if (v != cur) {
        runs[nruns].value = cur;
        runs[nruns].start = start;
        runs[nruns].len = xx - start;
        nruns++;
        cur = v;
        start = xx;
      }
    }
    runs[nruns].value = cur;
    runs[nruns].start = start;
    runs[nruns].len = xx - start;
    nruns++;
    for (k = 0; k < nruns; k++) {
      if (runs[k].len <= 1 && nmerged > 0) {
        merged[nmerged - 1].len += runs[k].len;
        continue;
      }
      if (nmerged > 0 && merged[nmerged - 1].value == runs[k].value) {
        merged[nmerged - 1].len += runs[k].len;
      } else {
        merged[nmerged++] = runs[k];
      }
    }
    if (nmerged < nwant) continue;
    ok = 1;
    for (k = 0; k < nwant; k++) {
      if (merged[k].value != want[k].value) { ok = 0; break; }
    }
    if (!ok) continue;
    /* Pitch from the start of the last magic run. */
    for (k = 0; k < nwant - 1; k++) cells_before += want[k].cells;
    p = (double)(merged[nwant - 1].start - merged[0].start) / (double)cells_before;
    if (p < spec->min_pitch || p > spec->max_pitch) continue;
    for (k = 0; k < nwant - 1; k++) {
      double expect = p * want[k].cells;
      if (merged[k].len < expect * 0.5 || merged[k].len > expect * 1.6) { ok = 0; break; }
    }
    if (!ok) continue;
    dup = 0;
    for (k = 0; k < nfound; k++) {
      if (fabs(found[k].x0 - merged[0].start) < 1 && fabs(found[k].pitch - p) < 0.3 && fabs(found[k].y0 - y) < p) {
        dup = 1;
        break;
      }
    }
    if (!dup) {
      found[nfound].x0 = merged[0].start;
      found[nfound].y0 = y;
      found[nfound].pitch = p;
      nfound++;
    }
  }
  return nfound;
}

wc_geometry wc_refine(const wc_pixels *px, wc_geometry g, const wc_spec *spec) {
  int spans[4];
  int y, s;
  if (!geometry_finite(&g)) return g;
  y = (int)(g.y0 + 0.5 * g.pitch);
  spans[0] = 12;
  spans[1] = 32;
  spans[2] = 80;
  spans[3] = spec->cells;
  if (y < 0 || y >= px->height) return g;
  for (s = 0; s < 4; s++) {
    int x_start = (int)g.x0 < 0 ? 0 : (int)g.x0;
    int x_end = (int)(g.x0 + spans[s] * g.pitch), x, prev;
    double n = 0, sk = 0, st = 0, skk = 0, skt = 0, last_k = -1;
    if (x_end > px->width) x_end = px->width;
    if (x_start >= px->width) return g;
    prev = wc_cell(px, x_start, y);
    for (x = x_start + 1; x < x_end; x++) {
      int v = wc_cell(px, x, y);
      if (v != prev) {
        double kf = ((double)x - g.x0) / g.pitch;
        double k = round(kf);
        if (k >= 1 && fabs(kf - k) < 0.35 && k != last_k) {
          n += 1;
          sk += k;
          st += x;
          skk += k * k;
          skt += k * x;
          last_k = k;
        }
        prev = v;
      }
    }
    if (n >= 3) {
      double den = n * skk - sk * sk;
      if (den > 0) {
        double p = (n * skt - sk * st) / den;
        double x0 = (st - p * sk) / n;
        if (p > spec->min_pitch && p < spec->max_pitch && fabs(p - g.pitch) < g.pitch * 0.2) {
          g.pitch = p;
          g.x0 = x0;
        }
      }
    }
  }
  return g;
}

#define WC_CROP_MARGIN 8

void wc_crop_size(const wc_spec *spec, const wc_geometry *measured, int base_w, int base_h, int *w, int *h) {
  *w = base_w;
  *h = base_h;
  /* A measured geometry is in range by construction (the search's pitch bounds, its
   * nudges, the top-left search box); the checks keep a bad one (or NaN) from sizing it. */
  if (measured && measured->pitch > 0 && measured->pitch <= spec->max_pitch + 0.5 && measured->x0 > -measured->pitch &&
      measured->x0 < 4096 && measured->y0 > -measured->pitch && measured->y0 < 4096) {
    double x0 = measured->x0 > 0 ? measured->x0 : 0, y0 = measured->y0 > 0 ? measured->y0 : 0;
    int need_w = (int)ceil(x0 + spec->cells * measured->pitch) + WC_CROP_MARGIN;
    int need_h = (int)ceil(y0 + spec->rows * measured->pitch) + WC_CROP_MARGIN;
    if (need_w > *w) *w = need_w;
    if (need_h > *h) *h = need_h;
  }
}

int wc_measured(const wc_result *r, wc_geometry *measured) {
  if (r->status == WC_DECODED || (r->status == WC_REJECTED && r->reason && strcmp(r->reason, "truncated") == 0)) {
    *measured = r->geometry;
    return 1;
  }
  return 0;
}

void wc_find_and_decode(const wc_pixels *px, const wc_spec *spec, const wc_geometry *hint, wc_result *out) {
  static const double dps[6] = {0.005, -0.005, 0.01, -0.01, 0.02, -0.02};
  static const double dys[3] = {1.0, -1.0, 2.0};
  static const double dxs[2] = {0.5, -0.5};
  wc_geometry cands[4];
  wc_geometry rejected_at = {0, 0, 0};
  const char *rejected = NULL;
  int ncands, c;

  if (hint) {
    wc_decode(px, hint, spec, out);
    if (out->status == WC_DECODED) return;
    if (out->status == WC_REJECTED) {
      rejected = out->reason;
      rejected_at = out->geometry;
    }
  }
  ncands = wc_estimate(px, spec, cands, 4);
  for (c = 0; c < ncands; c++) {
    /* The fit first, then one-axis nudges around it, then the raw estimate: at
     * most 13 decodes per candidate, so a damaged strip can't eat the CPU. */
    wc_geometry refined = wc_refine(px, cands[c], spec);
    wc_geometry tries[13];
    int nt = 0, t;
    tries[nt++] = refined;
    for (t = 0; t < 6; t++) { tries[nt] = refined; tries[nt].pitch += dps[t]; nt++; }
    for (t = 0; t < 3; t++) { tries[nt] = refined; tries[nt].y0 += dys[t]; nt++; }
    for (t = 0; t < 2; t++) { tries[nt] = refined; tries[nt].x0 += dxs[t]; nt++; }
    tries[nt++] = cands[c];
    for (t = 0; t < nt; t++) {
      wc_decode(px, &tries[t], spec, out);
      if (out->status == WC_DECODED) return;
      if (out->status == WC_REJECTED && !rejected) {
        rejected = out->reason;
        rejected_at = out->geometry;
      }
    }
  }
  if (rejected) {
    set_rejected(out, &rejected_at, rejected);
  } else {
    wc_geometry zero = {0, 0, 0};
    set_none(out, hint ? hint : &zero);
  }
}
