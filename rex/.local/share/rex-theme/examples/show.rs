//! `cargo run --release --example show`: the theme the tools would draw with here, and how long
//! picking it took.
fn main() {
    let t0 = std::time::Instant::now();
    let t = rex_theme::theme(&["JV_BG"]);
    let took = t0.elapsed();
    println!("{t:#?}");
    println!("took {took:?}");
}
