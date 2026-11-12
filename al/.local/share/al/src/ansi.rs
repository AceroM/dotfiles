//! Terminal output (a Rex pane capture, `--format=vt`) to styled runs: SGR
//! colors and attributes are kept, a cursor-forward (CSI n C, which Rex
//! writes for runs of blank cells) becomes spaces, every other escape is
//! dropped.

use ratatui::style::{Color, Modifier, Style};

pub type Line = Vec<(String, Style)>;

pub fn parse(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let (mut line, mut run, mut st) = (Line::new(), String::new(), Style::new());
    let flush = |line: &mut Line, run: &mut String, st: Style| {
        if !run.is_empty() {
            line.push((std::mem::take(run), st));
        }
    };
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => {
                flush(&mut line, &mut run, st);
                match chars.next() {
                    // CSI: parameters, then a final byte in @..~.
                    Some('[') => {
                        let mut params = String::new();
                        for d in chars.by_ref() {
                            if ('@'..='~').contains(&d) {
                                if d == 'm' {
                                    st = sgr(st, &params);
                                } else if d == 'C' {
                                    // Cursor forward over blank cells: as many spaces, unstyled.
                                    let n = params.parse::<usize>().unwrap_or(1).clamp(1, 1000);
                                    line.push((" ".repeat(n), Style::new()));
                                }
                                break;
                            }
                            params.push(d);
                        }
                    }
                    // OSC (titles, hyperlinks): up to BEL or ESC \.
                    Some(']') => {
                        while let Some(d) = chars.next() {
                            if d == '\x07' {
                                break;
                            }
                            if d == '\x1b' {
                                chars.next();
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            '\n' => {
                flush(&mut line, &mut run, st);
                lines.push(std::mem::take(&mut line));
            }
            '\t' => run.push_str("    "),
            c if c.is_control() => {}
            c => run.push(c),
        }
    }
    flush(&mut line, &mut run, st);
    lines.push(line);
    lines
}

fn sgr(mut st: Style, params: &str) -> Style {
    let ps: Vec<u16> = params.split([';', ':']).map(|p| p.parse().unwrap_or(0)).collect();
    let mut i = 0;
    while i < ps.len() {
        match ps[i] {
            0 => st = Style::new(),
            1 => st = st.add_modifier(Modifier::BOLD),
            2 => st = st.add_modifier(Modifier::DIM),
            3 => st = st.add_modifier(Modifier::ITALIC),
            4 => st = st.add_modifier(Modifier::UNDERLINED),
            7 => st = st.add_modifier(Modifier::REVERSED),
            9 => st = st.add_modifier(Modifier::CROSSED_OUT),
            22 => st = st.remove_modifier(Modifier::BOLD | Modifier::DIM),
            23 => st = st.remove_modifier(Modifier::ITALIC),
            24 => st = st.remove_modifier(Modifier::UNDERLINED),
            27 => st = st.remove_modifier(Modifier::REVERSED),
            29 => st = st.remove_modifier(Modifier::CROSSED_OUT),
            n @ 30..=37 => st.fg = Some(Color::Indexed((n - 30) as u8)),
            n @ 90..=97 => st.fg = Some(Color::Indexed((n - 90 + 8) as u8)),
            n @ 40..=47 => st.bg = Some(Color::Indexed((n - 40) as u8)),
            n @ 100..=107 => st.bg = Some(Color::Indexed((n - 100 + 8) as u8)),
            39 => st.fg = None,
            49 => st.bg = None,
            n @ (38 | 48) => {
                // 38;5;N (256 colors) or 38;2;R;G;B (truecolor).
                let (c, used) = match ps.get(i + 1) {
                    Some(5) => (ps.get(i + 2).map(|&n| Color::Indexed(n as u8)), 2),
                    Some(2) if i + 4 < ps.len() => (Some(Color::Rgb(ps[i + 2] as u8, ps[i + 3] as u8, ps[i + 4] as u8)), 4),
                    _ => (None, ps.len()),
                };
                if n == 38 {
                    st.fg = c.or(st.fg);
                } else {
                    st.bg = c.or(st.bg);
                }
                i += used;
            }
            _ => {}
        }
        i += 1;
    }
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_forward_is_blank_cells() {
        let lines = parse("a\x1b[1Cb\x1b[32m\x1b[3Cc\x1b[0m\r\nd");
        let text: Vec<String> = lines.iter().map(|l| l.iter().map(|(s, _)| s.as_str()).collect()).collect();
        assert_eq!(text, ["a b   c", "d"]);
        assert_eq!(lines[0].last().map(|(_, st)| st.fg), Some(Some(Color::Indexed(2))));
    }
}
