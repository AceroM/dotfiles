// snpet — dancing miguel, a desktop pet for the Slack notification feed.
//
// Hammerspoon's notifications.lua appends every Slack notification macOS
// records to ~/.local/state/slack-notifications.jsonl. `sn` shows that feed in
// the terminal; this shows it on the desktop: a sprite that sits in a corner,
// dances while something is unread, and opens an inbox on click where a
// message can be answered — as you, through the Slack app's own session, the
// same way `sn` does (Slack.swift) — without Slack ever coming to the front.
//
//   click / ⌥` / ⌃`  open or close the inbox
//   j/k               move            h/l  page          g/G  first / last
//   /                 filter          c    reply         r    reply in a thread
//   C                 new message to someone (@ who, tab picks, then what)
//   M                 mark everything on this page read in Slack (resting on a row does one)
//   y / Y             copy the message / its Slack link
//   enter             open in Slack   ⌘D   dictate via Wispr Flow (hands-free)
//   esc               close the reply box, then the inbox
//   right-click       menu: dictation default, session check, quit
//
//   snpet --check-auth                          resolve the Slack session, print who you are
//   snpet --reply <channel> <thread_ts|-> <text>  the inbox's send path, from a shell
//   snpet --react <channel> <ts> <name>           its reaction path
//   snpet --mark-read <channel> <ts>              its read-marking path
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
if ["--check-auth", "--reply", "--react", "--mark-read"].contains(args.first ?? "") {
  // A plain CLI: no NSApplication, the exit code says whether it worked.
  let done = DispatchSemaphore(value: 0)
  var code: Int32 = 0
  Task {
    do {
      if args.first == "--check-auth" {
        print("ok — \(try await Slack.shared.whoAmI())")
      } else if args.first == "--mark-read" {
        guard args.count == 3 else { throw SlackError("usage: snpet --mark-read <channel> <ts>") }
        try await Slack.shared.markRead(channel: args[1], ts: args[2], threadTs: nil)
        print("marked \(args[1]) read through \(args[2])")
      } else if args.first == "--react" {
        guard args.count == 4 else {
          throw SlackError("usage: snpet --react <channel> <ts> <name>")
        }
        let target = ReplyTarget(channel: args[1], ts: args[2], threadTs: nil)
        try await Slack.shared.react(target, name: args[3])
        print("reacted :\(args[3]): on \(args[2]) in \(args[1])")
      } else {
        guard args.count >= 4 else {
          throw SlackError("usage: snpet --reply <channel> <thread_ts|-> <text…>")
        }
        let thread = args[2] == "-" ? nil : args[2]
        let target = ReplyTarget(channel: args[1], ts: thread ?? "", threadTs: thread)
        try await Slack.shared.reply(target, text: args[3...].joined(separator: " "))
        print("sent to \(args[1])\(thread.map { " · thread \($0)" } ?? "")")
      }
    } catch {
      FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
      code = 1
    }
    done.signal()
  }
  done.wait()
  exit(code)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
