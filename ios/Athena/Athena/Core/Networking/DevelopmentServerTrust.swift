import Foundation
import Security

#if DEBUG
final class DevelopmentServerTrustDelegate: NSObject, URLSessionDelegate {
    private let anchorCertificate: SecCertificate
    private let allowedHost: String

    init?(baseURL: URL, bundle: Bundle = .main) {
        guard
            let host = baseURL.host,
            Self.isLocalDevelopmentHost(host),
            let certificateURL = bundle.url(
                forResource: "AthenaDevCA",
                withExtension: "crt"
            ),
            let certificatePEM = try? String(
                contentsOf: certificateURL,
                encoding: .utf8
            ),
            let certificateData = Self.derData(fromPEM: certificatePEM),
            let certificate = SecCertificateCreateWithData(
                nil,
                certificateData as CFData
            )
        else {
            return nil
        }
        anchorCertificate = certificate
        allowedHost = host
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (
            URLSession.AuthChallengeDisposition,
            URLCredential?
        ) -> Void
    ) {
        guard
            challenge.protectionSpace.authenticationMethod ==
                NSURLAuthenticationMethodServerTrust,
            challenge.protectionSpace.host == allowedHost,
            let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        SecTrustSetAnchorCertificates(
            serverTrust,
            [anchorCertificate] as CFArray
        )
        SecTrustSetAnchorCertificatesOnly(serverTrust, true)

        var trustError: CFError?
        guard SecTrustEvaluateWithError(serverTrust, &trustError) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(
            .useCredential,
            URLCredential(trust: serverTrust)
        )
    }

    static func session(for baseURL: URL) -> URLSession? {
        guard let delegate = DevelopmentServerTrustDelegate(baseURL: baseURL)
        else {
            return nil
        }
        return URLSession(
            configuration: .default,
            delegate: delegate,
            delegateQueue: nil
        )
    }

    private static func isLocalDevelopmentHost(_ host: String) -> Bool {
        if host == "localhost" || host == "127.0.0.1" || host == "::1" {
            return true
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0 ... 255).contains($0) })
        else {
            return host.hasSuffix(".local")
        }
        return octets[0] == 10 ||
            (octets[0] == 172 && (16 ... 31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168)
    }

    private static func derData(fromPEM pem: String) -> Data? {
        let payload = pem
            .replacingOccurrences(
                of: "-----BEGIN CERTIFICATE-----",
                with: ""
            )
            .replacingOccurrences(
                of: "-----END CERTIFICATE-----",
                with: ""
            )
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()
        return Data(base64Encoded: payload)
    }
}
#endif
