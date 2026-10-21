// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QuickShot",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "QuickShot", targets: ["QuickShot"])],
    targets: [
        .executableTarget(name: "QuickShot"),
        .testTarget(name: "QuickShotTests", dependencies: ["QuickShot"]),
    ],
    swiftLanguageModes: [.v5]
)
