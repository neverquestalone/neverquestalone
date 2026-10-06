import AppKit
import Foundation

// NeverQuestAlone Capture (PRD §9.10). The bridge launches it through LaunchServices:
//   open -g -a "NeverQuestAlone Capture.app" --args --socket <path> [flags]
// so the app is its own "responsible" process and the Screen Recording grant
// belongs to it, never to node or the terminal. It streams JSON lines
// ({info}, {warn}, {error[, kind]}, {id, text}, {stats}, {game}, {window},
// {permission}) to the bridge's Unix socket and exits when that socket closes.
// The stats line carries what holds capture (onScreen, hidden, asleep, locked;
// display DR-02), which the bridge's watchdog waits on instead of restarting.

signal(SIGPIPE, SIG_IGN)
let opts = Options.parse(CommandLine.arguments)
let out = Emitter()

#if NQA_PUBLIC_ID
// NeverQuestAlone's build takes nothing that aims it (code health BR-01, the old audit LS-01): a typed
// line on stdout and exit 7 before anything else, so whoever launches it can't point its Screen
// Recording grant at another window, region or file (Options.aiming). The build decides, never argv.
if !opts.refused.isEmpty {
    out.emit(["error": "this build doesn't take \(opts.refused.joined(separator: ", "))", "kind": "args_refused"])
    exit(7)
}
#endif

if let requirement = opts.checkPeer {
    // The app's side of the peer check (code health LS-03 / peer check): transport/capture.mjs runs
    // this executable directly with a connection its capture socket accepted as fd 3, and takes that
    // connection only on exit 0. Who connected is named by the socket's peer audit token and held to
    // the app's requirement (PeerCheck.swift); one stderr line and exit 6 otherwise. Nothing is read
    // from or written to fd 3, and nothing else runs: no capture, no permission, no lock.
    if let why = peerRefusal(fd: 3, requirement: requirement, who: "the program that connected", wanted: "NeverQuestAlone's capture helper") {
        FileHandle.standardError.write("NeverQuestAlone Capture: refused: \(why)\n".data(using: .utf8)!)
        exit(6)
    }
    exit(0)
}

if let path = opts.testImage {
    // Tests: decode one PNG to stdout. No capture API, no permission, no lock.
    runTestImage(path, opts, out)
    exit(0)
}

if let (attached, now) = opts.testPlan {
    // Tests: stream configurations only. No capture, no permission, no lock.
    runTestPlan(attached, now, opts, out)
    exit(0)
}

if let path = opts.testCrop {
    // Tests: the region a stream reads against the strip (code health (Mac crop)). No capture, no
    // permission, no lock.
    runTestCrop(path, opts, out)
    exit(0)
}

if let path = opts.testPick {
    // Tests: which window to capture. No capture, no permission, no lock.
    runTestPick(path, opts, out)
    exit(0)
}

if opts.testIdle {
    // Tests: what runs on a timer with the game closed and running (SY-30). No capture, no lock.
    runTestIdle(out)
    exit(0)
}

if let path = opts.testSession {
    // Tests: the lock fact and what a lost stream says. No capture, no permission, no lock.
    runTestSession(path, out)
    exit(0)
}

if let path = opts.testWarns {
    // Tests: the warnings' per-key budget. No capture, no permission, no lock.
    runTestWarns(path, out)
    exit(0)
}

if let path = opts.testLock {
    // Tests: the single-instance lock at path, taken and refused as a capture run does it, and
    // nothing else (no capture, no permission, no socket). The copy that gets it holds it until its
    // stdin ends; a second says who holds it, the way a capture run tells the bridge.
    if let lock = InstanceLock.acquire(path: path) {
        out.emit(["info": "holding the lock", "pid": Int(getpid())])
        withExtendedLifetime(lock) { while readLine() != nil {} }
        exit(0)
    }
    out.emit(InstanceLock.busyLine(holder: InstanceLock.holder(path: path)))
    exit(3)
}

// Screen Recording belongs to the "responsible" process. Only the signed app
// bundle, launched by LaunchServices (so its parent is launchd), may touch a
// capture or permission API; run from a shell or spawned by node, the grant
// and the prompt would go to Terminal or node (PRD §9.10, kickoff rule 6).
func refuseUnlessLaunchedAsApp() {
    let bundleOK = Bundle.main.bundleIdentifier == captureBundleId // BundleID.swift, from BUNDLE_ID
    let launchedByLaunchServices = getppid() == 1
    if !(bundleOK && launchedByLaunchServices) {
        FileHandle.standardError.write("NeverQuestAlone Capture: capture only runs as \"NeverQuestAlone Capture.app\" launched with `open -a` (bundle ok: \(bundleOK), parent pid \(getppid())). Use --test-image to decode a file.\n".data(using: .utf8)!)
        exit(5)
    }
}

refuseUnlessLaunchedAsApp()

// The app's own check and request (onboarding spec §9.4): each is a new instance (open -n) the app
// starts beside a socket helper that may already be up, so both run before the socket and the
// instance lock, print one {"permission": bool} line (to --stdout) and exit.
if opts.checkPermission {
    out.emit(["permission": CGPreflightScreenCaptureAccess()])
    exit(0)
}
if opts.requestPermission {
    // The player's Allow click: macOS's box, once for this app. Then wait for the answer (a check
    // every second, up to 120 s), so the box is never left without anyone to hear it.
    var granted = CGPreflightScreenCaptureAccess()
    if !granted {
        _ = CGRequestScreenCaptureAccess()
        let until = Date().addingTimeInterval(120)
        while !granted && Date() < until {
            Thread.sleep(forTimeInterval: 1)
            granted = CGPreflightScreenCaptureAccess()
        }
    }
    out.emit(["permission": granted])
    exit(0)
}

// Without the bridge's socket there is nobody to read the output: a launch by
// Finder, Spotlight, login resume or macOS "Quit & Reopen" must not capture.
guard let sock = opts.socketPath else {
    FileHandle.standardError.write("NeverQuestAlone Capture: started without --socket (not by the bridge); exiting.\n".data(using: .utf8)!)
    exit(0)
}
if !out.connect(socketPath: sock) {
    FileHandle.standardError.write("NeverQuestAlone Capture: nobody is listening on \(sock)\n".data(using: .utf8)!)
    exit(2)
}

#if NQA_PUBLIC_ID
// Only the NeverQuestAlone app may hear what this app captures (code health BR-01): who serves the
// socket is checked before the lock, the capture or any permission call, and nothing is sent to it
// first (PeerCheck.swift). One stderr line and exit 6 otherwise.
if let why = peerRefusal(fd: out.fd) {
    FileHandle.standardError.write("NeverQuestAlone Capture: refused: \(why)\n".data(using: .utf8)!)
    exit(6)
}
#endif

// Single instance per bridge, so per build (D-43): a pending permission prompt must not stack
// copies. The lock sits beside the bridge's socket. A refusal is typed, with the holder's pid
// (SY-15): the bridge clears a copy of this same app that won't exit.
let lockPath = InstanceLock.path(forSocket: sock)
guard let lock = InstanceLock.acquire(path: lockPath) else {
    out.emit(InstanceLock.busyLine(holder: InstanceLock.holder(path: lockPath)))
    exit(3)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = CaptureController(opts, out)
out.onCommand = { cmd in
    #if NQA_PUBLIC_ID
    // A public build keeps no pictures (the trust plan): a probe on request is refused like
    // --probe (Options.aiming), so nothing in it writes a frame to disk.
    if cmd["probe"] != nil { out.error("probe refused: a public build keeps no pictures") }
    #else
    // Only probes, only into a PNG the bridge names inside its state folder's
    // probes/ directory, the socket's folder (resolved, so ".." or a symlink can't escape it).
    guard let raw = cmd["probe"] as? String, raw.hasSuffix(".png") else { return }
    let probesDir = URL(fileURLWithPath: (sock as NSString).deletingLastPathComponent).appendingPathComponent("probes").resolvingSymlinksInPath().path
    let target = URL(fileURLWithPath: raw).standardizedFileURL
    let parent = target.deletingLastPathComponent().resolvingSymlinksInPath().path
    if parent == probesDir && !target.lastPathComponent.hasPrefix(".") {
        DispatchQueue.main.async { controller.probeNow(path: target.path) }
    } else {
        out.error("probe path refused (must be a .png directly in \(probesDir))")
    }
    #endif
}
controller.start()
withExtendedLifetime(lock) {
    app.run()
}
