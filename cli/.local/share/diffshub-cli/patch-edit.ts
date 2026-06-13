// Line-deletion helpers used by the `Delete` action in the diff viewer.
//
// Two backing media are supported:
//   - working files  -> removeFileLines: drop new-file lines [lo,hi] from disk
//   - patch files    -> removePatchAdditions: drop the selected `+` lines from
//                        a unified diff, recomputing hunk headers so the patch
//                        still applies. Only addition lines are removed (removing
//                        context/deletion lines would corrupt the hunk), so the
//                        caller restricts deletes to the additions side.

// ---- Working files: splice new-file lines [lo,hi] (1-based, inclusive) ----
export function removeFileLines(text: string, lo: number, hi: number): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((_, idx) => {
    const lineNo = idx + 1;
    return lineNo < lo || lineNo > hi;
  });
  return kept.join(eol);
}

// ---- Patch files ----

// The new-side path a file block targets (`+++ b/<path>`), or null when the
// block has no `+++` header or creates nothing (e.g. `+++ /dev/null`).
function blockNewPath(block: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      let rest = line.slice(4);
      const tab = rest.indexOf("\t");
      if (tab >= 0) rest = rest.slice(0, tab);
      rest = rest.trim();
      if (rest === "/dev/null") return null;
      const m = rest.match(/^[abciow]\/(.*)$/); // strip a git a/ b/ i/ … prefix
      return m ? m[1] : rest;
    }
  }
  return null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Drop addition lines whose new-file number falls in [lo,hi] from one file
// block, recomputing each hunk header. Returns the edited block, or null when
// no change survives (so the caller drops the whole file block).
function editBlockDropAdditions(block: string, lo: number, hi: number): string | null {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const trailingNL = block.endsWith("\n");
  const lines = block.replace(/\r?\n$/, "").split(/\r?\n/);

  const header: string[] = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("@@")) header.push(lines[i++]);

  const hunks: string[] = [];
  let newDelta = 0; // cumulative new-line count change from earlier hunks
  let anyHunk = false;

  while (i < lines.length) {
    const m = lines[i].match(HUNK_HEADER);
    if (!m) {
      hunks.push(lines[i++]);
      continue;
    }
    const oldStart = parseInt(m[1], 10);
    const newStart = parseInt(m[3], 10);
    const rest = m[5] ?? "";
    i++;

    const body: string[] = [];
    while (i < lines.length && !lines[i].startsWith("@@")) body.push(lines[i++]);

    let newNum = newStart;
    let dropped = 0;
    const kept: string[] = [];
    for (const bl of body) {
      const c = bl[0];
      if (c === "+") {
        if (newNum >= lo && newNum <= hi) {
          dropped++;
          newNum++;
          continue;
        }
        kept.push(bl);
        newNum++;
      } else if (c === " ") {
        kept.push(bl);
        newNum++;
      } else {
        kept.push(bl); // '-' deletion or '\ No newline at end of file'
      }
    }

    if (kept.some((b) => b[0] === "+" || b[0] === "-")) {
      let oc = 0;
      let nc = 0;
      for (const b of kept) {
        const c = b[0];
        if (c === " ") {
          oc++;
          nc++;
        } else if (c === "-") oc++;
        else if (c === "+") nc++;
      }
      hunks.push(`@@ -${oldStart},${oc} +${newStart + newDelta},${nc} @@${rest}`);
      hunks.push(...kept);
      anyHunk = true;
    }
    newDelta -= dropped;
  }

  if (!anyHunk) return null;
  const result = [...header, ...hunks].join(eol);
  return trailingNL ? result + eol : result;
}

// Remove the selected additions (new-file lines [lo,hi]) from the file inside
// `text` whose new path is `targetPath`. Other file blocks pass through
// untouched; the rebuilt patch is byte-for-byte identical outside the edit.
export function removePatchAdditions(
  text: string,
  targetPath: string,
  lo: number,
  hi: number,
): string {
  const isGit = /^diff --git /m.test(text);
  const breakRe = isGit ? /(?=^diff --git )/gm : /(?=^---\s+\S)/gm;
  const blocks = text.split(breakRe);

  let edited = false;
  const out = blocks.map((block) => {
    if (edited || blockNewPath(block) !== targetPath || !/^@@/m.test(block)) return block;
    edited = true;
    return editBlockDropAdditions(block, lo, hi); // may be null -> drop block
  });

  return out.filter((b): b is string => b !== null).join("");
}
