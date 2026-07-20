import Foundation

actor CacheCodec {
    func encode<Value: Encodable & Sendable>(_ value: Value) throws -> Data {
        try JSONEncoder().encode(value)
    }

    func decode<Value: Decodable & Sendable>(
        _ type: Value.Type,
        from data: Data
    ) throws -> Value {
        try JSONDecoder().decode(type, from: data)
    }
}
