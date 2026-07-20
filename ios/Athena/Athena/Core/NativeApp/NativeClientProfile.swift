import Foundation
import UIKit

struct NativeClientProfile: Equatable {
    let appVersion: String
    let osVersion: String
    let platform: String

    static func current(
        bundle: Bundle = .main,
        device: UIDevice = .current
    ) -> NativeClientProfile {
        NativeClientProfile(
            appVersion: appVersion(from: bundle),
            osVersion: device.systemVersion,
            platform: device.userInterfaceIdiom == .pad ? "ipad" : "ios"
        )
    }

    private static func appVersion(from bundle: Bundle) -> String {
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (version?.isEmpty == false ? version : nil, build?.isEmpty == false ? build : nil) {
        case let (.some(version), _):
            return version
        case let (.none, .some(build)):
            return build
        case (.none, .none):
            return "0.1.0"
        }
    }
}
