import Foundation

/// One JSON object per line, to the bridge's Unix socket (the app is launched
/// through LaunchServices, so it has no useful stdout) or to stdout (tests).
/// The process exits when the bridge goes away: socket closed or stdout broken.
final class Emitter {
    private let queue = DispatchQueue(label: "nqa.capture.emit")
    /// The bridge's socket once connected, else stdout (NeverQuestAlone's build asks who serves the
    /// socket before anything is sent on it: PeerCheck.swift).
    private(set) var fd: Int32 = STDOUT_FILENO
    private var readSource: DispatchSourceRead?
    /// When each warning key was last said (warn).
    private var lastWarn: [String: Date] = [:]
    private var inbound = Data()
    /// Commands from the bridge, one JSON object per line (e.g. {"probe": "<png path>"}).
    var onCommand: (([String: Any]) -> Void)?

    /// Connect to the bridge's socket. Returns false if nobody is listening.
    func connect(socketPath: String) -> Bool {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { close(s); return false }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            buf.copyBytes(from: bytes)
            buf[bytes.count] = 0
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, len) }
        }
        guard r == 0 else { close(s); return false }
        var on: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        fd = s
        // End of file means the bridge went away: exit. Anything else is a
        // command line from the bridge.
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: DispatchQueue.global())
        src.setEventHandler { [weak self] in
            var buf = [UInt8](repeating: 0, count: 4096)
            let n = read(s, &buf, buf.count)
            if n < 0 && (errno == EINTR || errno == EAGAIN) { return } // spurious: try again on the next event
            if n <= 0 { exit(0) }
            self?.received(Data(buf[0..<n]))
        }
        src.resume()
        readSource = src
        return true
    }

    private func received(_ chunk: Data) {
        inbound.append(chunk)
        if inbound.count > 65536 { inbound.removeAll() } // nothing legitimate is that long
        while let nl = inbound.firstIndex(of: 0x0A) {
            let line = inbound.subdata(in: inbound.startIndex..<nl)
            inbound.removeSubrange(inbound.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                onCommand?(obj)
            }
        }
    }

    func emit(_ obj: [String: Any]) {
        queue.sync {
            guard JSONSerialization.isValidJSONObject(obj),
                  var data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])
            else { return }
            data.append(0x0A)
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                var off = 0
                while off < raw.count {
                    let n = write(fd, raw.baseAddress! + off, raw.count - off)
                    if n < 0 {
                        if errno == EINTR { continue }
                        exit(0) // the bridge is gone
                    }
                    off += n
                }
            }
        }
    }

    func info(_ s: String) { emit(["info": s]) }
    func error(_ s: String) { emit(["error": s]) }

    /// At most one warning every 5 s per key: the caller's key, else the text itself. One budget for
    /// every warning let a run of strip rejects swallow "capture stopped" (display audit D-16).
    func warn(_ s: String, key: String? = nil, extra: [String: Any] = [:], now: Date = Date()) {
        let k = key ?? s
        let due: Bool = queue.sync {
            if let t = lastWarn[k], now.timeIntervalSince(t) < 5 { return false }
            if lastWarn.count >= 32 { lastWarn = lastWarn.filter { now.timeIntervalSince($0.value) < 5 } }
            lastWarn[k] = now
            return true
        }
        if due {
            var o = extra
            o["warn"] = s
            emit(o)
        }
    }
}

/// Tests: warnings through the per-key budget at the file's times. The file holds
/// [{"at": seconds, "key": "…" (optional), "warn": "…"}]; what goes out is printed as the helper sends it.
func runTestWarns(_ path: String, _ out: Emitter) {
    guard let data = FileManager.default.contents(atPath: path),
          let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
        out.error("--test-warns wants a JSON list of {at, key, warn}")
        return
    }
    for w in list {
        guard let text = w["warn"] as? String, let at = (w["at"] as? NSNumber)?.doubleValue else { continue }
        out.warn(text, key: w["key"] as? String, now: Date(timeIntervalSince1970: at))
    }
}
