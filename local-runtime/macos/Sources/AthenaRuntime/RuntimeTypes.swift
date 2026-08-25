import Foundation

let localRuntimeProtocol = "athena.local-runtime.v1"

struct RuntimeConfiguration: Codable {
  var serverURL: URL
  var pairingToken: String?
  var deviceId: String?
  var serverSigningPublicKey: String?
  var allowedRoots: [String]
  var allowedApps: [String]
  var paused: Bool
}

struct RuntimeEnvelope: Codable {
  var type: String
  var protocolVersion: String? = nil
  var deviceId: String? = nil
  var connectionId: String? = nil
  var timestamp: Int64? = nil
  var nonce: String? = nil
  var signature: String? = nil
  var pairingToken: String? = nil
  var device: DeviceDescriptor? = nil
  var version: String? = nil
  var paused: Bool? = nil
  var capabilities: [String: Bool]? = nil
  var permissions: [String: Bool]? = nil
  var jobId: String? = nil
  var attempt: Int? = nil
  var deadline: String? = nil
  var capability: String? = nil
  var argumentHash: String? = nil
  var args: JSONValue? = nil
  var assertion: CapabilityAssertion? = nil
  var eventType: String? = nil
  var payload: JSONValue? = nil
  var result: JSONValue? = nil
  var resultHash: String? = nil
  var reasonCode: String? = nil
  var frame: ScreenshotFrame? = nil
  var serverSigningPublicKey: String? = nil

  enum CodingKeys: String, CodingKey {
    case type, deviceId, connectionId, timestamp, nonce, signature, pairingToken
    case device, version, paused, capabilities, permissions
    case jobId, attempt, deadline, capability, argumentHash, args
    case assertion, eventType, payload, result, resultHash, reasonCode, frame
    case serverSigningPublicKey
    case protocolVersion = "protocol"
  }
}

struct DeviceDescriptor: Codable {
  var name: String
  var platform: String
  var version: String
  var publicKeyPem: String
  var keyAlgorithm: String
  var capabilities: [String: Bool]
  var permissions: [String: Bool]
}

struct CapabilityAssertion: Codable {
  var algorithm: String
  var keyId: String
  var payload: JSONValue
  var signature: String
}

struct ScreenshotFrame: Codable {
  var mimeType: String
  var data: String
  var capturedAt: String
}

enum JSONValue: Codable {
  case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

  init(from decoder: Decoder) throws {
    let box = try decoder.singleValueContainer()
    if box.decodeNil() { self = .null }
    else if let value = try? box.decode(Bool.self) { self = .bool(value) }
    else if let value = try? box.decode(Double.self) { self = .number(value) }
    else if let value = try? box.decode(String.self) { self = .string(value) }
    else if let value = try? box.decode([String: JSONValue].self) { self = .object(value) }
    else { self = .array(try box.decode([JSONValue].self)) }
  }

  func encode(to encoder: Encoder) throws {
    var box = encoder.singleValueContainer()
    switch self {
    case .string(let value): try box.encode(value)
    case .number(let value): try box.encode(value)
    case .bool(let value): try box.encode(value)
    case .object(let value): try box.encode(value)
    case .array(let value): try box.encode(value)
    case .null: try box.encodeNil()
    }
  }

  var object: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
  var string: String? { if case .string(let value) = self { return value }; return nil }
  var number: Double? { if case .number(let value) = self { return value }; return nil }
  var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
}

extension JSONValue {
  static func from(_ value: Any) throws -> JSONValue {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }

  func canonicalData() throws -> Data {
    let encoded = try JSONEncoder().encode(self)
    let object = try JSONSerialization.jsonObject(with: encoded)
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
  }
}
