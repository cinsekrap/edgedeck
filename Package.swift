// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "EdgeDeck",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "EdgeDeck",
            path: "Sources/EdgeDeck",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("IOKit"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("EventKit"),
            ]
        )
    ]
)
