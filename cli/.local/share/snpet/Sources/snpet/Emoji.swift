import Foundation

/// Emoji in the reply box. Slack renders `:name:` in message text itself, so
/// posting a shortcode needs nothing from here; this adds the two things the
/// API does offer — reacting instead of posting, and knowing the names.
enum Emoji {
  /// Slack's own composer convention: a reply that is exactly `+:eyes:` (or
  /// `+eyes`) reacts to the message rather than answering it. The name, if so.
  static func reaction(in text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.hasPrefix("+"), t.count > 1 else { return nil }
    var name = String(t.dropFirst())
    if name.hasPrefix(":"), name.hasSuffix(":"), name.count > 2 {
      name = String(name.dropFirst().dropLast())
    }
    guard !name.isEmpty, name.allSatisfy(isNameCharacter) else { return nil }
    return name
  }

  /// The `:frag` being typed at the end of `text` — a colon after a space (or
  /// the start, or a `+`), then two or more name characters and no closing colon.
  static func typing(in text: String) -> (range: Range<String.Index>, fragment: String)? {
    guard let colon = text.lastIndex(of: ":") else { return nil }
    let frag = text[text.index(after: colon)...]
    guard frag.count >= 2, frag.allSatisfy(isNameCharacter) else { return nil }
    if colon > text.startIndex {
      let before = text[text.index(before: colon)]
      guard before.isWhitespace || before == "+" else { return nil }
    }
    return (colon..<text.endIndex, frag.lowercased())
  }

  /// Names for a fragment: prefix matches first, then anything containing it.
  static func matches(_ fragment: String, custom: [String], limit: Int = 6) -> [String] {
    var out: [String] = []
    let pool = custom + standard
    for name in pool where name.hasPrefix(fragment) && !out.contains(name) {
      out.append(name)
      if out.count >= limit { return out }
    }
    for name in pool where name.contains(fragment) && !out.contains(name) {
      out.append(name)
      if out.count >= limit { break }
    }
    return out
  }

  private static func isNameCharacter(_ c: Character) -> Bool {
    c.isLetter || c.isNumber || c == "_" || c == "-" || c == "+" || c == "'"
  }

  /// Common standard names, by Slack's spelling. The workspace's custom emoji
  /// come from emoji.list at runtime and sit in front of these.
  static let standard: [String] = [
    "+1", "-1", "thumbsup", "thumbsdown", "100", "eyes", "fire", "tada", "rocket", "heart",
    "joy", "sob", "smile", "grin", "wink", "blush", "sweat_smile", "laughing",
    "rolling_on_the_floor_laughing", "thinking_face", "neutral_face", "expressionless",
    "unamused", "face_with_rolling_eyes", "grimacing", "relieved", "pensive", "sleeping",
    "nerd_face", "sunglasses", "confused", "worried", "slightly_frowning_face", "open_mouth",
    "astonished", "flushed", "scream", "fearful", "cry", "disappointed", "weary", "tired_face",
    "triumph", "rage", "angry", "smiling_imp", "skull", "clown_face", "ghost", "robot_face",
    "melting_face", "pleading_face", "partying_face", "star-struck", "exploding_head",
    "face_with_monocle", "zany_face", "shushing_face", "nauseated_face", "face_vomiting",
    "yawning_face", "smiling_face_with_tear", "face_with_hand_over_mouth", "upside_down_face",
    "money_mouth_face", "hugging_face", "face_with_raised_eyebrow", "drooling_face",
    "saluting_face", "see_no_evil", "hear_no_evil", "speak_no_evil", "wave", "raised_hands",
    "clap", "pray", "ok_hand", "point_up", "point_down", "point_left", "point_right", "v",
    "crossed_fingers", "muscle", "facepalm", "shrug", "man-shrugging", "woman-shrugging",
    "handshake", "brain", "sparkles", "star", "zap", "boom", "white_check_mark",
    "heavy_check_mark", "x", "question", "exclamation", "bangbang", "warning", "no_entry",
    "no_entry_sign", "dancer", "man_dancing", "pizza", "coffee", "beer", "beers", "taco",
    "burrito", "hamburger", "cake", "cookie", "doughnut", "avocado", "eggplant", "peach",
    "bug", "snake", "turtle", "dog", "cat", "unicorn_face", "monkey", "octopus", "whale",
    "sun_with_face", "sunny", "cloud", "rain_cloud", "snowflake", "zzz", "bulb", "hammer",
    "wrench", "gear", "key", "lock", "unlock", "bell", "mega", "memo", "pencil2", "clipboard",
    "calendar", "chart_with_upwards_trend", "chart_with_downwards_trend", "bar_chart",
    "computer", "keyboard", "iphone", "email", "package", "moneybag", "money_with_wings",
    "gem", "trophy", "checkered_flag", "hourglass", "alarm_clock", "ok", "new", "cool", "sos",
    "arrow_up", "arrow_down", "arrow_left", "arrow_right", "repeat", "recycle", "ship",
    "airplane", "car", "bike", "popcorn", "salute", "chef_kiss", "wave", "ballot_box_with_check",
  ]
}
