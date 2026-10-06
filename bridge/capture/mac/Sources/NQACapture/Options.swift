import Foundation
import StripDecoder

/// Command line, compatible with upstream's capture helpers (PRD §9.10):
///   --process <name>        owning app name to match (substring, case-insensitive)
///   --bundle-id <id>        owning app bundle id to match (default com.blizzard.worldofwarcraft)
///   --window-name <substr>  match the window title instead
///   --interval-ms 250       capture interval
///   --cell-px 4             expected cell size (a hint only; the pitch is measured)
///   --cells 200, --rows 48  strip layout
///   --magic C71A            strip magic bytes, hex (C71A = upstream WoWAI, C72C = NeverQuestAlone strip v2)
///   --socket <path>         stream JSON lines to the bridge's Unix socket (else stdout)
///   --probe <png>           capture once, save what the capture sees, report, exit
///   --test-image <png>      decode a PNG once and exit (tests; touches no capture API)
///   --hint x0,y0,pitch      with --test-image: a geometry tried first, as the capture loop tries its last good
///                           one; nan and inf are read as written (tests; code health LS-12)
///   --test-plan <a> <b>     the stream for a window as attached and as now (WxH@scale), and exit (tests)
///   --test-crop <json>      the region a stream reads against the strip, frame by frame, and exit (tests;
///                           code health (Mac crop))
///   --test-pick <json>      the window to capture among those in the file, and exit (tests)
///   --test-idle             what runs on a timer with the game closed and running, and exit (tests)
///   --test-session <json>   the lock fact and what a lost stream says, from a session dictionary (tests)
///   --test-lock <path>      take the single-instance lock at path, or say who holds it (tests)
///   --test-warns <json>     warnings through the per-key budget, with the file's times (tests)
///   --check-permission      report whether Screen Recording is granted, exit
///   --request-permission    ask macOS for Screen Recording (its box, once), wait up to 120 s for the answer, report it, exit
///   --check-peer <req>      the app's peer check: whoever connected to the app's socket on fd 3 meets <req>, exit 0;
///                           else one stderr line, exit 6 (code health LS-03 / peer check; main.swift)
///   --stats-sec 30          how often to report capture statistics
///   --region-pt WxH         the capture region in points (default: 300 pt tall, a whole strip wide; a stream
///                           narrows it to the strip's own area once the strip is measured)
/// NeverQuestAlone's build (NQA_PUBLIC_ID) refuses --process, --bundle-id, --window-name, --region-pt
/// and --probe (code health BR-01): main.swift exits on them before anything else.
struct Options {
    var process = "World of Warcraft"
    var bundleId = "com.blizzard.worldofwarcraft"
    var windowName = ""
    var intervalMs = 250
    var cellPx = 4
    var spec = StripSpec()
    var socketPath: String? = nil
    var probePath: String? = nil
    var testImage: String? = nil
    var hint: Geometry? = nil
    var testPlan: (String, String)? = nil
    var testCrop: String? = nil
    var testPick: String? = nil
    var testIdle = false
    var testSession: String? = nil
    var testLock: String? = nil
    var testWarns: String? = nil
    var checkPermission = false
    var requestPermission = false
    var checkPeer: String? = nil
    var statsSec = 30
    /// Capture region, in points from the window's top-left corner. No width: a whole strip at the
    /// widest pitch the decoder reads (CaptureController.regionWidthPt). A stream reads less once the
    /// strip is measured: its own area (CaptureController.stripAreaPt).
    var regionWidthPt: Double? = nil
    var regionHeightPt = 300.0
    #if NQA_PUBLIC_ID
    /// The flags that would aim this app (Options.aiming) it was given; main.swift exits when there are any.
    var refused: [String] = []
    #endif
    /// What picks the window, the region or a file to write. The app passes none of them: only --socket,
    /// --magic, --interval-ms and --stats-sec (transport/capture.mjs), --check-permission and
    /// --request-permission (byok/screen-permission.mjs), or --check-peer (transport/capture.mjs checkPeer).
    static let aiming = ["--process", "--bundle-id", "--window-name", "--region-pt", "--probe"]

    static func parse(_ argv: [String]) -> Options {
        var o = Options()
        var i = 1
        func next() -> String? {
            i += 1
            return i < argv.count ? argv[i] : nil
        }
        while i < argv.count {
            let a = argv[i]
            #if NQA_PUBLIC_ID
            // Whoever launches NeverQuestAlone's helper can't aim its Screen Recording grant at another
            // window, region or file (code health BR-01, the old audit LS-01): the build decides, never argv.
            if Options.aiming.contains(a) {
                o.refused.append(a)
                i += 2
                continue
            }
            #endif
            switch a {
            case "--process": if let v = next() { o.process = v }
            case "--bundle-id": if let v = next() { o.bundleId = v }
            case "--window-name": if let v = next() { o.windowName = v }
            case "--interval-ms": if let v = next(), let n = Int(v), n >= 50 { o.intervalMs = n }
            case "--cell-px", "--cell": if let v = next(), let n = Int(v), n > 0 { o.cellPx = n }
            case "--cells": if let v = next(), let n = Int(v), n > 0 { o.spec.cells = n }
            case "--rows", "--max-rows": if let v = next(), let n = Int(v), n > 0 { o.spec.rows = n }
            case "--magic":
                if let v = next(), v.count == 4, let n = UInt16(v, radix: 16) {
                    o.spec.magic = (UInt8(n >> 8), UInt8(n & 0xFF))
                }
            case "--socket": o.socketPath = next()
            case "--probe": o.probePath = next()
            case "--test-image": o.testImage = next()
            case "--hint":
                if let p = next()?.split(separator: ",").compactMap({ Double($0) }), p.count == 3 {
                    o.hint = Geometry(x0: p[0], y0: p[1], pitch: p[2])
                }
            case "--test-plan": if let a = next(), let b = next() { o.testPlan = (a, b) }
            case "--test-crop": o.testCrop = next()
            case "--test-pick": o.testPick = next()
            case "--test-idle": o.testIdle = true
            case "--test-session": o.testSession = next()
            case "--test-lock": o.testLock = next()
            case "--test-warns": o.testWarns = next()
            case "--check-permission": o.checkPermission = true
            case "--request-permission": o.requestPermission = true
            case "--check-peer": o.checkPeer = next()
            case "--stats-sec": if let v = next(), let n = Int(v), n > 0 { o.statsSec = n }
            case "--region-pt":
                if let v = next() {
                    let parts = v.split(separator: "x").compactMap { Double($0) }
                    if parts.count == 2 { o.regionWidthPt = parts[0]; o.regionHeightPt = parts[1] }
                }
            default:
                // LaunchServices may add -psn_… or -NSDocumentRevisionsDebugMode; ignore unknowns.
                break
            }
            i += 1
        }
        return o
    }
}
