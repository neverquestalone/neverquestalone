/* A stand-in game window for tests/byok/windows_smoke_test.mjs (display DR-05): a borderless,
 * topmost window whose client area shows a binary PPM (an addon strip) at its top-left, the way
 * WoW's corner shows it. The test compiles this once with the runner's MinGW-w64 gcc, copies the
 * exe to a fake "World of Warcraft\_forever_\Wow.exe" and to "Programs\WowUp\WowUp.exe", runs both,
 * and checks which one the capture helper takes for the game. System DPI aware, so the helper's
 * window line has an awareness to report.
 *
 *   stripwin X Y WIDTH HEIGHT IMAGE.ppm SECONDS    prints "shown <pid>" once the window is up,
 *                                                  closes itself after SECONDS
 *
 * The image is looked at again four times a second: the test writes another PPM over that name (a
 * temp file renamed onto it) and the window shows it, as the addon's strip changes with each record
 * (DR-25). A file that can't be read whole (half written) is left for the next look. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char *g_bits; /* the image, top-down, 32-bit BGRX */
static int g_w, g_h;

static void look_again(HWND hwnd);

static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_PAINT) {
    PAINTSTRUCT ps;
    BITMAPINFO bi;
    HDC dc = BeginPaint(hwnd, &ps);
    memset(&bi, 0, sizeof bi);
    bi.bmiHeader.biSize = sizeof bi.bmiHeader;
    bi.bmiHeader.biWidth = g_w;
    bi.bmiHeader.biHeight = -g_h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    SetDIBitsToDevice(dc, 0, 0, (DWORD)g_w, (DWORD)g_h, 0, 0, 0, (UINT)g_h, g_bits, &bi, DIB_RGB_COLORS);
    EndPaint(hwnd, &ps);
    return 0;
  }
  if (msg == WM_TIMER) {
    if (wp == 2) {
      look_again(hwnd);
    } else {
      DestroyWindow(hwnd);
    }
    return 0;
  }
  if (msg == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

/* "P6\n<w> <h>\n255\n" and the RGB bytes, as tests/byok/helpers/strip-fixtures.mjs ppm() writes it.
 * Read whole into new buffers and swapped in, so a half-written file changes nothing. */
static int read_ppm(const char *file) {
  FILE *f = fopen(file, "rb");
  int w = 0, h = 0, maxv = 0;
  size_t n, k;
  unsigned char *rgb, *bits;
  if (!f) return -1;
  if (fscanf(f, "P6 %d %d %d", &w, &h, &maxv) != 3 || maxv != 255 || w <= 0 || h <= 0 || fgetc(f) == EOF) {
    fclose(f);
    return -1;
  }
  n = (size_t)w * (size_t)h;
  rgb = malloc(n * 3);
  bits = malloc(n * 4);
  if (!rgb || !bits || fread(rgb, 3, n, f) != n) {
    fclose(f);
    free(rgb);
    free(bits);
    return -1;
  }
  fclose(f);
  for (k = 0; k < n; k++) {
    bits[k * 4] = rgb[k * 3 + 2];
    bits[k * 4 + 1] = rgb[k * 3 + 1];
    bits[k * 4 + 2] = rgb[k * 3];
    bits[k * 4 + 3] = 0;
  }
  free(rgb);
  free(g_bits);
  g_bits = bits;
  g_w = w;
  g_h = h;
  return 0;
}

/* The file's write time and size at the last read: a look that finds the same does nothing. */
static FILETIME g_stamp;
static DWORD g_size = (DWORD)-1;
static const char *g_file;

/* Reads g_file if it changed since the last read; 1 if a new image is in, 0 if not, -1 if it can't be read. */
static int load(void) {
  WIN32_FILE_ATTRIBUTE_DATA a;
  if (!GetFileAttributesExA(g_file, GetFileExInfoStandard, &a)) return -1;
  if (CompareFileTime(&a.ftLastWriteTime, &g_stamp) == 0 && a.nFileSizeLow == g_size) return 0;
  if (read_ppm(g_file) != 0) return -1;
  g_stamp = a.ftLastWriteTime;
  g_size = a.nFileSizeLow;
  return 1;
}

static void look_again(HWND hwnd) {
  if (load() == 1) InvalidateRect(hwnd, NULL, FALSE);
}

int main(int argc, char **argv) {
  WNDCLASSW wc;
  HWND hwnd;
  MSG m;
  if (argc != 7) {
    fprintf(stderr, "usage: stripwin X Y WIDTH HEIGHT IMAGE.ppm SECONDS\n");
    return 2;
  }
  g_file = argv[5];
  if (load() != 1) {
    fprintf(stderr, "stripwin: can't read %s\n", argv[5]);
    return 3;
  }
  SetProcessDPIAware();
  memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = proc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
  wc.lpszClassName = L"stripwin";
  if (!RegisterClassW(&wc)) return 4;
  hwnd = CreateWindowExW(WS_EX_TOPMOST, L"stripwin", L"stripwin", WS_POPUP | WS_VISIBLE, atoi(argv[1]), atoi(argv[2]),
                         atoi(argv[3]), atoi(argv[4]), NULL, NULL, wc.hInstance, NULL);
  if (!hwnd) return 5;
  UpdateWindow(hwnd);
  SetTimer(hwnd, 1, (UINT)atoi(argv[6]) * 1000u, NULL);
  SetTimer(hwnd, 2, 250, NULL);
  printf("shown %lu\n", (unsigned long)GetCurrentProcessId());
  fflush(stdout);
  while (GetMessageW(&m, NULL, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  return 0;
}
