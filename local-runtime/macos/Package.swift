// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "AthenaRuntime",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "AthenaRuntime", targets: ["AthenaRuntime"])],
  targets: [
    .executableTarget(
      name: "AthenaRuntime",
      path: "Sources/AthenaRuntime",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("Carbon"),
        .linkedFramework("CoreGraphics"),
        .linkedFramework("CryptoKit"),
        .linkedFramework("ScreenCaptureKit"),
        .linkedFramework("Security"),
        .linkedFramework("ServiceManagement")
      ]
    ),
    .testTarget(name: "AthenaRuntimeTests", dependencies: ["AthenaRuntime"])
  ]
)
