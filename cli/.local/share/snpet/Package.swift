// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "snpet",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "snpet",
      path: "Sources/snpet",
      linkerSettings: [
        .linkedLibrary("sqlite3"),
        .linkedFramework("Carbon"),
      ]
    ),
  ]
)
