//! A small fzf-ish matcher for the go-to-file picker: subsequence match with
//! bonuses for consecutive characters, word starts, and hits in the file name.

/// Score `text` against `query`; returns the score and matched char indices.
pub fn score(query: &str, text: &str) -> Option<(i64, Vec<usize>)> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() {
        return Some((0, Vec::new()));
    }
    let smart = q.iter().any(|c| c.is_uppercase());
    let t: Vec<char> = text.chars().collect();
    let eq = |a: char, b: char| if smart { a == b } else { a.to_lowercase().eq(b.to_lowercase()) };
    let name_start = t.iter().rposition(|&c| c == '/').map_or(0, |i| i + 1);

    // Anchor the last query char as late as possible so matches favour the
    // file name, then walk backwards greedily.
    let mut pos = Vec::with_capacity(q.len());
    let mut ti = t.len();
    for &qc in q.iter().rev() {
        let found = (0..ti).rev().find(|&i| eq(t[i], qc))?;
        pos.push(found);
        ti = found;
    }
    pos.reverse();

    let mut s: i64 = 0;
    for (k, &i) in pos.iter().enumerate() {
        s += 16;
        let prev = if i == 0 { '/' } else { t[i - 1] };
        if matches!(prev, '/' | '_' | '-' | '.' | ' ') || (prev.is_lowercase() && t[i].is_uppercase()) {
            s += 10;
        }
        if i >= name_start {
            s += 8;
        }
        if k > 0 {
            let gap = i - pos[k - 1] - 1;
            if gap == 0 {
                s += 14;
            } else {
                s -= gap.min(20) as i64;
            }
        }
    }
    s -= (t.len() as i64) / 8;
    Some((s, pos))
}
