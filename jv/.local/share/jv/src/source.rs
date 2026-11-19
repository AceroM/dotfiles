//! Where the diff comes from: `gh pr diff`, local changes, a shell command, or
//! stdin. Also fetches the PR's title/branches for the header in the background.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;

#[derive(Clone, Debug)]
pub enum Source {
    /// Arguments passed straight to `gh pr diff` (PR number, URL, branch, -R).
    Gh(Vec<String>),
    /// jf: the PR (same arguments) and this checkout's work merged onto the
    /// base branch's tip, diffed against it. The note says what went in.
    Net(Vec<String>, Option<String>),
    /// `git diff HEAD`: staged + unstaged changes.
    Local,
    /// Net patch of the GitHub stack containing this checkout's PR.
    Stack(Option<String>),
    /// Arguments passed straight to `git diff` (revs, ranges, --staged, -- paths).
    Git(Vec<String>),
    Cmd(String),
    Stdin,
}

impl Source {
    pub fn label(&self) -> String {
        match self {
            Source::Gh(a) if a.is_empty() => "gh pr diff".into(),
            Source::Gh(a) => format!("gh pr diff {}", a.join(" ")),
            Source::Net(_, Some(note)) => note.clone(),
            Source::Net(a, None) if a.is_empty() => "net diff: the PR + local work".into(),
            Source::Net(a, None) => format!("net diff: {}", a.join(" ")),
            Source::Local => "local changes (git diff HEAD)".into(),
            Source::Stack(label) => label.clone().unwrap_or_else(|| "current stack net diff".into()),
            Source::Git(a) if a.is_empty() => "git diff".into(),
            Source::Git(a) => format!("git diff {}", a.join(" ")),
            Source::Cmd(c) => c.clone(),
            Source::Stdin => "stdin".into(),
        }
    }

    pub fn reloadable(&self) -> bool {
        !matches!(self, Source::Stdin)
    }

    /// Stack and Net sources keep the fetch's note as their header label.
    pub fn set_label(&mut self, label: Option<&str>) {
        if let Source::Stack(current) | Source::Net(_, current) = self {
            *current = label.map(str::to_string);
        }
    }

    /// The note a Net source shows beside the PR's title.
    pub fn badge(&self) -> Option<&str> {
        match self {
            Source::Net(_, note) => note.as_deref(),
            _ => None,
        }
    }

    /// Whatever the PR selector is, for `gh pr view` (the header's details).
    pub fn pr_args(&self) -> Option<&[String]> {
        match self {
            Source::Gh(a) | Source::Net(a, _) => Some(a),
            _ => None,
        }
    }

    pub fn fetch(&self) -> Result<String, String> {
        self.fetch_noted().map(|(text, _)| text)
    }

    /// The diff, plus a note when it didn't come the usual way.
    pub fn fetch_noted(&self) -> Result<(String, Option<String>), String> {
        let (kind, args): (&str, &[String]) = match self {
            Source::Gh(args) => ("pr", args),
            Source::Git(args) => ("git", args),
            Source::Local => ("local", &[]),
            Source::Stack(_) => return crate::stack::diff().map(|(text, label)| (text, Some(label))),
            Source::Net(args, _) => return crate::local::fetch(args),
            Source::Cmd(command) => ("cmd", std::slice::from_ref(command)),
            Source::Stdin => {
                let mut text = String::new();
                std::io::stdin().read_to_string(&mut text).map_err(|e| format!("reading stdin: {e}"))?;
                return Ok((text, None));
            }
        };
        load(kind, args)
    }
}

/// A diff from the Go loader: `pr` (gh pr diff), `git`, `local` or `cmd`.
pub fn load(kind: &str, args: &[String]) -> Result<(String, Option<String>), String> {
    let out = driver()?.args(["--jv-fetch", kind]).args(args).output()
        .map_err(|e| format!("running the diff loader: {e}"))?;
    let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(if message.is_empty() { format!("diff loader exited with {}", out.status) } else { message });
    }
    Ok((String::from_utf8_lossy(&out.stdout).into_owned(), (!message.is_empty()).then_some(message)))
}

fn driver() -> Result<Command, String> {
    let path = std::env::var_os("_JV_DRIVER").ok_or("missing Go diff loader")?;
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null());
    Ok(cmd)
}

#[derive(Clone, Debug, Default)]
pub struct PrMeta {
    pub number: String,
    pub title: String,
    pub author: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
    pub state: String,
    /// https://github.com/owner/repo/pull/N
    pub url: String,
}

/// `gh pr view` for the same PR, off the main thread so the diff shows first.
pub fn spawn_meta(args: Vec<String>) -> mpsc::Receiver<PrMeta> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        if let Some(m) = pr_meta(&args) {
            let _ = tx.send(m);
        }
    });
    rx
}

pub fn pr_meta(args: &[String]) -> Option<PrMeta> {
    let out = driver().ok()?
        .arg("--jv-meta")
        .args(args)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let f: Vec<&str> = s.trim_end_matches('\n').split('\t').collect();
    if f.len() < 8 {
        return None;
    }
    let unesc = |s: &str| s.replace("\\t", " ").replace("\\n", " ").replace("\\\\", "\\");
    Some(PrMeta {
        number: f[0].to_string(),
        title: unesc(f[1]),
        author: f[2].to_string(),
        head: f[3].to_string(),
        base: f[4].to_string(),
        draft: f[5] == "true",
        state: f[6].to_string(),
        url: f[7].to_string(),
    })
}

pub fn repo_root() -> Option<std::path::PathBuf> {
    let out = Command::new("git").args(["rev-parse", "--show-toplevel"]).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().into())
}

pub fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

/// Open a URL in the default browser without waiting on it.
pub fn open_url(url: &str) -> bool {
    let opener = if which("open") { "open" } else { "xdg-open" };
    Command::new(opener)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// GitHub anchors each file in a PR's diff as `#diff-<sha256(path)>`.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
        0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
        0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
        0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] =
        [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for (i, b) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// pbcopy when it exists, otherwise OSC 52 (works over SSH in Ghostty).
pub fn copy(text: &str) -> bool {
    use std::io::Write;
    if which("pbcopy") {
        if let Ok(mut child) = Command::new("pbcopy").stdin(Stdio::piped()).spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            return child.wait().map(|s| s.success()).unwrap_or(false);
        }
    }
    let mut out = std::io::stdout();
    let ok = write!(out, "\x1b]52;c;{}\x07", base64(text.as_bytes())).is_ok();
    let _ = out.flush();
    ok
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for k in 0..4 {
            if k <= c.len() {
                s.push(T[((n >> (18 - 6 * k)) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::sha256_hex;

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let long = "a".repeat(1000);
        assert_eq!(sha256_hex(long.as_bytes()), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    }
}
