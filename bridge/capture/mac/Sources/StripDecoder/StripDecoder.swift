// Decodes the addon's pixel strip (see addon/NeverQuestAlone/Codec.lua):
//   [magic1 magic2] [id hi, lo] [len hi, lo] [payload] [fletcher-16 s1, s2]
// packed MSB-first into 3-bit cells (bit 2 = R, bit 1 = G, bit 0 = B), each
// channel fully on or off. Same rules as upstream's capture.ps1 and
// capture_x11.py, plus what the Mac needs: the cell pitch is measured from the
// strip itself instead of assumed (native Retina gives 4 px, a scaled
// fullscreen mode about 5.4 px), and the strip may sit below a title bar.

public struct PixelBuffer {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let base: UnsafePointer<UInt8>
    /// true: bytes are B, G, R, A (CoreVideo 32BGRA); false: R, G, B, A.
    public let bgra: Bool

    public init(width: Int, height: Int, bytesPerRow: Int, base: UnsafePointer<UInt8>, bgra: Bool) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.base = base
        self.bgra = bgra
    }

    @inline(__always) public func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let p = base + y * bytesPerRow + x * 4
        return bgra ? (Int(p[2]), Int(p[1]), Int(p[0])) : (Int(p[0]), Int(p[1]), Int(p[2]))
    }

    /// The 3-bit value of one pixel: anything past mid-grey counts as "on".
    @inline(__always) public func cell(_ x: Int, _ y: Int) -> Int {
        let (r, g, b) = rgb(x, y)
        return (r >= 128 ? 4 : 0) | (g >= 128 ? 2 : 0) | (b >= 128 ? 1 : 0)
    }
}

/// Where the strip is: its top-left corner and the cell pitch, in pixels.
public struct Geometry: Equatable, CustomStringConvertible {
    public var x0: Double
    public var y0: Double
    public var pitch: Double

    public init(x0: Double, y0: Double, pitch: Double) {
        self.x0 = x0
        self.y0 = y0
        self.pitch = pitch
    }

    public var description: String {
        "x0=\(fmt(x0)) y0=\(fmt(y0)) pitch=\(fmt(pitch))"
    }
}

@inline(__always) func fmt(_ v: Double) -> String {
    let r = (v * 1000).rounded() / 1000
    return String(r)
}

public struct StripSpec {
    public var cells = 200
    public var rows = 48
    public var magic: (UInt8, UInt8) = (0xC7, 0x1A)
    /// Pixel rows searched for the strip's first row (a title bar pushes it down).
    public var searchRows = 80
    /// Pixel columns searched for the first cell.
    public var searchCols = 32
    public var minPitch = 2.5
    public var maxPitch = 12.0

    public init() {}
}

public enum DecodeOutcome {
    /// No strip in view (the normal idle state).
    case none
    /// The magic matched but the frame didn't validate.
    case rejected(reason: String, geometry: Geometry)
    case decoded(id: Int, text: String, bytes: Int, geometry: Geometry)
}

public enum StripDecoder {
    /// Decode with the cells sampled at their centers for a given geometry.
    public static func decode(_ px: PixelBuffer, _ g: Geometry, _ spec: StripSpec) -> DecodeOutcome {
        var acc: UInt32 = 0
        var nbits = 0
        var out = [UInt8]()
        out.reserveCapacity(64)
        var needed = 6
        let total = spec.cells * spec.rows
        var i = 0
        while i < total && out.count < needed {
            let c = i % spec.cells
            let r = i / spec.cells
            let fx = (g.x0 + (Double(c) + 0.5) * g.pitch).rounded(.down)
            let fy = (g.y0 + (Double(r) + 0.5) * g.pitch).rounded(.down)
            // The bounds in Double, before Int(): a geometry from outside the search (a caller's hint)
            // may be NaN, infinite or past Int's range, and Int() of one traps. NaN fails every
            // comparison, so it's no strip (code health LS-12, as decoder.c's wc_decode).
            if !(fx >= 0 && fy >= 0 && fx < Double(px.width) && fy < Double(px.height)) {
                return out.count >= 2 ? .rejected(reason: "truncated", geometry: g) : .none
            }
            let x = Int(fx)
            let y = Int(fy)
            acc = (acc << 3) | UInt32(px.cell(x, y))
            nbits += 3
            while nbits >= 8 {
                out.append(UInt8((acc >> UInt32(nbits - 8)) & 0xFF))
                nbits -= 8
                acc &= (UInt32(1) << UInt32(nbits)) - 1
                if out.count == 2 && (out[0] != spec.magic.0 || out[1] != spec.magic.1) {
                    return .none
                }
                if out.count == 6 {
                    let len = Int(out[4]) << 8 | Int(out[5])
                    needed = 8 + len
                    if needed > total * 3 / 8 { return .rejected(reason: "length", geometry: g) }
                }
                if out.count >= needed { break }
            }
            i += 1
        }
        if out.count < needed { return .rejected(reason: "truncated", geometry: g) }
        let len = Int(out[4]) << 8 | Int(out[5])
        var s1 = 0
        var s2 = 0
        for k in 2..<(6 + len) {
            s1 = (s1 + Int(out[k])) % 255
            s2 = (s2 + s1) % 255
        }
        if Int(out[6 + len]) != s1 || Int(out[7 + len]) != s2 {
            return .rejected(reason: "checksum", geometry: g)
        }
        let text = String(decoding: out[6..<(6 + len)], as: UTF8.self)
        return .decoded(id: Int(out[2]) << 8 | Int(out[3]), text: text, bytes: len, geometry: g)
    }

    /// The first cells of any strip, from the magic bytes: 16 bits make five
    /// whole 3-bit cells (the sixth mixes in the id). Consecutive equal cells
    /// merge into one run of that many cells.
    static func magicRuns(_ spec: StripSpec) -> [(value: Int, cells: Int)] {
        let m = (UInt32(spec.magic.0) << 8) | UInt32(spec.magic.1)
        var runs: [(value: Int, cells: Int)] = []
        for k in 0..<5 {
            let v = Int((m >> UInt32(13 - 3 * k)) & 7)
            if let last = runs.last, last.value == v {
                runs[runs.count - 1].cells += 1
            } else {
                runs.append((v, 1))
            }
        }
        return runs
    }

    /// Candidate geometries: rows near the top whose leftmost pixels start with
    /// the magic's color runs. The pitch comes from where the runs change.
    public static func estimate(_ px: PixelBuffer, _ spec: StripSpec, maxCandidates: Int = 4) -> [Geometry] {
        candidates(px, spec, maxCandidates: maxCandidates).found
    }

    /// The candidates, and the first magic whose cells are too small to decode
    /// (tooSmall): a stream at a lower scale than the window's display.
    static func candidates(_ px: PixelBuffer, _ spec: StripSpec, maxCandidates: Int = 4) -> (found: [Geometry], tooSmall: Geometry?) {
        let want = magicRuns(spec)
        guard want.count >= 2 else { return ([], nil) }
        var found: [Geometry] = []
        var tooSmall: Geometry? = nil
        let maxY = min(spec.searchRows, px.height)
        let maxX = min(spec.searchCols, px.width)
        var y = 0
        while y < maxY && found.count < maxCandidates {
            defer { y += 1 }
            var x = 0
            while x < maxX && px.cell(x, y) != want[0].value { x += 1 }
            if x >= maxX { continue }
            // Run lengths along the row, ignoring 1-pixel blips (blended edges).
            // Scan a fixed span (six cells at the largest pitch) rather than a
            // run count: blips are runs too, and counting them would cut the
            // last magic run short.
            let limit = min(px.width, x + Int(spec.maxPitch * 6) + 4)
            var runs: [(value: Int, start: Int, len: Int)] = []
            var cur = px.cell(x, y)
            var start = x
            var xx = x + 1
            while xx < limit {
                let v = px.cell(xx, y)
                if v != cur {
                    runs.append((cur, start, xx - start))
                    cur = v
                    start = xx
                }
                xx += 1
            }
            runs.append((cur, start, xx - start))
            var merged: [(value: Int, start: Int, len: Int)] = []
            for r in runs {
                if r.len <= 1, !merged.isEmpty { merged[merged.count - 1].len += r.len; continue }
                if let last = merged.last, last.value == r.value {
                    merged[merged.count - 1].len += r.len
                } else {
                    merged.append(r)
                }
            }
            guard merged.count >= want.count else { continue }
            var ok = true
            for k in 0..<want.count where merged[k].value != want[k].value { ok = false; break }
            if !ok { continue }
            // Pitch from the start of the last magic run.
            let cellsBefore = want.dropLast().reduce(0) { $0 + $1.cells }
            let p = Double(merged[want.count - 1].start - merged[0].start) / Double(cellsBefore)
            if p > spec.maxPitch || p < 1.5 { continue }
            var runsOk = true
            for k in 0..<(want.count - 1) {
                let expect = p * Double(want[k].cells)
                if Double(merged[k].len) < expect * 0.5 || Double(merged[k].len) > expect * 1.6 { runsOk = false; break }
            }
            if !runsOk { continue }
            let g = Geometry(x0: Double(merged[0].start), y0: Double(y), pitch: p)
            if p < spec.minPitch {
                if tooSmall == nil { tooSmall = g }
                continue
            }
            if !found.contains(where: { abs($0.x0 - g.x0) < 1 && abs($0.pitch - g.pitch) < 0.3 && abs($0.y0 - g.y0) < p }) {
                found.append(g)
            }
        }
        return (found, tooSmall)
    }

    /// Sharpen x0 and the pitch with a least-squares fit of the color changes
    /// along the first cell row: a change sits on a cell boundary x0 + k * pitch.
    /// Starts near the magic and widens, so a rough pitch can't misnumber the
    /// far boundaries.
    public static func refine(_ px: PixelBuffer, _ g0: Geometry, _ spec: StripSpec) -> Geometry {
        var g = g0
        // The search's own geometries are finite; one that isn't is kept as it is (LS-12, as wc_refine).
        guard g.x0.isFinite, g.y0.isFinite, g.pitch.isFinite else { return g }
        let y = Int(g.y0 + 0.5 * g.pitch)
        guard y >= 0, y < px.height else { return g }
        for maxCells in [12, 32, 80, spec.cells] {
            let xEnd = min(px.width, Int(g.x0 + Double(maxCells) * g.pitch))
            var n = 0.0, sk = 0.0, st = 0.0, skk = 0.0, skt = 0.0
            var prev = px.cell(max(0, Int(g.x0)), y)
            var lastK = -1.0
            var x = max(0, Int(g.x0)) + 1
            while x < xEnd {
                let v = px.cell(x, y)
                if v != prev {
                    let kf = (Double(x) - g.x0) / g.pitch
                    let k = kf.rounded()
                    if k >= 1, abs(kf - k) < 0.35, k != lastK {
                        n += 1; sk += k; st += Double(x); skk += k * k; skt += k * Double(x)
                        lastK = k
                    }
                    prev = v
                }
                x += 1
            }
            if n >= 3 {
                let den = n * skk - sk * sk
                if den > 0 {
                    let p = (n * skt - sk * st) / den
                    let x0 = (st - p * sk) / n
                    if p > spec.minPitch, p < spec.maxPitch, abs(p - g.pitch) < g.pitch * 0.2 {
                        g.pitch = p
                        g.x0 = x0
                    }
                }
            }
        }
        return g
    }

    /// Find and decode the strip. `hint` is the last geometry that worked.
    public static func findAndDecode(_ px: PixelBuffer, _ spec: StripSpec, hint: Geometry?) -> DecodeOutcome {
        var rejected: DecodeOutcome? = nil
        if let h = hint {
            let r = decode(px, h, spec)
            if case .decoded = r { return r }
            if case .rejected = r { rejected = r }
        }
        let (ests, tooSmall) = candidates(px, spec)
        for est in ests {
            let refined = refine(px, est, spec)
            // The fit first, then one-axis nudges around it, then the raw estimate:
            // at most 13 decodes per candidate, so a damaged strip can't eat the CPU.
            var tries: [Geometry] = [refined]
            for dp in [0.005, -0.005, 0.01, -0.01, 0.02, -0.02] {
                tries.append(Geometry(x0: refined.x0, y0: refined.y0, pitch: refined.pitch + dp))
            }
            for dy in [1.0, -1.0, 2.0] {
                tries.append(Geometry(x0: refined.x0, y0: refined.y0 + dy, pitch: refined.pitch))
            }
            for dx in [0.5, -0.5] {
                tries.append(Geometry(x0: refined.x0 + dx, y0: refined.y0, pitch: refined.pitch))
            }
            tries.append(est)
            for g in tries {
                let r = decode(px, g, spec)
                switch r {
                case .decoded: return r
                case .rejected: if rejected == nil { rejected = r }
                case .none: break
                }
            }
        }
        if let r = rejected { return r }
        // Cells under minPitch aren't decoded, but a strip whose magic reads at
        // that pitch is named, not taken for no strip (2026-09-27: a 1x stream
        // of a Retina window saw 2 px cells for six minutes as "none").
        if let g = tooSmall {
            switch decode(px, g, spec) {
            case .none: break
            case .rejected, .decoded: return .rejected(reason: "pitch_too_small", geometry: g)
            }
        }
        return .none
    }
}
