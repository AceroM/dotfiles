import SwiftUI

/// The list with one sticky prompt bar under it — the same small bar whatever
/// you are doing: idle, replying, writing to someone, filtering. The box is
/// sized to this content, so nothing is ever padding. No labels for keys.
struct InboxView: View {
  @ObservedObject var model: InboxModel
  @ObservedObject var feed: FeedStore
  @FocusState private var focus: Field?

  enum Field { case reply, composeTo, composeText, search }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if model.rows.isEmpty { empty } else { list }
      promptBar
    }
    .padding(.top, 16)  // a band for the sparkles, above the first row
    .font(.system(size: 11.5, design: .monospaced))
    .foregroundStyle(Palette.text)
    // Measured at its own ideal height (fixedSize: a stack offered less than it
    // needs would otherwise centre and clip instead of reporting the truth);
    // the panel snaps to that number under his feet.
    .fixedSize(horizontal: false, vertical: true)
    .background(
      GeometryReader { g in
        Color.clear.preference(key: ContentHeightKey.self, value: g.size.height)
      })
    .onPreferenceChange(ContentHeightKey.self) { model.contentHeight = $0 }
    .frame(minWidth: 400)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(
      // a violet wash over the frost, strongest up where he stands
      LinearGradient(
        colors: [Palette.lavender.opacity(0.14), Palette.sakura.opacity(0.05), .clear],
        startPoint: .topTrailing, endPoint: .bottomLeading))
    .overlay(
      RoundedRectangle(cornerRadius: 10)
        .strokeBorder(
          LinearGradient(
            colors: [Palette.sakura, Palette.lavender, Palette.sky],
            startPoint: .topLeading, endPoint: .bottomTrailing),
          lineWidth: 1.5))
    .overlay(alignment: .topTrailing) {
      Sparkles().padding(.top, 2).padding(.trailing, 136)  // beside his feet
    }
    .ignoresSafeArea(.container, edges: .top)  // the title bar is hidden; do not reserve its space
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(model.filter.isEmpty ? "nothing yet  (´• ω •`)" : "no matches  (>_<)")
        .foregroundStyle(Palette.dim)
      if feed.fileMissing {
        Text("feed file missing — is Hammerspoon running?").foregroundStyle(Palette.danger)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  /// One page of fixed-height rows; no scrolling, and nothing in the flow
  /// ever changes size. The selected message floats over its row as a card
  /// with the whole body — downward, or upward when the page bottom is near.
  private var list: some View {
    VStack(spacing: 1) {
      ForEach(Array(model.pageRows.enumerated()), id: \.element.id) { i, row in
        NotifRow(
          row: row, selected: model.pageStart + i == model.selection,
          unread: row.date > feed.seenThrough
        )
        .anchorPreference(key: RowBoundsKey.self, value: .bounds) { [row.id: $0] }
        .onTapGesture {
          model.selection = model.pageStart + i
          feed.markAllSeen()
        }
      }
    }
    .padding(.horizontal, 6)
    .padding(.bottom, 6)
    .overlayPreferenceValue(RowBoundsKey.self) { anchors in
      GeometryReader { geo in
        if let row = model.selected, let anchor = anchors[row.id] {
          let r = geo[anchor]
          let lines = Self.bodyLines(row.body, width: r.width)
          let height = ExpandedRow.height(lines: lines)
          let flip = r.minY + height > geo.size.height
          ExpandedRow(row: row, unread: row.date > feed.seenThrough)
            .frame(width: r.width, alignment: .topLeading)
            .offset(x: r.minX, y: flip ? r.maxY - height : r.minY)
            .allowsHitTesting(false)
        }
      }
    }
  }

  /// Lines the body will take in the card, capped at three — monospaced, so a
  /// character count is a fair guess, and only the flip direction rides on it.
  private static func bodyLines(_ body: String, width: CGFloat) -> Int {
    let perLine = max(10, Int((width - 29) / 6.9))
    return min(3, max(1, (body.count + perLine - 1) / perLine))
  }

  // MARK: - the bar

  /// Always one line tall. What it has to say beyond the prompt — an error,
  /// progress, the names tab would take — floats just above it.
  private var promptBar: some View {
    HStack(spacing: 6) {
      lead
      field
      Spacer(minLength: 6)
      trail
    }
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.lavender.opacity(0.07))
    .overlay(alignment: .topLeading) {
      if let aux {
        HStack(spacing: 10) {
          ForEach(Array(aux.items.enumerated()), id: \.offset) { i, item in
            Text(item).foregroundStyle(aux.hotFirst && i == 0 ? Palette.sakura : aux.color)
          }
        }
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 5).fill(Palette.card))
        .padding(.leading, 10)
        .alignmentGuide(.top) { d in d[.bottom] + 1 }  // its bottom on the bar's top edge
        .allowsHitTesting(false)
      }
    }
  }

  /// What the prompt is for, at its left edge.
  @ViewBuilder private var lead: some View {
    if let d = model.draft {
      Text("→ \(d.place)").foregroundStyle(Palette.dim).lineLimit(1)
      Text("❯").foregroundStyle(Palette.sakura)
    } else if let c = model.compose {
      if let to = c.target {
        Text("@\(to.name)").foregroundStyle(Palette.dim).lineLimit(1)
        Text("❯").foregroundStyle(Palette.sakura)
      } else {
        Text("@").foregroundStyle(Palette.sakura)
      }
    } else if model.searching {
      Text("/").foregroundStyle(Palette.sakura)
    } else {
      Text("❯").foregroundStyle(Palette.dim)
    }
  }

  /// The input for the mode; idle, it shows the filter that is narrowing the list.
  @ViewBuilder private var field: some View {
    if let d = model.draft {
      TextField("", text: Binding(get: { model.draftText }, set: { model.draftText = $0 }))
        .textFieldStyle(.plain)
        .focused($focus, equals: .reply)
        .onSubmit { model.send() }
        .disabled(d.sending)
        .onAppear { DispatchQueue.main.async { focus = .reply } }
    } else if let c = model.compose {
      if c.target != nil {
        TextField(
          "", text: Binding(get: { model.compose?.text ?? "" }, set: { model.compose?.text = $0 })
        )
        .textFieldStyle(.plain)
        .focused($focus, equals: .composeText)
        .onSubmit { model.sendCompose() }
        .disabled(c.sending)
        .onAppear { DispatchQueue.main.async { focus = .composeText } }
      } else {
        TextField("", text: Binding(get: { model.compose?.to ?? "" }, set: { model.compose?.to = $0 }))
          .textFieldStyle(.plain)
          .focused($focus, equals: .composeTo)
          .onSubmit { model.pickRecipient() }
          .disabled(c.resolving)
          .onAppear { DispatchQueue.main.async { focus = .composeTo } }
      }
    } else if model.searching {
      TextField("", text: Binding(get: { model.filter }, set: { model.filter = $0 }))
        .textFieldStyle(.plain)
        .focused($focus, equals: .search)
        .onSubmit { model.commitSearch() }
        .onAppear { DispatchQueue.main.async { focus = .search } }
    } else if !model.filter.isEmpty {
      Text("/\(model.filter)").foregroundStyle(Palette.dim).lineLimit(1)
    }
  }

  /// Right edge: the mic while writing, the match count while filtering, the
  /// flash and page counter otherwise.
  @ViewBuilder private var trail: some View {
    if model.draft != nil || model.compose?.target != nil {
      if Wispr.isInstalled {
        Button(action: model.toggleDictation) {
          Image(systemName: model.dictating ? "mic.fill" : "mic")
            .foregroundStyle(model.dictating ? Palette.danger : Palette.dim)
        }
        .buttonStyle(.plain)
      }
    } else if model.searching {
      Text("\(model.rows.count)").foregroundStyle(Palette.dim)
    } else {
      if !model.flash.isEmpty {
        Text(model.flash).foregroundStyle(Palette.dim).lineLimit(1)
      }
      if model.pageCount > 1 {
        Text("\(model.page + 1)/\(model.pageCount)").foregroundStyle(Palette.dim)
      }
    }
  }

  private struct Aux {
    let items: [String]
    let color: Color
    let hotFirst: Bool  // the first item is what tab takes
  }

  /// The one line above the prompt when there is something to say: an error,
  /// progress, or the names tab would complete.
  private var aux: Aux? {
    if let e = model.draft?.error ?? model.compose?.error {
      return Aux(items: [e], color: Palette.danger, hotFirst: false)
    }
    if model.draft?.sending == true || model.compose?.sending == true {
      return Aux(items: ["sending…"], color: Palette.dim, hotFirst: false)
    }
    if model.compose?.resolving == true {
      return Aux(items: ["asking Slack who that is…"], color: Palette.dim, hotFirst: false)
    }
    if model.dictating { return Aux(items: ["listening…"], color: Palette.dim, hotFirst: false) }
    if !model.suggestions.isEmpty {
      return Aux(items: model.suggestions.map { ":\($0):" }, color: Palette.dim, hotFirst: true)
    }
    if model.compose?.target == nil, !model.composeSuggestions.isEmpty {
      return Aux(items: model.composeSuggestions.map(\.name), color: Palette.dim, hotFirst: true)
    }
    return nil
  }
}

struct ContentHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct RowBoundsKey: PreferenceKey {
  static var defaultValue: [String: Anchor<CGRect>] = [:]
  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue()) { $1 }
  }
}

/// A row at rest: one line, fixed height.
struct NotifRow: View {
  let row: Notif
  let selected: Bool
  let unread: Bool

  var body: some View {
    HStack(spacing: 8) {
      Circle().fill(unread ? Palette.sakura : .clear).frame(width: 5, height: 5)
      Text(timeLabel(row.date))
        .foregroundStyle(Palette.dim)
        .frame(width: 44, alignment: .leading)
      Text(row.place)
        .fontWeight(.semibold)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(width: 120, alignment: .leading)
      Text(row.body)
        .lineLimit(1)
        .truncationMode(.tail)
        .opacity(0.8)
      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 5).fill(selected ? Palette.sakura.opacity(0.10) : .clear))
    .contentShape(Rectangle())
  }
}

/// The selected message, lifted: time and place on top, the body wrapped to
/// at most three lines. Drawn over the rows, so its background is near-solid.
struct ExpandedRow: View {
  let row: Notif
  let unread: Bool

  static func height(lines: Int) -> CGFloat { 8 + 14 + 3 + 14 * CGFloat(lines) }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 8) {
        Circle().fill(unread ? Palette.sakura : .clear).frame(width: 5, height: 5)
        Text(timeLabel(row.date)).foregroundStyle(Palette.dim)
        Text(row.place).fontWeight(.semibold).lineLimit(1)
      }
      Text(row.body)
        .lineLimit(3)
        .truncationMode(.tail)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 13)  // under the time, past the dot
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 8)
    .background(
      RoundedRectangle(cornerRadius: 5)
        .fill(Palette.card)
        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Palette.sakura.opacity(0.35))))
    .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
  }
}

/// Three ✦ twinkling out of phase, next to where he stands.
struct Sparkles: View {
  @State private var lit = false

  var body: some View {
    ZStack(alignment: .topLeading) {
      sparkle(x: 0, y: 0, size: 9, color: Palette.sakura, phase: 0)
      sparkle(x: 20, y: 4, size: 6, color: Palette.sky, phase: 0.7)
      sparkle(x: 40, y: 1, size: 5, color: Palette.lavender, phase: 1.3)
    }
    .frame(width: 48, height: 14, alignment: .topLeading)
    .allowsHitTesting(false)
    .onAppear { lit = true }
  }

  private func sparkle(x: CGFloat, y: CGFloat, size: CGFloat, color: Color, phase: Double)
    -> some View
  {
    Text("✦")
      .font(.system(size: size))
      .foregroundStyle(color)
      .opacity(lit ? 1 : 0.2)
      .animation(
        .easeInOut(duration: 1.7).repeatForever(autoreverses: true).delay(phase), value: lit)
      .offset(x: x, y: y)
  }
}

private let clock: DateFormatter = {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.dateFormat = "HH:mm"
  return f
}()

private let calendarDay: DateFormatter = {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.dateFormat = "MMM d"
  return f
}()

/// Today's rows by time, older ones by day — the same labels `sn` prints.
func timeLabel(_ unix: TimeInterval) -> String {
  let d = Date(timeIntervalSince1970: unix)
  return (Calendar.current.isDateInToday(d) ? clock : calendarDay).string(from: d)
}
