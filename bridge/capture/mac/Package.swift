// swift-tools-version: 6.0
// NeverQuestAlone Capture: the macOS ScreenCaptureKit helper (PRD §9.10).
// `swift build -c release` produces the binary; build-app.sh wraps it in
// "NeverQuestAlone Capture.app" and signs it with the stable local identity so the
// Screen Recording grant belongs to the app and survives rebuilds.
import PackageDescription

let package = Package(
    name: "NQACapture",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure strip decoding, no capture APIs: shared by the app and --test-image.
        .target(name: "StripDecoder", path: "Sources/StripDecoder"),
        .executableTarget(
            name: "NQACapture",
            dependencies: ["StripDecoder"],
            path: "Sources/NQACapture",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("ImageIO"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
