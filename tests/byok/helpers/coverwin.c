/* A stand-in for an overlay that covers the game's corner, for tests/byok/windows_smoke_test.mjs
 * (display DR-25): a topmost, click-through, non-activating window filled with one flat colour.
 * That is the shape of Discord's or Steam's in-game overlay, which sits over the strip and takes no
 * focus and no click. Desktop Duplication reads the composited desktop, so the capture helper sees
 * this window over the strip whichever window is in front. System DPI aware, like the stand-in game
 * (stripwin.c), so both are laid out in the same pixels.
 *
 *   coverwin X Y WIDTH HEIGHT SECONDS      prints "shown <pid>" once the window is up,
 *                                          closes itself after SECONDS */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  if (msg == WM_NCHITTEST) return HTTRANSPARENT;
  if (msg == WM_TIMER) {
    DestroyWindow(hwnd);
    return 0;
  }
  if (msg == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int main(int argc, char **argv) {
  WNDCLASSW wc;
  HWND hwnd;
  MSG m;
  if (argc != 6) {
    fprintf(stderr, "usage: coverwin X Y WIDTH HEIGHT SECONDS\n");
    return 2;
  }
  SetProcessDPIAware();
  memset(&wc, 0, sizeof wc);
  wc.lpfnWndProc = proc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.hbrBackground = CreateSolidBrush(RGB(120, 120, 120));
  wc.lpszClassName = L"coverwin";
  if (!RegisterClassW(&wc)) return 4;
  hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, L"coverwin",
                         L"coverwin", WS_POPUP, atoi(argv[1]), atoi(argv[2]), atoi(argv[3]), atoi(argv[4]), NULL, NULL,
                         wc.hInstance, NULL);
  if (!hwnd) return 5;
  SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  UpdateWindow(hwnd);
  SetTimer(hwnd, 1, (UINT)atoi(argv[5]) * 1000u, NULL);
  printf("shown %lu\n", (unsigned long)GetCurrentProcessId());
  fflush(stdout);
  while (GetMessageW(&m, NULL, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  return 0;
}
