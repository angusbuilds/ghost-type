// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "GhostType",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "GhostType", path: "Sources/GhostType")
    ]
)
