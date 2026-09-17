import CommonCrypto
import Foundation
import SQLite3

// Talking to Slack as you — the Swift twin of ~/.local/share/slack-api/index.ts,
// the module `sn` and `stacks` use; that file tells the full story. The short
// version: there is no bot token. This reuses the session the Slack desktop app
// already holds, so a reply arrives as you.
//
//   cookie  `d=xoxd-…`, AES-128-CBC in Slack's Chromium cookie jar, keyed by the
//           Keychain item "Slack Safe Storage".
//   token   `xoxc-…`, scanned out of Slack's Local Storage leveldb. The one that
//           works is cached in the Keychain as "sn-slack-token" — the same item
//           `sn` keeps, so both tools share one validated token, and
//           `sn auth --token xoxc-…` fixes both when Slack rotates it away.

struct SlackError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

struct SlackCreds {
  let token: String
  let cookie: String  // already URL-encoded, as Slack stores it — do not re-encode
}

/// Where a reply lands. `threadTs` set puts it in that thread (opening one when
/// it is the message's own ts); nil posts to the channel.
struct ReplyTarget {
  let channel: String
  let ts: String
  let threadTs: String?
}

actor Slack {
  static let shared = Slack()

  private static let appDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Slack")
  private static let cookieDB = appDir.appendingPathComponent("Cookies")
  private static let leveldb = appDir.appendingPathComponent("Local Storage/leveldb")
  private static let keychainService = "sn-slack-token"
  private static let rejected: Set<String> = [
    "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive",
  ]

  private static let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.httpShouldSetCookies = false  // the session cookie goes in by hand; keep the jar out of it
    c.httpCookieAcceptPolicy = .never
    c.timeoutIntervalForRequest = 20
    return URLSession(configuration: c)
  }()

  private var cached: SlackCreds?
  private var resolving: Task<SlackCreds, Error>?

  /// Resolve credentials once; concurrent callers share the one lookup.
  func creds() async throws -> SlackCreds {
    if let cached { return cached }
    if let resolving { return try await resolving.value }
    let task = Task<SlackCreds, Error> {
      let cookie = try await Self.readCookie()
      let token = try await Self.resolveToken(cookie: cookie)
      return SlackCreds(token: token, cookie: cookie)
    }
    resolving = task
    defer { resolving = nil }
    let c = try await task.value
    cached = c
    return c
  }

  func reply(_ target: ReplyTarget, text: String) async throws {
    var form = ["channel": target.channel, "text": text]
    if let t = target.threadTs { form["thread_ts"] = t }
    let r = try await call("chat.postMessage", form)
    guard r["ok"] as? Bool == true else {
      throw SlackError((r["error"] as? String) ?? "chat.postMessage failed")
    }
  }

  /// Post a top-level message to a channel or DM.
  func post(_ channel: String, text: String) async throws {
    let r = try await call("chat.postMessage", ["channel": channel, "text": text])
    guard r["ok"] as? Bool == true else {
      throw SlackError((r["error"] as? String) ?? "chat.postMessage failed")
    }
  }

  // MARK: - Name → id
  //
  // Enterprise Grid refuses the obvious listing calls to a client token
  // (conversations.list, users.conversations); the two channel calls below are
  // what the desktop client itself uses. Both are slow enough that the inbox
  // offers the feed's own conversations first and only comes here for a name
  // it has never seen.

  /// Channel id for `#name`, over the channels you are a member of.
  func channelId(named name: String) async throws -> String {
    let want = (name.hasPrefix("#") ? String(name.dropFirst()) : name).lowercased()
    let counts = try await call("client.counts", [:])
    guard counts["ok"] as? Bool == true else {
      throw SlackError("client.counts — \(counts["error"] ?? "failed")")
    }
    let ids = ((counts["channels"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
    guard !ids.isEmpty else { throw SlackError("you are not in any channels") }
    // genericInfo takes the "changed since" map the client syncs with; from 0 it describes them all.
    let updated = Dictionary(uniqueKeysWithValues: ids.map { ($0, 0) })
    let json = String(decoding: try JSONSerialization.data(withJSONObject: updated), as: UTF8.self)
    let info = try await call("conversations.genericInfo", ["updated_channels": json])
    guard info["ok"] as? Bool == true else {
      throw SlackError("conversations.genericInfo — \(info["error"] ?? "failed")")
    }
    for c in (info["channels"] as? [[String: Any]]) ?? []
    where (c["name"] as? String)?.lowercased() == want {
      if let id = c["id"] as? String { return id }
    }
    throw SlackError("no channel named #\(want) that you are a member of")
  }

  /// User id for a handle or display name. An exact handle is unambiguous;
  /// a display name shared by two accounts is an error naming both.
  func userId(named name: String) async throws -> String {
    let want = name.trimmingCharacters(in: .whitespaces).lowercased()
      .replacingOccurrences(of: "@", with: "")
    var hits: [(id: String, handle: String)] = []
    var cursor = ""
    for _ in 0..<20 {
      var form = ["limit": "1000"]
      if !cursor.isEmpty { form["cursor"] = cursor }
      let r = try await call("users.list", form)
      guard r["ok"] as? Bool == true else {
        throw SlackError("users.list — \(r["error"] ?? "failed")")
      }
      for u in (r["members"] as? [[String: Any]]) ?? [] {
        if u["deleted"] as? Bool == true { continue }
        guard let id = u["id"] as? String else { continue }
        let handle = (u["name"] as? String) ?? id
        if handle.lowercased() == want { return id }
        let profile = u["profile"] as? [String: Any]
        let names = [
          u["real_name"] as? String, profile?["display_name"] as? String,
          profile?["real_name"] as? String,
        ]
        if names.contains(where: { $0?.trimmingCharacters(in: .whitespaces).lowercased() == want }) {
          hits.append((id, handle))
        }
      }
      cursor = ((r["response_metadata"] as? [String: Any])?["next_cursor"] as? String) ?? ""
      if cursor.isEmpty { break }
    }
    if hits.count == 1 { return hits[0].id }
    if hits.count > 1 {
      let list = hits.map { $0.handle }.joined(separator: ", ")
      throw SlackError("\"\(name)\" matches \(hits.count) accounts (\(list)) — use a handle")
    }
    throw SlackError("no Slack user named \"\(name)\"")
  }

  /// The DM channel with a user, opened if there is none yet.
  func dmChannel(with user: String) async throws -> String {
    let r = try await call("conversations.open", ["users": user])
    guard r["ok"] as? Bool == true, let id = (r["channel"] as? [String: Any])?["id"] as? String
    else { throw SlackError((r["error"] as? String) ?? "conversations.open failed") }
    return id
  }

  /// Somewhere to post, from what was typed: `#name` is a channel; anything
  /// else is a person first, then a channel.
  func resolveRecipient(_ query: String) async throws -> (id: String, name: String) {
    let q = query.trimmingCharacters(in: .whitespaces)
    if q.hasPrefix("#") { return (try await channelId(named: q), q) }
    if let user = try? await userId(named: q) { return (try await dmChannel(with: user), q) }
    return (try await channelId(named: q), "#\(q)")
  }

  /// React to the message with `name` (no colons).
  func react(_ target: ReplyTarget, name: String) async throws {
    let r = try await call(
      "reactions.add", ["channel": target.channel, "timestamp": target.ts, "name": name])
    guard r["ok"] as? Bool == true else {
      throw SlackError((r["error"] as? String) ?? "reactions.add failed")
    }
  }

  private var emojiNamesCache: [String]?

  /// The workspace's custom emoji names and aliases, fetched once.
  func emojiNames() async throws -> [String] {
    if let emojiNamesCache { return emojiNamesCache }
    let r = try await call("emoji.list", [:])
    guard r["ok"] as? Bool == true, let emoji = r["emoji"] as? [String: Any] else {
      throw SlackError((r["error"] as? String) ?? "emoji.list failed")
    }
    let names = emoji.keys.sorted()
    emojiNamesCache = names
    return names
  }

  /// Who the session belongs to — `snpet --check-auth`.
  func whoAmI() async throws -> String {
    let r = try await call("auth.test", [:])
    guard r["ok"] as? Bool == true else {
      throw SlackError((r["error"] as? String) ?? "auth.test failed")
    }
    return "\(r["user"] ?? "?") in \(r["team"] ?? "?") · \(r["url"] ?? "")"
  }

  /// One API call with the session. A token Slack rejects drops the cache and
  /// the call runs once more with a freshly resolved one.
  private func call(_ method: String, _ form: [String: String]) async throws -> [String: Any] {
    let first = try await Self.call(method, creds: creds(), form: form)
    guard first["ok"] as? Bool != true, let e = first["error"] as? String, Self.rejected.contains(e)
    else { return first }
    cached = nil
    return try await Self.call(method, creds: creds(), form: form)
  }

  // MARK: - Cookie

  private static func readCookie() async throws -> String {
    guard let key = await keychain("Slack Safe Storage") else {
      throw SlackError("no \"Slack Safe Storage\" key in the Keychain — is Slack installed?")
    }
    let blob = try encryptedCookie()
    guard blob.count > 3 + kCCBlockSizeAES128 else {
      throw SlackError("Slack's `d` cookie is too short to be encrypted")
    }

    // Chromium's v10 scheme: PBKDF2-SHA1 over the Safe Storage key with a fixed
    // salt and round count; AES-128-CBC with an all-spaces IV.
    var derived = [UInt8](repeating: 0, count: kCCKeySizeAES128)
    let salt = Array("saltysalt".utf8)
    let kdf = CCKeyDerivationPBKDF(
      CCPBKDFAlgorithm(kCCPBKDF2), key, key.utf8.count, salt, salt.count,
      CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, &derived, derived.count)
    guard kdf == kCCSuccess else { throw SlackError("deriving the cookie key failed (\(kdf))") }

    let cipher = Array(blob.dropFirst(3))  // strip the "v10" version prefix
    guard cipher.count % kCCBlockSizeAES128 == 0 else {
      throw SlackError("cookie blob is not block-aligned")
    }
    let iv = [UInt8](repeating: 0x20, count: kCCBlockSizeAES128)
    var plain = [UInt8](repeating: 0, count: cipher.count)
    var moved = 0
    // No padding option: recent Chromium prepends a domain hash, so unpad by hand.
    let status = CCCrypt(
      CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(0),
      derived, derived.count, iv, cipher, cipher.count, &plain, plain.count, &moved)
    guard status == kCCSuccess else {
      throw SlackError("decrypting the cookie failed (\(status))")
    }
    plain.removeSubrange(moved...)

    guard let start = index(of: Array("xoxd-".utf8), in: plain) else {
      throw SlackError("decrypted the cookie but found no xoxd- value in it")
    }
    var value = Array(plain[start...])
    while let last = value.last, last < 0x20 || last == 0x7F { value.removeLast() }  // PKCS#7 bytes
    guard let cookie = String(bytes: value, encoding: .utf8), !cookie.isEmpty else {
      throw SlackError("the cookie value is not text")
    }
    return cookie
  }

  private static func index(of needle: [UInt8], in hay: [UInt8]) -> Int? {
    guard !needle.isEmpty, hay.count >= needle.count else { return nil }
    for i in 0...(hay.count - needle.count) where hay[i] == needle[0] {
      if Array(hay[i..<(i + needle.count)]) == needle { return i }
    }
    return nil
  }

  private struct DBBusy: Error {}

  /// The encrypted `d` cookie for .slack.com. Slack keeps the jar open; a
  /// read-only open normally gets a consistent snapshot, and when the lock says
  /// otherwise a copy of the file is read instead.
  private static func encryptedCookie() throws -> [UInt8] {
    do {
      return try queryCookie(at: cookieDB.path)
    } catch is DBBusy {
      let copy = FileManager.default.temporaryDirectory
        .appendingPathComponent("snpet-cookies-\(getpid()).sqlite")
      try? FileManager.default.removeItem(at: copy)
      try FileManager.default.copyItem(at: cookieDB, to: copy)
      defer { try? FileManager.default.removeItem(at: copy) }
      do {
        return try queryCookie(at: copy.path)
      } catch is DBBusy {
        throw SlackError("Slack's cookie jar is locked — try again in a moment")
      }
    }
  }

  private static func queryCookie(at path: String) throws -> [UInt8] {
    var db: OpaquePointer?
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
      let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
      if let db { sqlite3_close(db) }
      throw SlackError("cannot open Slack's cookie jar — \(message)")
    }
    defer { sqlite3_close(db) }
    sqlite3_busy_timeout(db, 1500)

    let sql = "select encrypted_value from cookies where name = 'd' and host_key = '.slack.com'"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      let rc = sqlite3_errcode(db)
      if rc == SQLITE_BUSY || rc == SQLITE_LOCKED { throw DBBusy() }
      throw SlackError("cannot read Slack's cookie jar — \(String(cString: sqlite3_errmsg(db)))")
    }
    defer { sqlite3_finalize(stmt) }

    switch sqlite3_step(stmt) {
    case SQLITE_ROW:
      guard let p = sqlite3_column_blob(stmt, 0) else {
        throw SlackError("Slack's `d` cookie is empty")
      }
      let n = Int(sqlite3_column_bytes(stmt, 0))
      return Array(UnsafeBufferPointer(start: p.assumingMemoryBound(to: UInt8.self), count: n))
    case SQLITE_DONE:
      throw SlackError("no Slack `d` cookie — sign in to the Slack app first")
    case SQLITE_BUSY, SQLITE_LOCKED:
      throw DBBusy()
    default:
      throw SlackError("cannot read Slack's cookie jar — \(String(cString: sqlite3_errmsg(db)))")
    }
  }

  // MARK: - Token

  /// Every xoxc-looking string in Slack's Local Storage.
  private static func scanTokens() async -> [String] {
    let (_, text) = await run("/bin/sh", ["-c", "strings -a \"$0\"/* 2>/dev/null", leveldb.path])
    // A real token is xoxc-<team>-<user>-<session>-<64 hex>; the length floor drops
    // the bare "xoxc-" fragments left behind by snappy back-references.
    let re = try! NSRegularExpression(pattern: "xoxc-[0-9A-Za-z-]{40,}")
    var seen = Set<String>()
    var tokens: [String] = []
    for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
      guard let r = Range(m.range, in: text) else { continue }
      let t = String(text[r])
      if seen.insert(t).inserted { tokens.append(t) }
    }
    return tokens
  }

  private static func validate(_ token: String, cookie: String) async -> Bool {
    let r = try? await call("auth.test", creds: SlackCreds(token: token, cookie: cookie), form: [:])
    return r?["ok"] as? Bool == true
  }

  /// A token Slack currently accepts: the cached one if it still works, else the
  /// first scanned candidate that does (which then replaces the cache).
  private static func resolveToken(cookie: String) async throws -> String {
    let cached = await keychain(keychainService)
    if let cached, await validate(cached, cookie: cookie) { return cached }
    for token in await scanTokens() where token != cached {  // the cache is known bad by now
      if await validate(token, cookie: cookie) {
        await keychainStore(keychainService, token)
        return token
      }
    }
    throw SlackError(
      "no working Slack token found — open Slack to refresh it, or run `sn auth --token xoxc-…`")
  }

  // MARK: - API

  private static func call(_ method: String, creds: SlackCreds, form: [String: String])
    async throws -> [String: Any]
  {
    var req = URLRequest(url: URL(string: "https://slack.com/api/\(method)")!)
    req.httpMethod = "POST"
    req.setValue(
      "application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
    req.setValue("d=\(creds.cookie)", forHTTPHeaderField: "Cookie")
    var fields = form
    fields["token"] = creds.token
    req.httpBody = Data(formEncoded(fields).utf8)
    let (data, _) = try await session.data(for: req)
    guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw SlackError("\(method) returned something that is not JSON")
    }
    return obj
  }

  private static func formEncoded(_ fields: [String: String]) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return fields.map { k, v in "\(k)=\(v.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
      .joined(separator: "&")
  }

  // MARK: - Keychain, processes

  private static func keychain(_ service: String) async -> String? {
    let (rc, out) = await run("/usr/bin/security", ["find-generic-password", "-s", service, "-w"])
    let value = out.trimmingCharacters(in: .whitespacesAndNewlines)
    return rc == 0 && !value.isEmpty ? value : nil
  }

  private static func keychainStore(_ service: String, _ value: String) async {
    // -U updates in place when the item already exists.
    _ = await run(
      "/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", "sn", "-w", value])
  }

  /// Run a command to completion — off the cooperative pool, since it blocks.
  private static func run(_ path: String, _ args: [String]) async -> (Int32, String) {
    await Task.detached { () -> (Int32, String) in
      let p = Process()
      p.executableURL = URL(fileURLWithPath: path)
      p.arguments = args
      let out = Pipe()
      p.standardOutput = out
      p.standardError = FileHandle.nullDevice
      do { try p.run() } catch { return (-1, "") }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      p.waitUntilExit()
      return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }.value
  }
}
