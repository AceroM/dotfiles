// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MemoryGuard",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MemoryGuard"),
        .testTarget(name: "MemoryGuardTests", dependencies: ["MemoryGuard"]),
    ]
)
