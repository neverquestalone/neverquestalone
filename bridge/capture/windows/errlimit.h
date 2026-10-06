/* Typed errors for the capture helper (PRD §11.3): each kind is said when it
 * starts, then at most once a minute, however often the condition comes and goes
 * (access lost and back, the window lost and found). When an error that was said
 * clears, the helper says "capturing" once.
 *
 * Portable (no Windows headers, the caller passes the clock) so the native test
 * harness (decode_raw.c --errors) runs the same code as the helper. */
#ifndef NQA_ERRLIMIT_H
#define NQA_ERRLIMIT_H

#define WC_ERR_KINDS 8

typedef struct {
  const char *kind;         /* a static string, e.g. "access_lost" */
  unsigned long long at;    /* when it was last said (ms) */
} wc_err_said;

typedef struct {
  wc_err_said said[WC_ERR_KINDS];
  int nsaid;
  unsigned long long every_ms;
  int active;               /* an error holds now */
  int announced;            /* ...and the bridge was told about one since the last "capturing" */
} wc_errlimit;

void wc_errlimit_init(wc_errlimit *e, unsigned long long every_ms);

/* The condition `kind` holds at now_ms: 1 if the error line should be sent now. */
int wc_errlimit_set(wc_errlimit *e, const char *kind, unsigned long long now_ms);

/* Capture works again: 1 if a "capturing" line should be sent (an error was said). */
int wc_errlimit_clear(wc_errlimit *e);

#endif
