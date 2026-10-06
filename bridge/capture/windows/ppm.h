/* Binary PPM (P6, 8-bit RGB) reader for decoder tests (PRD §11.3, DB11).
 * The fixtures are raw RGB with a three-line header, so neither the native
 * harness nor the helper's --test-image needs a PNG decoder. Portable C. */
#ifndef NQA_PPM_H
#define NQA_PPM_H

#include <stdint.h>
#include <stdio.h>

typedef struct {
  int width, height;
  uint8_t *rgb;   /* width * height * 3 bytes, malloc'd; free with wc_ppm_free */
} wc_ppm;

/* 0 on success; -1 with *err set to a static message. */
int wc_ppm_read(FILE *f, wc_ppm *out, const char **err);
void wc_ppm_free(wc_ppm *img);

#endif
