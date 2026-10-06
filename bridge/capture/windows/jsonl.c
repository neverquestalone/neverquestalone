/* JSON line builder for the capture helper (PRD §11.3, DB11). See jsonl.h. */
#include "jsonl.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

void wc_json_init(wc_json *j, char *buf, size_t cap) {
  j->buf = buf;
  j->len = 0;
  j->cap = cap;
  j->overflow = 0;
  if (cap) buf[0] = '\0';
}

static void put(wc_json *j, const char *s, size_t n) {
  /* Keep room for the final "\n\0". */
  if (j->overflow || j->len + n + 2 > j->cap) {
    j->overflow = 1;
    return;
  }
  memcpy(j->buf + j->len, s, n);
  j->len += n;
  j->buf[j->len] = '\0';
}

void wc_json_raw(wc_json *j, const char *s) { put(j, s, strlen(s)); }

/* Length of the valid UTF-8 sequence at s (1..4), or 0 with *bad set to the
 * length of the maximal invalid subpart to replace with one U+FFFD. */
static size_t utf8_seq(const uint8_t *s, size_t n, size_t *bad) {
  uint8_t b0 = s[0], lo = 0x80, hi = 0xBF;
  size_t need, k;
  if (b0 < 0x80) return 1;
  if (b0 >= 0xC2 && b0 <= 0xDF) need = 1;
  else if (b0 >= 0xE0 && b0 <= 0xEF) {
    need = 2;
    if (b0 == 0xE0) lo = 0xA0;
    if (b0 == 0xED) hi = 0x9F;
  } else if (b0 >= 0xF0 && b0 <= 0xF4) {
    need = 3;
    if (b0 == 0xF0) lo = 0x90;
    if (b0 == 0xF4) hi = 0x8F;
  } else {
    *bad = 1;
    return 0;
  }
  for (k = 1; k <= need; k++) {
    uint8_t c;
    if (k >= n) { *bad = k; return 0; }
    c = s[k];
    if (k == 1 ? (c < lo || c > hi) : (c < 0x80 || c > 0xBF)) { *bad = k; return 0; }
  }
  return need + 1;
}

void wc_json_str(wc_json *j, const uint8_t *s, size_t n) {
  static const char hex[] = "0123456789abcdef";
  size_t i = 0;
  put(j, "\"", 1);
  while (i < n) {
    uint8_t c = s[i];
    size_t bad = 0, len;
    if (c < 0x80) {
      char esc[7];
      switch (c) {
        case '"': put(j, "\\\"", 2); break;
        case '\\': put(j, "\\\\", 2); break;
        case '\n': put(j, "\\n", 2); break;
        case '\r': put(j, "\\r", 2); break;
        case '\t': put(j, "\\t", 2); break;
        case '\b': put(j, "\\b", 2); break;
        case '\f': put(j, "\\f", 2); break;
        default:
          if (c < 0x20 || c == 0x7F) {
            esc[0] = '\\'; esc[1] = 'u'; esc[2] = '0'; esc[3] = '0';
            esc[4] = hex[c >> 4]; esc[5] = hex[c & 15]; esc[6] = '\0';
            put(j, esc, 6);
          } else {
            put(j, (const char *)&s[i], 1);
          }
      }
      i++;
      continue;
    }
    len = utf8_seq(s + i, n - i, &bad);
    if (len) {
      put(j, (const char *)(s + i), len);
      i += len;
    } else {
      put(j, "\xEF\xBF\xBD", 3);
      i += bad;
    }
  }
  put(j, "\"", 1);
}

void wc_json_cstr(wc_json *j, const char *s) { wc_json_str(j, (const uint8_t *)s, strlen(s)); }

void wc_json_int(wc_json *j, long long v) {
  char tmp[32];
  snprintf(tmp, sizeof tmp, "%lld", v);
  wc_json_raw(j, tmp);
}

void wc_json_num(wc_json *j, double v) {
  char tmp[64];
  size_t n;
  if (!isfinite(v)) v = 0;
  snprintf(tmp, sizeof tmp, "%.3f", v);
  n = strlen(tmp);
  while (n > 0 && tmp[n - 1] == '0') tmp[--n] = '\0';
  if (n > 0 && tmp[n - 1] == '.') tmp[--n] = '\0';
  if (strcmp(tmp, "-0") == 0) strcpy(tmp, "0");
  wc_json_raw(j, tmp);
}

void wc_json_key(wc_json *j, const char *key, int first) {
  if (!first) put(j, ",", 1);
  wc_json_cstr(j, key);
  put(j, ":", 1);
}

void wc_json_geometry(wc_json *j, double x0, double y0, double pitch) {
  put(j, "{", 1);
  wc_json_key(j, "x0", 1);
  wc_json_num(j, x0);
  wc_json_key(j, "y0", 0);
  wc_json_num(j, y0);
  wc_json_key(j, "pitch", 0);
  wc_json_num(j, pitch);
  put(j, "}", 1);
}

int wc_json_end(wc_json *j) {
  if (j->overflow) return -1;
  j->buf[j->len++] = '\n';
  j->buf[j->len] = '\0';
  return 0;
}
