import Foundation

/// A window the helper might capture, as ScreenCaptureKit lists it: a plain
/// value, so --test-pick can check the choice without the capture API.
struct WindowCandidate {
    let id: UInt32
    let pid: Int
    let onScreen: Bool
    let layer: Int
    let width: Double
    let height: Double
    let bundleId: String
    let appName: String
    let title: String
}

enum WindowPick {
    /// The game's own window: a normal-layer window of a useful size, by title
    /// (--window-name), else by the app as isGame judges it: its bundle id when
    /// it has one, its name only when it hasn't (the search waits on isGame).
    static func matches(_ c: WindowCandidate, _ opts: Options) -> Bool {
        if c.layer != 0 || c.width < 200 || c.height < 150 { return false }
        if !opts.windowName.isEmpty { return c.title.localizedCaseInsensitiveContains(opts.windowName) }
        return c.bundleId.isEmpty ? c.appName.localizedCaseInsensitiveContains(opts.process) : c.bundleId == opts.bundleId
    }

    /// The window to capture: the running game's (gamePid) first, then one on
    /// screen, then the largest. A window an old game process leaves off screen
    /// must not win over the one the player sees (26 Sep: 11 min 40 s blind).
    static func best(_ cs: [WindowCandidate], _ opts: Options, gamePid: Int?) -> WindowCandidate? {
        func rank(_ c: WindowCandidate) -> (Int, Int, Double) {
            (gamePid != nil && c.pid == gamePid ? 1 : 0, c.onScreen ? 1 : 0, c.width * c.height)
        }
        return cs.filter { matches($0, opts) }.max { rank($0) < rank($1) }
    }

    /// Why to leave the attached window for best, or nil to stay: only when the
    /// attached one is gone, isn't the game's process, or is off screen while
    /// best is on. Never for the same window, so a Space switch or a minimized
    /// game (nothing of it on screen) changes nothing.
    static func switchReason(attached: WindowCandidate?, best: WindowCandidate, gamePid: Int?) -> String? {
        guard let a = attached else { return "window \(best.id) of pid \(best.pid); the attached one is gone" }
        if a.id == best.id { return nil }
        if let g = gamePid, a.pid != g, best.pid == g {
            return "window \(best.id) of the game's pid \(g), not pid \(a.pid)"
        }
        if !a.onScreen && best.onScreen { return "window \(best.id) is on screen, window \(a.id) isn't" }
        return nil
    }
}

/// Tests: which window the helper would capture, and whether it would leave
/// the attached one. The file holds {"gamePid": n|null, "attached": id|null,
/// "windows": [{id, pid, onScreen, layer, width, height, bundleId, appName,
/// title}]}. No capture API, no permission.
func runTestPick(_ path: String, _ opts: Options, _ out: Emitter) {
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let list = json["windows"] as? [[String: Any]]
    else {
        out.error("--test-pick wants a JSON file with a windows list")
        return
    }
    let cs = list.map { w in
        WindowCandidate(id: UInt32((w["id"] as? Int) ?? 0), pid: (w["pid"] as? Int) ?? 0,
                        onScreen: (w["onScreen"] as? Bool) ?? false, layer: (w["layer"] as? Int) ?? 0,
                        width: (w["width"] as? Double) ?? 0, height: (w["height"] as? Double) ?? 0,
                        bundleId: (w["bundleId"] as? String) ?? "", appName: (w["appName"] as? String) ?? "",
                        title: (w["title"] as? String) ?? "")
    }
    let gamePid = json["gamePid"] as? Int
    let attached = (json["attached"] as? Int).flatMap { id in cs.first { $0.id == UInt32(id) } }
    guard let best = WindowPick.best(cs, opts, gamePid: gamePid) else {
        out.emit(["best": NSNull(), "switch": NSNull()])
        return
    }
    out.emit(["best": Int(best.id),
              "switch": WindowPick.switchReason(attached: attached, best: best, gamePid: gamePid) ?? NSNull()])
}
