import AppKit
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import StripDecoder

/// Finds the game window with ScreenCaptureKit, streams its top-left corner at
/// the capture interval in sRGB, decodes the strip and reports new messages.
final class CaptureController: NSObject, SCStreamOutput, SCStreamDelegate {
    private let opts: Options
    private let out: Emitter
    private let frameQueue = DispatchQueue(label: "nqa.capture.frames")
    private var stream: SCStream?
    private var window: SCWindow?
    private var hint: Geometry?
    private var lastKey: String?
    private var lastWaitNote = Date.distantPast
    /// Held while a stream runs, never while the game is closed (activityOptions; D-14).
    private var activity: NSObjectProtocol?
    /// The attached window as last seen (main thread): on screen or not (the 10 s replan's lookup
    /// refreshes it), where it is (which display) and whose it is. The stats line's hold facts.
    private var windowOnScreen: Bool?
    private var windowFrame: CGRect?
    private var windowPid: Int?
    // What the bridge was last told (SY-04): Screen Recording granted or not, and whether a typed
    // error is out that a restarted stream should clear. Without these a revoked Mac said
    // "Bones can see the game" while it read nothing.
    private var saidPermission: Bool?
    private var saidError = false
    private var stoppedAt: Date?
    // The stream's lifecycle (stream, window, plan, replan*) belongs to the
    // main actor: attachLoop, startStream, replan and a stop all run there.
    /// What the running stream was set up for (see StreamPlan).
    private var plan: StreamPlan?
    /// The strip the running stream's region is fitted to (code health (Mac crop)), with the display
    /// under the window's corner and the display changes seen when it was: nil while it reads the whole
    /// search region. displayChanges counts didChangeScreenParametersNotification; refitGen numbers the
    /// region changes asked of the stream (a later one supersedes it).
    private var fitted: (strip: Geometry, display: CGDirectDisplayID, changes: Int)?
    private var displayChanges = 0
    private var refitGen = 0
    /// A replan in progress: when it began, and its number (a later one supersedes it).
    private var replanSince: Date?
    private var replanGen = 0
    /// A search in progress (attachLoop): when it began, and its number.
    private var attachSince: Date?
    private var attachGen = 0
    /// A search is running, unless it has been stuck 30 s in a call that never
    /// returns: then another may start (a late start stops its own stream).
    private var attaching: Bool {
        attachSince.map { Date().timeIntervalSince($0) < 30 } ?? false
    }
    private var screenObserver: NSObjectProtocol?
    // What runs on a timer while the game does (GamePresence): nothing while it's closed (SY-30).
    private var statsTimer: Timer?
    private var replanTimer: Timer?

    // Frame queue only: the stream whose frames count, its scale, and whether
    // its frames have already asked for a replan.
    private var activeStream: ObjectIdentifier?
    private var streamScale = 0.0
    private var frameScale: Double?
    private var nudged = false
    // The region against the strip (code health (Mac crop)), frame queue only: what the stream reads
    // (RegionFit), no new ask of the main actor before fitHold (one at a time), a change the frames
    // must show by their size (regionExpect, whole: a strip may be cut until they do), and whether a
    // stream ever kept its old region (then no strip is fitted again in this helper's life).
    private var regionFit: RegionFit?
    private var fitHold = Date.distantPast
    private var regionExpect: (width: Int, height: Int, by: Date, whole: Bool)?
    private var regionBroken = false

    // Statistics, reported every statsSec (frame queue only).
    private var frames = 0
    private var decoded = 0
    private var rejects = 0
    private var idle = 0
    private var decodeSeconds = 0.0
    private var decodeMax = 0.0
    private var rejectReasons: [String: Int] = [:]

    init(_ opts: Options, _ out: Emitter) {
        self.opts = opts
        self.out = out
    }

    func start() {
        let granted = CGPreflightScreenCaptureAccess()
        saidPermission = granted
        out.emit(["info": "screen recording: \(granted ? "granted" : "not granted")", "permission": granted])
        #if NQA_PUBLIC_ID
        // NeverQuestAlone's helper asks nothing here (onboarding spec §9.4): macOS's box shows only on
        // the player's Allow in the app (--request-permission). Until it's granted, the loop waits.
        #else
        if !granted {
            // Your build: shows the system prompt once for this app; later launches don't re-prompt.
            _ = CGRequestScreenCaptureAccess()
        }
        #endif
        Task { await self.attachLoop() }
        if opts.probePath == nil { watchGame() }
        if opts.probePath == nil {
            // Follow the window across displays. A frame whose scale differs
            // asks at once (below); displays changing ask now and 2 s later
            // (the window may not have moved yet); a slow timer, while the
            // game runs (follow), covers the rest. A strip measured before
            // the displays changed is measured again (replan).
            screenObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
                self?.displayChanges += 1
                self?.replanIfNeeded()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.replanIfNeeded() }
            }
            follow(gameRunning: gameRunning())
        }
    }

    /// Run what GamePresence says for the game's state: while it runs, the activity that keeps App
    /// Nap and timer coalescing off the 250 ms stream (PRD §9.10; begun by a stream's start, below:
    /// holdActivity), the stats line and the 10 s replan; while it's closed, none of them, so nothing
    /// here wakes the Mac or the bridge until its launch (SY-30).
    private func follow(gameRunning: Bool) {
        let parts = Set(GamePresence.parts(gameRunning: gameRunning))
        if !parts.contains("activity") { holdActivity(false) }
        if parts.contains("stats") {
            if statsTimer == nil {
                let t = Timer(timeInterval: TimeInterval(opts.statsSec), repeats: true) { [weak self] _ in
                    self?.writeStats()
                }
                RunLoop.main.add(t, forMode: .common)
                statsTimer = t
            }
        } else {
            statsTimer?.invalidate()
            statsTimer = nil
        }
        if parts.contains("replan") {
            if replanTimer == nil {
                let r = Timer(timeInterval: 10, repeats: true) { [weak self] _ in self?.replanIfNeeded() }
                RunLoop.main.add(r, forMode: .common)
                replanTimer = r
            }
        } else {
            replanTimer?.invalidate()
            replanTimer = nil
        }
    }

    /// App Nap and timer coalescing stay off the 250 ms loop while a stream runs (PRD §9.10), and the
    /// Mac may still sleep when idle (D-14). The helper held .userInitiated from launch to exit, which
    /// includes .idleSystemSleepDisabled: a Mac with the app open never slept idle, game or no game.
    static let activityOptions: ProcessInfo.ActivityOptions = [.userInitiatedAllowingIdleSystemSleep, .latencyCritical]

    /// Begun when a stream starts, ended when it stops, restarts or the game exits.
    private func holdActivity(_ on: Bool) {
        if on {
            if activity == nil { activity = ProcessInfo.processInfo.beginActivity(options: Self.activityOptions, reason: "strip capture") }
        } else if let a = activity {
            ProcessInfo.processInfo.endActivity(a)
            activity = nil
        }
    }

    // MARK: The game's process (companion PRD F6)

    private var gameObservers: [NSObjectProtocol] = []

    /// The game app, by bundle id (the voice-proxy helper has its own) or, as a
    /// fallback, by name. Other apps, and helpers inside the game's bundle, don't count.
    private func isGame(_ app: NSRunningApplication) -> Bool {
        if let id = app.bundleIdentifier { return id == opts.bundleId }
        return (app.localizedName ?? "").localizedCaseInsensitiveContains(opts.process)
    }

    /// Say whether the game runs now, then report each launch and exit. A lost
    /// window (SCStream -3815) can't tell a quit from a closed window or a crash;
    /// the process ending can. The bridge uses "exited" to end a session.
    private func watchGame() {
        if let game = NSWorkspace.shared.runningApplications.first(where: isGame) {
            out.emit(["game": "running", "pid": Int(game.processIdentifier)])
        } else {
            out.emit(["game": "absent"])
        }
        let nc = NSWorkspace.shared.notificationCenter
        for (name, state) in [(NSWorkspace.didLaunchApplicationNotification, "launched"),
                              (NSWorkspace.didTerminateApplicationNotification, "exited")] {
            gameObservers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self = self,
                      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      self.isGame(app) else { return }
                self.out.emit(["game": state, "pid": Int(app.processIdentifier)])
                // No activity with the game closed (D-14): its stream is over, or about to be.
                if state == "exited" && (self.stream == nil || self.windowPid == Int(app.processIdentifier)) {
                    self.holdActivity(false)
                }
                if state == "launched" {
                    self.follow(gameRunning: true)
                    // Look for its window (nothing looks while the game is
                    // closed), and 5 s on, leave an old process's window for it.
                    Task { @MainActor in await self.attachLoop() }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.replanIfNeeded() }
                } else {
                    // The last game gone (another copy may still run): back to nothing.
                    self.follow(gameRunning: self.gameRunning(except: app.processIdentifier))
                }
            })
        }
    }

    /// The game process the player has: the active one, else the newest.
    @MainActor private func gamePid() -> Int? {
        let games = NSWorkspace.shared.runningApplications.filter(isGame)
        let game = games.first(where: { $0.isActive })
            ?? games.max { ($0.launchDate ?? .distantPast) < ($1.launchDate ?? .distantPast) }
        return game.map { Int($0.processIdentifier) }
    }

    /// Find the window (waiting for the game if needed), then start the stream.
    @MainActor private func attachLoop() async {
        guard !attaching else { return }
        attachGen += 1
        let gen = attachGen
        attachSince = Date()
        defer { if attachGen == gen { attachSince = nil } }
        while stream == nil {
            // With the game closed, stop here rather than list every window
            // every 3 s all day: its launch starts this loop again (watchGame).
            if opts.probePath == nil, opts.windowName.isEmpty, gamePid() == nil {
                noteWaiting("waiting for the game to start")
                return
            }
            #if NQA_PUBLIC_ID
            // Every ScreenCaptureKit call waits for the grant; the app restarts this helper once it's on.
            if opts.probePath == nil && !CGPreflightScreenCaptureAccess() {
                sayPermission(false)
                noteWaiting("waiting for Screen Recording permission")
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                continue
            }
            #endif
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                if stream != nil { return } // a replan got there first
                if let w = pickWindow(content.windows, gamePid: gamePid()) {
                    window = w
                    if let path = opts.probePath {
                        await probe(w, path: path)
                        exit(0)
                    }
                    try await startStream(w)
                    return
                }
                noteWaiting("waiting for \(opts.windowName.isEmpty ? opts.process : opts.windowName) window")
            } catch {
                let ns = error as NSError
                if ns.code == -3801 {
                    // The user declined / hasn't granted Screen Recording yet, or took it back.
                    sayPermission(false)
                    noteWaiting("screen recording permission needed (\(ns.domain) \(ns.code)): enable NeverQuestAlone Capture in System Settings > Privacy & Security > Screen & System Audio Recording",
                                warn: true)
                    if opts.probePath != nil { exit(4) }
                } else {
                    noteWaiting("capture could not start (\(ns.domain) \(ns.code)): \(ns.localizedDescription); trying again", warn: true)
                }
            }
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func sayPermission(_ granted: Bool) {
        if saidPermission == granted { return }
        saidPermission = granted
        out.emit(["permission": granted])
    }

    /// A game process that hasn't terminated (other than `except`): the list can still
    /// hold the one whose didTerminate notification is being handled, which mustn't keep
    /// the timers (SY-30).
    private func gameRunning(except: pid_t? = nil) -> Bool {
        NSWorkspace.shared.runningApplications.contains(where: {
            isGame($0) && !$0.isTerminated && $0.processIdentifier != except
        })
    }

    // MARK: What holds capture (DR-02)

    /// The hold facts now, read on the main thread whenever a stats line or an access_lost is written,
    /// so a line never describes an older state than its own counts: the attached window off screen
    /// (another Space, minimized) as the last lookup saw it, the game hidden, its display asleep, the
    /// session locked; and the region, for diagnostics.
    private func holdFacts() -> HoldFacts {
        let app = windowPid.flatMap { pid in NSWorkspace.shared.runningApplications.first { Int($0.processIdentifier) == pid } }
            ?? NSWorkspace.shared.runningApplications.first(where: isGame)
        return HoldFacts(onScreen: windowOnScreen, hidden: app?.isHidden ?? false,
                         asleep: Self.displayAsleep(under: windowFrame),
                         locked: SessionFacts.locked(CGSessionCopyCurrentDictionary() as? [String: Any]),
                         sourceRect: plan?.sourceRect)
    }

    /// The display under the window's top-left corner (the strip's). With no window seen yet, or none
    /// under that corner, the main display.
    static func display(under frame: CGRect?) -> CGDirectDisplayID {
        if let f = frame {
            var found: CGDirectDisplayID = 0
            var count: UInt32 = 0
            if CGGetDisplaysWithPoint(CGPoint(x: f.minX, y: f.minY), 1, &found, &count) == .success, count > 0 { return found }
        }
        return CGMainDisplayID()
    }

    /// Is the display under the window's top-left corner (the strip's) asleep?
    static func displayAsleep(under frame: CGRect?) -> Bool {
        CGDisplayIsAsleep(display(under: frame)) != 0
    }

    /// A stats line now, with the hold facts read now (main thread), counted on the frame queue.
    private func writeStats() {
        let facts = holdFacts()
        frameQueue.async { [weak self] in self?.reportStats(facts) }
    }

    private func noteWaiting(_ s: String, warn: Bool = false) {
        let now = Date()
        if now.timeIntervalSince(lastWaitNote) < 60 { return }
        lastWaitNote = now
        if warn { out.warn(s, key: "waiting") } else { out.info(s) }
    }

    private func candidate(_ w: SCWindow) -> WindowCandidate? {
        guard let app = w.owningApplication else { return nil }
        return WindowCandidate(id: w.windowID, pid: Int(app.processID), onScreen: w.isOnScreen, layer: w.windowLayer,
                               width: Double(w.frame.width), height: Double(w.frame.height),
                               bundleId: app.bundleIdentifier, appName: app.applicationName, title: w.title ?? "")
    }

    /// The window to capture (WindowPick.best): the game's, on screen, largest.
    private func pickWindow(_ windows: [SCWindow], gamePid: Int?) -> SCWindow? {
        guard let best = WindowPick.best(windows.compactMap(candidate), opts, gamePid: gamePid) else { return nil }
        return windows.first { $0.windowID == best.id }
    }

    private func windowInfo(_ w: SCWindow, scale: Double) -> [String: Any] {
        [
            "title": w.title ?? "",
            "app": w.owningApplication?.applicationName ?? "",
            "bundleId": w.owningApplication?.bundleIdentifier ?? "",
            "pid": Int(w.owningApplication?.processID ?? 0),
            "widthPt": Double(w.frame.width),
            "heightPt": Double(w.frame.height),
            "scale": scale,
            "onScreen": w.isOnScreen,
            "active": w.isActive,
        ]
    }

    private func configuration(_ w: SCWindow, scale: Double, strip: Geometry? = nil) -> SCStreamConfiguration {
        Self.configuration(widthPt: Double(w.frame.width), heightPt: Double(w.frame.height), scale: scale, opts, strip: strip)
    }

    /// The whole search region's width in points: a whole 200-cell row at the widest pitch the decoder
    /// reads (maxPitch px a cell), plus the 32 pt it searches for the first cell, so a strip a non-native
    /// fullscreen mode scales up (5.33 px on a 1x 2560-pt screen at 1920x1080, 10.8 px on a
    /// 1728-pt Retina panel at 1280x800) is never cut off: 2432 pt at 1x, 1232 pt at 2x. The fixed
    /// 900 pt read those as "truncated", every record but the shortest (systems critic r5 SY-25).
    /// A stream reads it only until the strip is measured (stripAreaPt).
    static func regionWidthPt(scale: Double, _ opts: Options) -> Double {
        opts.regionWidthPt ?? (Double(opts.spec.cells) * opts.spec.maxPitch / scale + 32)
    }

    /// Pixels past the measured strip's right and bottom edges the region keeps (as the Windows
    /// helper's WC_CROP_MARGIN): a measurement off by a pixel or two still reads every cell.
    static let stripMarginPx = 8.0

    /// The strip's own area, in whole points from the window's top-left (code health (Mac crop)): every
    /// cell of every row the decoder reads (spec.cells by spec.rows, 200 by 48, the longest record's frame)
    /// at the origin and pitch measured (g, in the stream's pixels at this scale), plus stripMarginPx. A
    /// record of more rows than the one measured is never cut. Never less than the decoder's search box
    /// (searchSpec) and a strip's first cells in it, so a strip that moves or grows past the area is
    /// still seen there, as one it can't read whole, and the stream reads the whole region again
    /// (RegionFit). nil for a geometry no search makes (not finite, or a pitch past the widest).
    static func stripAreaPt(_ g: Geometry, scale: Double, _ spec: StripSpec) -> (width: Double, height: Double)? {
        guard scale > 0, g.pitch > 0, g.pitch <= spec.maxPitch + 0.5, g.x0 > -g.pitch, g.y0 > -g.pitch,
              g.x0 < 4096, g.y0 < 4096 else { return nil }
        let search = searchSpec(spec, scale: scale)
        let wPx = max(max(g.x0, 0) + Double(spec.cells) * g.pitch, Double(search.searchCols) + 6 * spec.maxPitch + 4)
        let hPx = max(max(g.y0, 0) + Double(spec.rows) * g.pitch, Double(search.searchRows) + spec.maxPitch)
        return (((wPx + stripMarginPx) / scale).rounded(.up), ((hPx + stripMarginPx) / scale).rounded(.up))
    }

    /// The region, in points from the window's top-left: the whole search region (regionWidthPt by
    /// regionHeightPt) or, with the strip measured (strip, nil until then), no more than its own area
    /// (stripAreaPt). Never past the window.
    static func regionPt(widthPt: Double, heightPt: Double, scale: Double, _ opts: Options, strip: Geometry? = nil) -> (width: Double, height: Double) {
        let fit = strip.flatMap { stripAreaPt($0, scale: scale, opts.spec) } ?? (width: .infinity, height: .infinity)
        let wPt = min(regionWidthPt(scale: scale, opts), widthPt, fit.width)
        let hPt = min(opts.regionHeightPt, heightPt, fit.height)
        return (wPt, hPt)
    }

    /// The stream for a window of this size, in points, on a display of this scale, reading the region
    /// (regionPt) for the strip as measured, or the whole search region (--test-plan and --test-crop
    /// call it without a window).
    static func configuration(widthPt: Double, heightPt: Double, scale: Double, _ opts: Options, strip: Geometry? = nil) -> SCStreamConfiguration {
        let cfg = SCStreamConfiguration()
        let (wPt, hPt) = regionPt(widthPt: widthPt, heightPt: heightPt, scale: scale, opts, strip: strip)
        cfg.sourceRect = CGRect(x: 0, y: 0, width: wPt, height: hPt)
        cfg.width = Int((wPt * scale).rounded())
        cfg.height = Int((hPt * scale).rounded())
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        // sRGB, or the XDR panel's P3 would shift pure green toward the threshold.
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.minimumFrameInterval = CMTime(value: CMTimeValue(opts.intervalMs), timescale: 1000)
        cfg.showsCursor = false
        cfg.queueDepth = 3
        cfg.scalesToFit = false
        if #available(macOS 15.0, *) {
            cfg.captureDynamicRange = .SDR
        }
        return cfg
    }

    /// The strip may sit below a title bar: search a scale-aware depth
    /// (80 points, not 80 pixels) and width.
    private var spec: StripSpec = StripSpec()

    static func searchSpec(_ base: StripSpec, scale: Double) -> StripSpec {
        var s = base
        s.searchRows = Int((80 * scale).rounded())
        s.searchCols = Int((32 * scale).rounded())
        return s
    }

    @MainActor private func startStream(_ w: SCWindow) async throws {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let scale = Double(filter.pointPixelScale)
        let cfg = configuration(w, scale: scale)
        let newSpec = Self.searchSpec(opts.spec, scale: scale)
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
        try await s.startCapture()
        // A late continuation (a hung call that returned after another attach
        // or replan won) must not leave a second stream running.
        if stream != nil {
            Task { try? await s.stopCapture() }
            return
        }
        // Frames count from here: on the frame queue, so no decode sees half
        // of it. A hint from the old geometry would only cost failed decodes,
        // but drop it; frames of a stream we replaced are ignored.
        frameQueue.sync {
            spec = newSpec
            hint = nil
            activeStream = ObjectIdentifier(s)
            streamScale = scale
            nudged = false
            // Every stream reads the whole search region until a frame decodes (code health (Mac crop)).
            regionFit = RegionFit(widthPt: Double(w.frame.width), heightPt: Double(w.frame.height), scale: scale)
            fitHold = .distantPast
            regionExpect = nil
        }
        stream = s
        plan = StreamPlan(cfg, scale: scale)
        fitted = nil
        stoppedAt = nil
        windowOnScreen = w.isOnScreen
        windowFrame = w.frame
        windowPid = w.owningApplication.map { Int($0.processID) }
        holdActivity(true)
        sayPermission(true)
        var o: [String: Any] = ["info": "attached to '\(w.title ?? "")' (\(w.owningApplication?.applicationName ?? "?"), pid \(w.owningApplication?.processID ?? 0))"]
        o["window"] = windowInfo(w, scale: scale)
        out.emit(o)
        if saidError {
            saidError = false
            out.emit(["info": "capturing", "cleared": true])
        }
    }

    /// A probe on request from the bridge, of the window being captured.
    func probeNow(path: String) {
        guard let w = window else {
            out.error("probe: no window attached")
            return
        }
        Task { await self.probe(w, path: path) }
    }

    private func probe(_ w: SCWindow, path: String) async {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let scale = Double(filter.pointPixelScale)
        let probeSpec = Self.searchSpec(opts.spec, scale: scale)
        do {
            let sb = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter,
                                                                       configuration: configuration(w, scale: scale))
            guard let pb = sb.imageBuffer, let bmp = Bitmap.copy(from: pb) else {
                out.error("probe: capture returned no image")
                return
            }
            let saved = bmp.writePNG(path: path)
            var o: [String: Any] = ["info": saved ? "saved \(bmp.width)x\(bmp.height) to \(path)" : "could not write \(path)",
                                    "probe": path, "window": windowInfo(w, scale: scale)]
            switch StripDecoder.findAndDecode(bmp.pixels, probeSpec, hint: nil) {
            case .decoded(let id, let text, let bytes, let g):
                o["strip"] = ["id": id, "bytes": bytes, "text": text]
                o["geometry"] = ["x0": g.x0, "y0": g.y0, "pitch": g.pitch]
            case .rejected(let reason, let g):
                o["strip"] = ["rejected": reason]
                o["geometry"] = ["x0": g.x0, "y0": g.y0, "pitch": g.pitch]
            case .none:
                o["strip"] = NSNull()
            }
            out.emit(o)
        } catch {
            out.error("probe failed: \(error.localizedDescription)")
        }
    }

    // MARK: Following the window (display, scale, size)

    /// ScreenCaptureKit keeps the pixel size a stream was set up with. When the
    /// window moves to a display of another scale (a monitor unplugged, the
    /// window dragged across) or its size changes the region, the stream is
    /// set up again. A 1x stream kept for a Retina window sees 2 px cells,
    /// under the decoder's minimum, and finds no strip at all (2026-09-27).
    func replanIfNeeded() {
        Task { @MainActor in await self.replan() }
    }

    @MainActor private func replan() async {
        // One at a time; a replan stuck for 15 s in a call that never returns
        // (a known ScreenCaptureKit hang) no longer blocks the next one.
        if let since = replanSince, Date().timeIntervalSince(since) < 15 { return }
        guard let running = stream, let attached = window, let planned = plan else {
            // Nothing running and nobody looking (a restart stuck in startCapture):
            // look again. A late start that finds a stream running stops its own.
            if stream == nil, !attaching, opts.probePath == nil { Task { @MainActor in await self.attachLoop() } }
            return
        }
        replanGen += 1
        let gen = replanGen
        replanSince = Date()
        defer { if replanGen == gen { replanSince = nil } }
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
              gen == replanGen, stream === running
        else { return }
        let now = content.windows.first(where: { $0.windowID == attached.windowID })
        // The hold facts' window, as this lookup sees it (no lookup of its own).
        if let n = now {
            windowOnScreen = n.isOnScreen
            windowFrame = n.frame
        }
        // Another window is the game's now: an old process's lingers off screen
        // while the new one's is on screen (WindowPick.switchReason).
        let pid = gamePid()
        if let best = pickWindow(content.windows, gamePid: pid), let b = candidate(best),
           let why = WindowPick.switchReason(attached: now.flatMap(candidate), best: b, gamePid: pid) {
            await restart(running, on: best, because: "capturing another window (\(why))")
            return
        }
        // The window gone (and nothing else to capture) is didStopWithError's to handle.
        guard let w = now else { return }
        let scale = Double(SCContentFilter(desktopIndependentWindow: w).pointPixelScale)
        // Not a window caught halfway through a change.
        guard scale >= 1, w.frame.width >= 200, w.frame.height >= 150 else { return }
        let moved = fitted.map { displayChanges != $0.changes || Self.display(under: w.frame) != $0.display } ?? false
        switch Self.replanStep(planned, fitted: fitted?.strip, widthPt: Double(w.frame.width), heightPt: Double(w.frame.height),
                               scale: scale, displaysMoved: moved, opts) {
        case .restart(let change):
            await restart(running, on: w, because: "the game window changed (\(change)); capturing it again")
        case .whole:
            await refit(.whole, stream: ObjectIdentifier(running), because: "the displays changed")
        case .keep:
            break
        }
    }

    /// What a replan does with the window as it is now (tests: --test-crop): start the stream over
    /// (saying what changed) when the window's scale or the region it needs changed, else read the whole
    /// search region again when the strip it's fitted to was measured on another display or before the
    /// displays changed (code health (Mac crop)), else keep it.
    static func replanStep(_ planned: StreamPlan, fitted: Geometry?, widthPt: Double, heightPt: Double, scale: Double,
                           displaysMoved: Bool, _ opts: Options) -> ReplanStep {
        // A strip measured at another scale says nothing at this one: a new stream measures it again.
        let strip = scale == planned.scale ? fitted : nil
        let now = StreamPlan(configuration(widthPt: widthPt, heightPt: heightPt, scale: scale, opts, strip: strip), scale: scale)
        if let change = planned.change(to: now) { return .restart(change) }
        return fitted != nil && displaysMoved ? .whole : .keep
    }

    enum ReplanStep: Equatable {
        case restart(String)
        case whole
        case keep
    }

    /// The region a change gives a stream on a window of this size (refit; --test-crop): its rules
    /// (RegionFit) and its configuration.
    static func refitted(_ change: RegionFit.Change, widthPt: Double, heightPt: Double, scale: Double,
                         _ opts: Options) -> (RegionFit, SCStreamConfiguration) {
        var fit = RegionFit(widthPt: widthPt, heightPt: heightPt, scale: scale)
        fit.apply(change, opts)
        return (fit, configuration(widthPt: widthPt, heightPt: heightPt, scale: scale, opts, strip: fit.strip))
    }

    /// Fit the running stream's region (code health (Mac crop)): to the strip's own area as measured, or
    /// back to the whole search region. updateConfiguration changes the region in place: the same stream,
    /// so nothing attaches again. Its frames must show the change (verifyRegion). A stream that can't get
    /// the whole region back that way (an error) is started over, which reads the whole region; one that
    /// can't fit it keeps the whole region and asks again in a minute.
    @MainActor private func refit(_ change: RegionFit.Change, stream id: ObjectIdentifier, because why: String) async {
        guard let running = stream, ObjectIdentifier(running) == id, let w = window, let planned = plan else { return }
        let frame = windowFrame ?? w.frame
        // Where the strip was measured: the display under the window's corner, the display changes seen.
        let display = Self.display(under: frame), changes = displayChanges
        let (fit, cfg) = Self.refitted(change, widthPt: Double(frame.width), heightPt: Double(frame.height),
                                       scale: planned.scale, opts)
        let next = StreamPlan(cfg, scale: planned.scale)
        if next != planned {
            // Only a call numbers itself: the latest call's region is the one the stream ends with.
            refitGen += 1
            let gen = refitGen
            // A strip may be cut until the whole region is back: its frames within 5 s, whatever the
            // call does (a call that never returns included), or the stream is started over.
            if fit.strip == nil {
                frameQueue.sync { regionExpect = (cfg.width, cfg.height, Date().addingTimeInterval(5), true) }
            }
            do {
                try await running.updateConfiguration(cfg)
            } catch {
                guard gen == refitGen, stream === running else { return }
                if fit.strip == nil {
                    await restart(running, on: w, because: "the whole search region couldn't be set again (\(error.localizedDescription)); capturing it again")
                } else {
                    out.warn("the region couldn't be fitted to the strip (\(error.localizedDescription))", key: "region")
                    frameQueue.sync { if activeStream == id { fitHold = Date().addingTimeInterval(60) } }
                }
                return
            }
            // A later change asked meanwhile is the one the stream has.
            guard gen == refitGen, stream === running else { return }
            plan = next
            let r = cfg.sourceRect
            let size = "\(String(format: "%g", Double(r.width)))x\(String(format: "%g", Double(r.height))) pt (\(cfg.width)x\(cfg.height) px)"
            out.emit(["info": fit.strip.map { "capturing \(size), the strip's own area (\(String(format: "%.2f", $0.pitch)) px cells)" }
                          ?? "capturing \(size), the whole search region again: \(why)",
                      "region": ["widthPt": Double(r.width), "heightPt": Double(r.height), "width": cfg.width, "height": cfg.height]])
        }
        fitted = fit.strip.map { ($0, display, changes) }
        frameQueue.sync {
            guard activeStream == id else { return }
            regionFit = fit
            // Frames of the old region still on their way don't ask again.
            fitHold = Date().addingTimeInterval(1)
            if next != planned && fit.strip != nil { regionExpect = (cfg.width, cfg.height, Date().addingTimeInterval(3), false) }
        }
    }

    /// From the frame queue: a region change for the main actor (refit).
    private func refitSoon(_ change: RegionFit.Change, stream id: ObjectIdentifier, because why: String) {
        Task { @MainActor in await self.refit(change, stream: id, because: why) }
    }

    /// From the frame queue: a stream that kept its old region (verifyRegion) reads the whole search
    /// region, started over if a strip may be cut meanwhile.
    private func wholeSoon(stream id: ObjectIdentifier, restart: Bool, because why: String) {
        Task { @MainActor in
            guard let running = self.stream, ObjectIdentifier(running) == id else { return }
            if restart, let w = self.window {
                await self.restart(running, on: w, because: why)
            } else {
                await self.refit(.whole, stream: id, because: why)
            }
        }
    }

    /// Replace the running stream with one for w.
    @MainActor private func restart(_ running: SCStream, on w: SCWindow, because why: String) async {
        out.info(why)
        holdActivity(false)
        stream = nil
        plan = nil
        window = w
        // Nothing counts as attached, and the old stream's late frames don't
        // count, until the new stream is adopted.
        frameQueue.sync { activeStream = nil }
        // Not awaited: a stop that hangs mustn't keep capture down. Its late
        // frames are ignored (activeStream) and its stop isn't an error (stopped).
        Task { try? await running.stopCapture() }
        do {
            try await startStream(w)
        } catch {
            out.warn("capture could not restart after the window changed: \(error.localizedDescription); looking for the window again", key: "restart")
            if stream == nil {
                window = nil
                noteLost(code: (error as NSError).code)
                Task { @MainActor in await self.attachLoop() }
            }
        }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw), status == .complete,
              let pb = sb.imageBuffer
        else { return }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        // A stream we replaced may deliver a few more frames: they don't count.
        guard ObjectIdentifier(stream) == activeStream else { return }
        // Each frame carries its display's scale. A different one means the
        // window moved to another display: ask for a replan now, once per
        // stream (the replan itself checks, so a stray value costs one lookup).
        if let f = (attachments.first?[.scaleFactor] as? NSNumber)?.doubleValue {
            frameScale = f
            if f != streamScale && !nudged {
                nudged = true
                DispatchQueue.main.async { [weak self] in self?.replanIfNeeded() }
            }
        }
        let px = PixelBuffer(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb),
                             bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
                             base: UnsafePointer(base.assumingMemoryBound(to: UInt8.self)), bgra: true)
        let t0 = CFAbsoluteTimeGetCurrent()
        let result = StripDecoder.findAndDecode(px, spec, hint: hint)
        let dt = CFAbsoluteTimeGetCurrent() - t0
        frames += 1
        decodeSeconds += dt
        decodeMax = max(decodeMax, dt)
        verifyRegion(px.width, px.height)
        // What this frame asks of the region (code health (Mac crop)): the strip's own area as it decoded,
        // or the whole search region again for a strip the fitted region cut (RegionFit).
        let change = regionBroken ? nil : regionFit?.change(after: result, opts)
        switch result {
        case .decoded(let id, let text, let bytes, let g):
            decoded += 1
            hint = g
            let key = "\(id):\(text)"
            if key != lastKey {
                lastKey = key
                out.emit(["id": id, "text": text, "bytes": bytes])
            }
        case .rejected(let reason, let g):
            rejects += 1
            rejectReasons[reason, default: 0] += 1
            // A strip the fitted region cut (it moved, or its cells grew) reads whole once the region is
            // whole again: expected, so no warning for it (as the Windows crop that grows).
            if change == nil {
                out.warn("strip seen but rejected: \(reason)", key: "rejected", extra: ["geometry": ["x0": g.x0, "y0": g.y0, "pitch": g.pitch]])
            }
            // Cells too small to read: this stream's scale is below the window's.
            if reason == "pitch_too_small" && !nudged {
                nudged = true
                DispatchQueue.main.async { [weak self] in self?.replanIfNeeded() }
            }
        case .none:
            idle += 1
        }
        if let c = change { askRefit(c, after: result) }
    }

    /// One region change at a time, asked of the main actor (code health (Mac crop)); its answer sets
    /// when the next may be asked (refit), and a call that never returns holds them 15 s.
    private func askRefit(_ change: RegionFit.Change, after result: DecodeOutcome) {
        guard let id = activeStream, Date() >= fitHold else { return }
        fitHold = Date().addingTimeInterval(15)
        var why = "the strip measured"
        if case .rejected(let reason, _) = result { why = "the strip moved or grew (\(reason))" }
        DispatchQueue.main.async { [weak self] in self?.refitSoon(change, stream: id, because: why) }
    }

    /// The frames after a region change come at its size by the time it gives (code health (Mac crop)).
    /// A stream that keeps its old region reads the whole search region (started over when that change
    /// was the whole region: a strip may be cut until it shows), and no strip is fitted again in this
    /// helper's life.
    private func verifyRegion(_ width: Int, _ height: Int) {
        guard let e = regionExpect else { return }
        if width == e.width && height == e.height {
            regionExpect = nil
            return
        }
        guard Date() > e.by, let id = activeStream else { return }
        regionExpect = nil
        regionBroken = true
        let why = "the stream kept its \(width)x\(height) px region, not \(e.width)x\(e.height); capturing the whole search region from now on"
        DispatchQueue.main.async { [weak self] in self?.wholeSoon(stream: id, restart: e.whole, because: why) }
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let ns = error as NSError
        Task { @MainActor in self.stopped(stream, ns) }
    }

    @MainActor private func stopped(_ s: SCStream, _ ns: NSError) {
        // Only the running stream: one we replaced or stopped isn't news.
        guard s === stream else { return }
        out.warn("capture stopped (\(ns.domain) \(ns.code)): \(ns.localizedDescription); looking for the window again", key: "stopped")
        stream = nil
        window = nil
        plan = nil
        frameQueue.sync { activeStream = nil }
        holdActivity(false)
        // A stats line at once (attached false), so a stream that stops during a lock or a sleep never
        // leaves the bridge's hung-helper rule waiting on a timer App Nap may hold back (DR-02).
        writeStats()
        // Access taken back: the bridge hears it now. Anything else, while the game still runs, is a
        // typed error if no stream is back within 10 s (a display change re-attaches in 3 s, and
        // shouldn't flash "can't see the game"); a game that quit is no error.
        if ns.code == -3801 {
            sayPermission(false)
        } else {
            noteLost(code: ns.code)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await self.attachLoop()
        }
    }

    /// A stream that stopped, or a restart after a window change that failed: a typed error if no
    /// stream is back within 10 s (SY-04).
    @MainActor private func noteLost(code: Int) {
        let at = Date()
        stoppedAt = at
        reportLost(since: at, code: code, after: 10)
    }

    /// The typed error for a stream that stopped and isn't back, said again every minute while it
    /// lasts (as the Windows helper does), so the bridge's 2-minute freshness never lapses into "ok".
    /// Locked and asleep are read again first (SY-18): a stream can stop before the session shows the
    /// lock, so stopped()'s line may say locked false. Either one explains it: a stats line instead.
    private func reportLost(since at: Date, code: Int, after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self = self, self.stoppedAt == at, self.stream == nil, self.gameRunning() else { return }
            let facts = self.holdFacts()
            if let line = Self.lostLine(code: code, facts: facts) {
                self.saidError = true
                self.out.emit(line)
            } else {
                self.frameQueue.async { [weak self] in self?.reportStats(facts) }
            }
            self.reportLost(since: at, code: code, after: 60)
        }
    }

    /// What a stream that stopped and isn't back says (SY-18): nil (a stats line, which carries the
    /// facts) while locked or asleep explains it, else access_lost carrying both. Only these derived
    /// booleans leave the helper, never the session dictionary, which names the user.
    static func lostLine(code: Int, facts: HoldFacts) -> [String: Any]? {
        if facts.locked || facts.asleep { return nil }
        return ["error": "screen reading stopped (\(code)) and hasn't come back", "kind": "access_lost",
                "locked": facts.locked, "asleep": facts.asleep]
    }

    private var lastReported = (frames: 0, decoded: 0, rejects: 0)

    private func reportStats(_ facts: HoldFacts) {
        // Per-interval counts as well as totals: "no checksum rejects at steady
        // state" (AC0.1) is judged on intervals, not the whole run.
        let interval: [String: Any] = ["frames": frames - lastReported.frames, "decoded": decoded - lastReported.decoded,
                                       "rejected": rejects - lastReported.rejects]
        lastReported = (frames, decoded, rejects)
        var o: [String: Any] = [
            "interval": interval,
            "frames": frames, "decoded": decoded, "rejected": rejects, "idle": idle,
            "decodeAvgMs": frames > 0 ? (decodeSeconds / Double(frames) * 1000 * 100).rounded() / 100 : 0,
            "decodeMaxMs": (decodeMax * 1000 * 100).rounded() / 100,
            "rejectReasons": rejectReasons,
            "attached": activeStream != nil,
        ]
        if let f = frameScale { o["frameScale"] = f; o["streamScale"] = streamScale }
        if let g = hint { o["geometry"] = ["x0": g.x0, "y0": g.y0, "pitch": g.pitch] }
        for (k, v) in facts.json { o[k] = v }
        out.emit(["stats": o])
    }
}

/// What runs on a timer, by whether the game runs (systems critic SY-30):
/// while it does, the activity that keeps App Nap and timer coalescing off the
/// stream, the stats line every --stats-sec and the 10 s replan; while it's
/// closed, nothing (its launch, a workspace notification, starts them again).
/// --test-idle prints both.
enum GamePresence {
    static func parts(gameRunning: Bool) -> [String] {
        gameRunning ? ["activity", "stats", "replan"] : []
    }
}

func runTestIdle(_ out: Emitter) {
    out.emit(["closed": GamePresence.parts(gameRunning: false), "running": GamePresence.parts(gameRunning: true)])
}

/// What holds capture (display DR-02): the attached window off screen (another Space, minimized),
/// the game hidden (Cmd+H), its display asleep, the session locked. The bridge's stall rule (R3) and
/// its access_lost rule (R1) wait while one holds; nothing restarts or publishes for them. The
/// stream's region rides along for diagnostics (D-15: a region too small shows there).
struct HoldFacts {
    var onScreen: Bool?
    var hidden = false
    var asleep = false
    var locked = false
    var sourceRect: CGRect?

    var json: [String: Any] {
        var o: [String: Any] = ["hidden": hidden, "asleep": asleep, "locked": locked]
        if let s = onScreen { o["onScreen"] = s }
        if let r = sourceRect { o["sourceRect"] = [r.origin.x, r.origin.y, r.width, r.height] }
        return o
    }
}

/// The session's lock, from CGSessionCopyCurrentDictionary: locked while the lock screen shows
/// (CGSSessionScreenIsLocked) or while this session isn't the one on the console (fast user
/// switching: kCGSSessionOnConsoleKey false). No dictionary says nothing (SY-13).
enum SessionFacts {
    static func locked(_ d: [String: Any]?) -> Bool {
        guard let d = d else { return false }
        if let l = d["CGSSessionScreenIsLocked"] as? Bool, l { return true }
        if let c = d["kCGSSessionOnConsoleKey"] as? Bool, !c { return true }
        return false
    }
}

/// Tests (DR-02): the lock fact and what a stream that stopped would say, through the functions the
/// helper runs. The file holds {"session": {<the session dictionary's keys>}, "asleep": bool,
/// "code": n}; prints {"locked", "asleep", "send"}, send being the access_lost line or a stats
/// line's facts. Nothing of the dictionary but the derived boolean comes out.
func runTestSession(_ path: String, _ out: Emitter) {
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        out.error("--test-session wants a JSON file with a session dictionary")
        return
    }
    let facts = HoldFacts(onScreen: nil, hidden: false, asleep: (json["asleep"] as? Bool) ?? false,
                          locked: SessionFacts.locked(json["session"] as? [String: Any]), sourceRect: nil)
    var stats = facts.json
    stats["attached"] = false
    let send = CaptureController.lostLine(code: (json["code"] as? Int) ?? -3815, facts: facts) ?? ["stats": stats]
    out.emit(["locked": facts.locked, "asleep": facts.asleep, "send": send])
}

/// What a stream was set up for. A different plan for the window as it is now
/// means the stream must be set up again.
struct StreamPlan: Equatable {
    let scale: Double
    let sourceRect: CGRect
    let width: Int
    let height: Int

    init(_ cfg: SCStreamConfiguration, scale: Double) {
        self.scale = scale
        sourceRect = cfg.sourceRect
        width = cfg.width
        height = cfg.height
    }

    /// Why a stream on this plan must be set up again as next, or nil.
    func change(to next: StreamPlan) -> String? {
        if next == self { return nil }
        let g = { (v: Double) in String(format: "%g", v) }
        var parts: [String] = []
        if next.scale != scale { parts.append("scale \(g(scale)) -> \(g(next.scale))") }
        if next.sourceRect != sourceRect {
            parts.append("region \(g(sourceRect.width))x\(g(sourceRect.height)) -> \(g(next.sourceRect.width))x\(g(next.sourceRect.height)) pt")
        }
        if parts.isEmpty { parts.append("frame \(width)x\(height) -> \(next.width)x\(next.height) px") }
        return parts.joined(separator: ", ")
    }
}

/// The region a stream reads against the strip (code health (Mac crop)): the whole search region until a
/// frame decodes, then the strip's own area as measured (CaptureController.stripAreaPt), following it
/// as it's measured anew, and the whole search region again once a frame there sees a strip it can't
/// read whole (it moved, or its cells grew). A new stream (another window, scale or size) starts with
/// the whole region, and a strip measured before the displays changed is measured again
/// (replanStep). Pure: the frame queue and --test-crop run the same rules.
struct RegionFit {
    /// The window, in points, and its display's scale.
    let widthPt: Double
    let heightPt: Double
    let scale: Double
    /// The strip the region is fitted to, in the stream's pixels; nil: the whole search region.
    private(set) var strip: Geometry? = nil

    init(widthPt: Double, heightPt: Double, scale: Double) {
        self.widthPt = widthPt
        self.heightPt = heightPt
        self.scale = scale
    }

    enum Change: Equatable {
        case fit(Geometry)
        case whole
    }

    /// The region for a strip (nil: the whole search region): in points, and in the frame's pixels.
    func region(_ g: Geometry?, _ opts: Options) -> (widthPt: Double, heightPt: Double, width: Int, height: Int) {
        let r = CaptureController.regionPt(widthPt: widthPt, heightPt: heightPt, scale: scale, opts, strip: g)
        return (r.width, r.height, Int((r.width * scale).rounded()), Int((r.height * scale).rounded()))
    }

    /// What a frame's outcome asks of the region, or nil to keep it. A decode: the strip's own area at its
    /// geometry, once that's more than half the margin (stripMarginPx) from the region now, wider or
    /// narrower. A strip seen but not read whole in a fitted region: the whole search region.
    func change(after outcome: DecodeOutcome, _ opts: Options) -> Change? {
        switch outcome {
        case .decoded(_, _, _, let g):
            let want = region(g, opts), now = region(strip, opts)
            let slack = Int(CaptureController.stripMarginPx / 2)
            return abs(want.width - now.width) > slack || abs(want.height - now.height) > slack ? .fit(g) : nil
        case .rejected:
            return strip == nil ? nil : .whole
        case .none:
            return nil
        }
    }

    /// The region once the stream has the change: a strip whose area is no smaller than the whole search
    /// region reads the whole region.
    mutating func apply(_ change: Change, _ opts: Options) {
        if case .fit(let g) = change, region(g, opts) != region(nil, opts) {
            strip = g
        } else {
            strip = nil
        }
    }
}

/// "2742x1570@1": a window's width and height in points, and its display's scale.
func windowSpec(_ s: String) -> (Double, Double, Double)? {
    let at = s.split(separator: "@")
    let wh = at.first?.split(separator: "x").compactMap { Double($0) } ?? []
    guard at.count == 2, wh.count == 2, let scale = Double(at[1]) else { return nil }
    return (wh[0], wh[1], scale)
}

/// Tests (code health (Mac crop)): the region a stream reads against the strip, step by step, through
/// the rules the frame queue (RegionFit) and replan (replanStep) run, a change applied as refit
/// applies it. The file holds {"window": "WxH@SCALE", "steps": [...]}, each step one of
/// {"frame": "<png>"}: a frame, the PNG being the window's top-left as the display shows it, of which
/// the stream gets the region's top-left corner, decoded as the frame queue decodes it (the last
/// decode's geometry tried first); {"window": "WxH@SCALE"}: the window as replan finds it now;
/// {"displays": true}: the displays changed. Prints a line a step: what a frame decoded to, what
/// changed, and the region after it, in points and pixels. Configurations only: no capture API, no
/// permission.
func runTestCrop(_ path: String, _ opts: Options, _ out: Emitter) {
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          var window = (json["window"] as? String).flatMap(windowSpec),
          let steps = json["steps"] as? [[String: Any]]
    else {
        out.error("--test-crop wants a JSON file with a window (WxH@SCALE) and steps")
        return
    }
    var fit = RegionFit(widthPt: window.0, heightPt: window.1, scale: window.2)
    var plan = StreamPlan(CaptureController.configuration(widthPt: window.0, heightPt: window.1, scale: window.2, opts), scale: window.2)
    var hint: Geometry? = nil
    for step in steps {
        var o: [String: Any] = [:]
        var change: RegionFit.Change? = nil
        if let file = step["frame"] as? String {
            guard let bmp = Bitmap.load(path: file) else {
                out.error("cannot read image \(file)")
                return
            }
            // What the stream gets: the region's top-left corner of the window, the region's size.
            let px = PixelBuffer(width: min(plan.width, bmp.width), height: min(plan.height, bmp.height),
                                 bytesPerRow: bmp.bytesPerRow, base: UnsafePointer(bmp.data), bgra: true)
            let result = StripDecoder.findAndDecode(px, CaptureController.searchSpec(opts.spec, scale: fit.scale), hint: hint)
            switch result {
            case .decoded(let id, _, let bytes, let g):
                hint = g
                o["decoded"] = ["id": id, "bytes": bytes, "pitch": g.pitch]
            case .rejected(let reason, _):
                o["rejected"] = reason
            case .none:
                o["decoded"] = NSNull()
            }
            change = fit.change(after: result, opts)
        } else {
            let now = (step["window"] as? String).flatMap(windowSpec) ?? window
            let moved = (step["displays"] as? Bool) ?? false
            switch CaptureController.replanStep(plan, fitted: fit.strip, widthPt: now.0, heightPt: now.1, scale: now.2,
                                                displaysMoved: moved, opts) {
            case .restart(let why):
                // A new stream: the whole search region, no geometry carried over.
                fit = RegionFit(widthPt: now.0, heightPt: now.1, scale: now.2)
                plan = StreamPlan(CaptureController.configuration(widthPt: now.0, heightPt: now.1, scale: now.2, opts), scale: now.2)
                hint = nil
                o["restart"] = why
            case .whole:
                change = .whole
            case .keep:
                break
            }
            window = now
        }
        if let c = change {
            let (next, cfg) = CaptureController.refitted(c, widthPt: window.0, heightPt: window.1, scale: fit.scale, opts)
            fit = next
            plan = StreamPlan(cfg, scale: fit.scale)
            o["change"] = fit.strip == nil ? "whole" : "fit"
        }
        let r = plan.sourceRect
        o["region"] = ["widthPt": Double(r.width), "heightPt": Double(r.height), "width": plan.width, "height": plan.height]
        out.emit(o)
    }
}

/// Tests: the stream set up for a window as attached ("2742x1570@1": points
/// and display scale) and as it is now, whether that change restarts the
/// stream, and the strip's cell pitch in the old stream's frames and the new
/// one's. Creates configurations only; no capture API, no permission.
func runTestPlan(_ attached: String, _ now: String, _ opts: Options, _ out: Emitter) {
    guard let a = windowSpec(attached), let n = windowSpec(now) else {
        out.error("--test-plan wants two WIDTHxHEIGHT@SCALE arguments")
        return
    }
    func describe(_ v: (Double, Double, Double)) -> (StreamPlan, [String: Any]) {
        let cfg = CaptureController.configuration(widthPt: v.0, heightPt: v.1, scale: v.2, opts)
        let spec = CaptureController.searchSpec(opts.spec, scale: v.2)
        let r = cfg.sourceRect
        return (StreamPlan(cfg, scale: v.2), ["width": cfg.width, "height": cfg.height, "scale": v.2,
                                              "sourceRect": [r.origin.x, r.origin.y, r.width, r.height],
                                              "searchRows": spec.searchRows, "searchCols": spec.searchCols])
    }
    let (pa, ja) = describe(a)
    let (pn, jn) = describe(n)
    let cell = Double(opts.cellPx)
    let act = CaptureController.activityOptions
    out.emit(["attached": ja, "now": jn, "change": pa.change(to: pn) ?? NSNull(),
              // The addon draws cellPx physical pixels a cell; a stream at scale s
              // of a window drawn at scale d shows cellPx * s / d.
              "stalePitch": cell * a.2 / n.2, "pitch": cell,
              // What a running stream holds (D-14): off App Nap, never off idle sleep.
              "activity": ["idleSystemSleepDisabled": act.contains(.idleSystemSleepDisabled),
                           "latencyCritical": act.contains(.latencyCritical),
                           "userInitiated": act.contains(.userInitiatedAllowingIdleSystemSleep)]])
}
