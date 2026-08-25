import Foundation

struct CachedJobCompletion: Codable {
  let result: JSONValue
  let completedAt: Date
}

enum JobCompletionStore {
  private static let ttl: TimeInterval = 24 * 60 * 60

  private static var url: URL {
    ConfigurationStore.url.deletingLastPathComponent()
      .appendingPathComponent("completed-jobs.json")
  }

  static func result(for jobId: String) -> JSONValue? {
    let records = load()
    guard let record = records[jobId], Date().timeIntervalSince(record.completedAt) <= ttl else {
      return nil
    }
    return record.result
  }

  static func save(jobId: String, result: JSONValue) {
    var records = load().filter { Date().timeIntervalSince($0.value.completedAt) <= ttl }
    records[jobId] = CachedJobCompletion(result: result, completedAt: Date())
    guard let data = try? JSONEncoder().encode(records) else { return }
    try? data.write(to: url, options: [.atomic, .completeFileProtection])
  }

  private static func load() -> [String: CachedJobCompletion] {
    guard let data = try? Data(contentsOf: url),
          let value = try? JSONDecoder().decode([String: CachedJobCompletion].self, from: data) else {
      return [:]
    }
    return value
  }
}
