/* NeverQuestAlone strip decoder, portable C (PRD §11.3, DB11; K5).
 *
 * A port of the macOS decoder (bridge/capture/mac/Sources/StripDecoder/
 * StripDecoder.swift) with the same rules and the same search:
 *   frame = [magic1 magic2] [id hi, lo] [len hi, lo] [payload] [fletcher-16 s1, s2]
 * packed MSB-first into 3-bit cells (bit 2 = R, bit 1 = G, bit 0 = B), each
 * channel fully on or off. The cell pitch is measured from the strip (magic runs
 * -> pitch estimate -> least-squares refine), so a scaled window still decodes.
 *
 * No Windows headers and no allocation: the Windows helper (main.c) and the
 * native test harness (decode_raw.c) share this file unchanged. */
#ifndef NQA_DECODER_H
#define NQA_DECODER_H

#include <stddef.h>
#include <stdint.h>

/* The largest frame the decoder will hold (the default 200 x 48 strip carries 3600 bytes). */
#define WC_MAX_FRAME_BYTES 8192

typedef struct {
  int width, height;
  size_t stride;        /* bytes per row */
  const uint8_t *base;
  int bpp;              /* bytes per pixel: 3 or 4 */
  int bgr;              /* 1: bytes are B, G, R[, A] (DXGI B8G8R8A8); 0: R, G, B[, A] */
} wc_pixels;

/* Where the strip is: its top-left corner and the cell pitch, in pixels. */
typedef struct {
  double x0, y0, pitch;
} wc_geometry;

typedef struct {
  int cells, rows;           /* 200 x 48 */
  uint8_t magic[2];          /* C7 2C (NeverQuestAlone); upstream wow-ai is C7 1A */
  int search_rows;           /* pixel rows searched for the strip's first row */
  int search_cols;           /* pixel columns searched for the first cell */
  double min_pitch, max_pitch;
} wc_spec;

typedef enum { WC_NONE = 0, WC_REJECTED = 1, WC_DECODED = 2 } wc_status;

typedef struct {
  wc_status status;
  const char *reason;        /* WC_REJECTED: "truncated" | "length" | "checksum" (static strings) */
  wc_geometry geometry;
  int id;                    /* WC_DECODED: the frame id */
  size_t len;                /* WC_DECODED: payload bytes, at bytes + 6 */
  uint8_t bytes[WC_MAX_FRAME_BYTES];
} wc_result;

/* 200 x 48 cells, magic C7 2C, 80 search rows, 32 search columns, pitch 2.5..12. */
void wc_spec_default(wc_spec *spec);

/* "C72C", "c72c", "0xC72C" or "C7 2C" -> magic; 0 on success, -1 if malformed. */
int wc_parse_magic(const char *text, uint8_t magic[2]);

/* The 3-bit value of one pixel: a channel past mid-grey (>= 128) counts as on. */
int wc_cell(const wc_pixels *px, int x, int y);

/* Decode with the cells sampled at their centers for one geometry. */
void wc_decode(const wc_pixels *px, const wc_geometry *g, const wc_spec *spec, wc_result *out);

/* Candidate geometries from the magic's color runs near the top-left; returns how many. */
int wc_estimate(const wc_pixels *px, const wc_spec *spec, wc_geometry *found, int max_found);

/* Sharpen x0 and the pitch with a least-squares fit of the color changes on the first row. */
wc_geometry wc_refine(const wc_pixels *px, wc_geometry g, const wc_spec *spec);

/* Find and decode the strip; hint (may be NULL) is the last geometry that worked. */
void wc_find_and_decode(const wc_pixels *px, const wc_spec *spec, const wc_geometry *hint, wc_result *out);

/* The crop that holds a whole strip: the configured region (base_w x base_h,
 * 900 x 300 by default) grown to the strip's right and bottom edges, plus a
 * margin, at the geometry last measured (may be NULL: the region as configured).
 * A cell of more than 4.5 px doesn't fit a 200-cell row in 900 px, so a scaled
 * window needs this, or every frame longer than one row reads as truncated. */
void wc_crop_size(const wc_spec *spec, const wc_geometry *measured, int base_w, int base_h, int *w, int *h);

/* After a frame: 1 (and the geometry in *measured) when the result measured the
 * strip, i.e. it decoded, or it was cut off ("truncated") at a known pitch. */
int wc_measured(const wc_result *r, wc_geometry *measured);

/* The payload of a decoded result. */
static inline const uint8_t *wc_payload(const wc_result *r) { return r->bytes + 6; }

#endif
