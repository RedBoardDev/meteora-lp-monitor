// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MeteoraLPMonitorKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MeteoraLPMonitorKit", targets: ["MeteoraLPMonitorKit"]),
    ],
    targets: [
        .target(name: "MeteoraLPMonitorKit"),
        .testTarget(name: "MeteoraLPMonitorKitTests", dependencies: ["MeteoraLPMonitorKit"]),
    ],
)
