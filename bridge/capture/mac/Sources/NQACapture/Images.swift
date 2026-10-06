import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import StripDecoder
import UniformTypeIdentifiers

/// An owned sRGB BGRA bitmap, for --test-image and --probe.
final class Bitmap {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let data: UnsafeMutablePointer<UInt8>

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        self.bytesPerRow = width * 4
        self.data = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height * 4)
        self.data.initialize(repeating: 0, count: width * height * 4)
    }

    deinit { data.deallocate() }

    var pixels: PixelBuffer {
        PixelBuffer(width: width, height: height, bytesPerRow: bytesPerRow, base: UnsafePointer(data), bgra: true)
    }

    private static let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    /// Load a PNG and draw it into sRGB BGRA (a PNG without a profile is sRGB already).
    static func load(path: String) -> Bitmap? {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
              let space = CGColorSpace(name: CGColorSpace.sRGB)
        else { return nil }
        let bmp = Bitmap(width: img.width, height: img.height)
        guard let ctx = CGContext(data: bmp.data, width: bmp.width, height: bmp.height, bitsPerComponent: 8,
                                  bytesPerRow: bmp.bytesPerRow, space: space, bitmapInfo: bitmapInfo)
        else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: bmp.width, height: bmp.height))
        return bmp
    }

    /// Copy a captured 32BGRA pixel buffer.
    static func copy(from pb: CVPixelBuffer) -> Bitmap? {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        let bmp = Bitmap(width: w, height: h)
        for y in 0..<h {
            memcpy(bmp.data + y * bmp.bytesPerRow, base + y * bpr, w * 4)
        }
        return bmp
    }

    func writePNG(path: String) -> Bool {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: data, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: bytesPerRow, space: space, bitmapInfo: Bitmap.bitmapInfo),
              let img = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                         UTType.png.identifier as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(dest, img, nil)
        return CGImageDestinationFinalize(dest)
    }
}

/// Decode a PNG once: the tests' entry point. Uses no capture API, so it never
/// touches Screen Recording permission.
func runTestImage(_ path: String, _ opts: Options, _ out: Emitter) {
    guard let bmp = Bitmap.load(path: path) else {
        out.error("cannot read image \(path)")
        return
    }
    switch StripDecoder.findAndDecode(bmp.pixels, opts.spec, hint: opts.hint) {
    case .decoded(let id, let text, let bytes, let g):
        out.emit(["id": id, "text": text, "bytes": bytes, "geometry": ["x0": g.x0, "y0": g.y0, "pitch": g.pitch]])
    case .rejected(let reason, let g):
        out.emit(["error": "strip seen but rejected: \(reason)", "geometry": ["x0": g.x0, "y0": g.y0, "pitch": g.pitch]])
    case .none:
        out.error("no valid strip in image")
    }
}
