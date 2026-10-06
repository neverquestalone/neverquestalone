/* JSON line builder for the capture helper's output (PRD §11.3, DB11).
 *
 * The helper writes one JSON object per line, the same contract as the macOS
 * app and capture_x11.py: {info} {warn} {error, kind} {id, text, bytes} {stats}
 * {game, pid} {window} and, first on the pipe, {hello, token}. Strings from the
 * strip are UTF-8 from the addon; invalid sequences become U+FFFD (maximal
 * subparts, as Swift and WHATWG do) so the bridge always gets valid JSON.
 * Portable C, no Windows headers: the native test harness uses it too. */
#ifndef NQA_JSONL_H
#define NQA_JSONL_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  char *buf;
  size_t len, cap;
  int overflow;   /* set when something didn't fit; the line must then be dropped */
} wc_json;

void wc_json_init(wc_json *j, char *buf, size_t cap);
void wc_json_raw(wc_json *j, const char *s);
/* A quoted JSON string from n bytes of (possibly invalid) UTF-8. */
void wc_json_str(wc_json *j, const uint8_t *s, size_t n);
void wc_json_cstr(wc_json *j, const char *s);
void wc_json_int(wc_json *j, long long v);
/* A number with at most 3 decimals, trailing zeros trimmed. */
void wc_json_num(wc_json *j, double v);
/* ,"key": */
void wc_json_key(wc_json *j, const char *key, int first);
/* {"x0":..,"y0":..,"pitch":..} */
void wc_json_geometry(wc_json *j, double x0, double y0, double pitch);
/* Terminates the line with "\n" and a NUL; returns 0, or -1 on overflow. */
int wc_json_end(wc_json *j);

#endif
