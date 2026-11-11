// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QuickRecord",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "QuickRecord", targets: ["QuickRecord"]),
        .executable(name: "QuickRecordHAR", targets: ["QuickRecordHAR"]),
    ],
    targets: [
        .executableTarget(name: "QuickRecord"),
        // Chrome's native messaging host for the Quick Record HAR extension (chrome-extension/).
        .executableTarget(name: "QuickRecordHAR"),
        .testTarget(name: "QuickRecordTests", dependencies: ["QuickRecord"]),
    ],
    swiftLanguageModes: [.v5]
)
