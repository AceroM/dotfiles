// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QuickRecord",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "QuickRecord", targets: ["QuickRecord"])],
    targets: [
        .executableTarget(name: "QuickRecord"),
        .testTarget(name: "QuickRecordTests", dependencies: ["QuickRecord"]),
    ],
    swiftLanguageModes: [.v5]
)
