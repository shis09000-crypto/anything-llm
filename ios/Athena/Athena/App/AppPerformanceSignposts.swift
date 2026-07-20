import OSLog

enum AppPerformanceSignposts {
    private static let signposter = OSSignposter(
        subsystem: "com.athena.native",
        category: "Startup"
    )

    static func event(_ name: StaticString) {
        signposter.emitEvent(name)
    }
}
