/* Typed errors, rate-limited per kind (PRD §11.3). See errlimit.h. */
#include "errlimit.h"

#include <string.h>

void wc_errlimit_init(wc_errlimit *e, unsigned long long every_ms) {
  memset(e, 0, sizeof *e);
  e->every_ms = every_ms;
}

int wc_errlimit_set(wc_errlimit *e, const char *kind, unsigned long long now_ms) {
  int k, slot = -1, oldest = 0;
  e->active = 1;
  for (k = 0; k < e->nsaid; k++) {
    if (strcmp(e->said[k].kind, kind) == 0) { slot = k; break; }
    if (e->said[k].at < e->said[oldest].at) oldest = k;
  }
  if (slot >= 0 && now_ms - e->said[slot].at < e->every_ms) return 0; /* said within the minute */
  if (slot < 0) slot = e->nsaid < WC_ERR_KINDS ? e->nsaid++ : oldest;
  e->said[slot].kind = kind;
  e->said[slot].at = now_ms;
  e->announced = 1;
  return 1;
}

int wc_errlimit_clear(wc_errlimit *e) {
  int say = e->active && e->announced;
  e->active = 0;
  if (say) e->announced = 0;
  return say;
}
