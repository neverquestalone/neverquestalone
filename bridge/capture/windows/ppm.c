/* Binary PPM (P6) reader (PRD §11.3, DB11). See ppm.h. */
#include "ppm.h"

#include <stdlib.h>

/* The next header number, skipping whitespace and # comments; -1 if malformed. */
static long header_number(FILE *f) {
  int c;
  long v = 0;
  int digits = 0;
  for (;;) {
    c = fgetc(f);
    if (c == '#') {
      while (c != '\n' && c != EOF) c = fgetc(f);
      continue;
    }
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;
    break;
  }
  while (c >= '0' && c <= '9') {
    v = v * 10 + (c - '0');
    if (v > 1000000) return -1;
    digits++;
    c = fgetc(f);
  }
  /* Exactly one whitespace byte ends the number (it matters after maxval). */
  if (!digits || !(c == ' ' || c == '\t' || c == '\r' || c == '\n')) return -1;
  return v;
}

int wc_ppm_read(FILE *f, wc_ppm *out, const char **err) {
  long w, h, maxval;
  size_t size;
  out->rgb = NULL;
  if (fgetc(f) != 'P' || fgetc(f) != '6') { *err = "not a binary PPM (P6)"; return -1; }
  w = header_number(f);
  h = header_number(f);
  maxval = header_number(f);
  if (w <= 0 || h <= 0 || w > 16384 || h > 16384) { *err = "bad PPM size"; return -1; }
  if (maxval != 255) { *err = "only 8-bit PPMs (maxval 255) are supported"; return -1; }
  size = (size_t)w * (size_t)h * 3;
  out->rgb = (uint8_t *)malloc(size);
  if (!out->rgb) { *err = "out of memory"; return -1; }
  if (fread(out->rgb, 1, size, f) != size) {
    free(out->rgb);
    out->rgb = NULL;
    *err = "PPM is shorter than its header says";
    return -1;
  }
  out->width = (int)w;
  out->height = (int)h;
  return 0;
}

void wc_ppm_free(wc_ppm *img) {
  free(img->rgb);
  img->rgb = NULL;
}
