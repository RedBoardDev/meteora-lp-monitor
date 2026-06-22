// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BinsightKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "BinsightKit", targets: ["BinsightKit"]),
    ],
    targets: [
        .target(name: "BinsightKit"),
        .testTarget(name: "BinsightKitTests", dependencies: ["BinsightKit"]),
    ],
)
