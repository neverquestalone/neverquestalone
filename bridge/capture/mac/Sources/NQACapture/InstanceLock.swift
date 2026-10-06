import Foundation

/// The single-instance lock: an flock on a file holding our pid, beside the bridge's socket. The
/// kernel drops it when the process exits, however it exits.
///
/// Each build's bridge keeps its socket in its own state folder (or, when that path is too long for
/// a socket, under a per-install name in $TMPDIR), so each build has its own lock, and a checkout's
/// helper and the app's never refuse each other (display audit D-43).
final class InstanceLock {
    private let fd: Int32

    private init(fd: Int32) { self.fd = fd }

    /// <socket's folder>/<socket's name without .sock>.lock: <state>/capture.lock, or
    /// $TMPDIR/capture-<hash>.lock beside $TMPDIR/capture-<hash>.sock.
    static func path(forSocket socket: String) -> String {
        let s = socket as NSString
        let name = s.lastPathComponent
        let stem = name.hasSuffix(".sock") ? String(name.dropLast(5)) : name
        return (s.deletingLastPathComponent as NSString).appendingPathComponent(stem + ".lock")
    }

    static func acquire(path: String) -> InstanceLock? {
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            return nil
        }
        ftruncate(fd, 0)
        let pid = "\(getpid())\n"
        _ = pid.withCString { write(fd, $0, strlen($0)) }
        return InstanceLock(fd: fd)
    }

    /// The pid the lock file holds, when it holds one.
    static func holder(path: String) -> Int? {
        guard let s = try? String(contentsOfFile: path, encoding: .utf8),
              let pid = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return nil }
        return pid
    }

    /// The typed refusal (systems critic SY-15): the bridge reads `holder`, and clears a copy of this
    /// same app that won't exit. Without a pid (the file unreadable) it says so without one.
    static func busyLine(holder: Int?) -> [String: Any] {
        var o: [String: Any] = ["error": "another copy of the capture helper is already running" + (holder.map { " (pid \($0))" } ?? ""),
                                "kind": "instance_busy"]
        if let h = holder { o["holder"] = h }
        return o
    }

    deinit { close(fd) }
}
