---
name: html
description: Read, search, publish, and update durable Porio markdown docs in the authenticated html.porio.ai D1 archive, or create a self-contained local HTML report when explicitly requested for non-Porio work. Use for any html.porio.ai link, /html, Porio handoff, discovery, review, walkthrough, QA report, historical lookup, "write this up", "save a doc", or "give me a link" request.
---

# /html — Porio D1 docs and explicit local HTML

Porio's durable docs are markdown records in the remote `documents` D1 table behind https://html.porio.ai. Humans use the Google-OAuth reader; agents use its bearer-authenticated API.

## Choose the mode by intent, never by working directory

- **Porio documentation, handoffs, discoveries, reviews, walkthroughs, QA reports, historical lookups, or any `html.porio.ai` link:** use Mode A and the D1 archive, regardless of the current directory.
- **An explicitly requested standalone `.html` deliverable for non-Porio work:** use Mode B.

If the intent is ambiguous but the content concerns Porio, use Mode A. Do not select local HTML merely because the current directory is outside `~/porio`.

## Mode A — remote Porio D1 archive

**D1 is the only durable source of truth for Porio docs.** Never add a Porio document to a repository, `docs/`, `handoffs/`, or a Git commit. Do not create a raw `.html` Porio handoff. Draft outside repositories under `/tmp`, publish and verify it, then remove the temporary draft. A Git push does not publish to html.porio.ai.

### Client and credential

Use the bundled client for document API operations:

```bash
CODEX_HTML_SKILL="${CODEX_HOME:-$HOME/.codex}/skills/html"
if [ -x "$CODEX_HTML_SKILL/scripts/porio_docs.py" ]; then
  DOCS="$CODEX_HTML_SKILL/scripts/porio_docs.py"
else
  DOCS="$HOME/.claude/skills/html/scripts/porio_docs.py"
fi
test -x "$DOCS"
```

The client reads `DOCS_INGEST_TOKEN` without printing it, in this order: the process environment, `$PORIO_DOCS_ENV_FILE`, `~/.config/porio/docs.env`, then the canonical VPS checkout at `/home/porio/porioHQ/html-porio-ai/.env.local`. If none is available, stop and report the credential blocker. Never print, `cat`, log, commit, or paste the token into a prompt, and never fall back to Git.

### Read linked docs and search history

Whenever a prompt references `https://html.porio.ai/d/<slug>` or `/md/<slug>`, extract the last path segment and read its markdown before acting:

```bash
URL="https://html.porio.ai/d/2026-07-19-exact-topic"
SLUG=$(printf '%s' "$URL" | sed -E 's#[?#].*$##; s#/+$##; s#.*/##')
"$DOCS" view "$SLUG"
```

Use the archive instead of guessing about prior work:

```bash
"$DOCS" list --offset 0 --limit 40
"$DOCS" search "distinctive project or topic terms" --limit 20
"$DOCS" get 2026-07-19-exact-topic
"$DOCS" view 2026-07-19-exact-topic
```

Do not browse the auth-gated `/d/` page to obtain content. Fetch referenced `/i/<path>` images with an authenticated request when they are relevant.

### Publish or update

1. Finish all safe implementation and verification first. Gather real payloads and screenshots; never invent values.
2. Search before writing so an existing record can be intentionally updated instead of duplicated:

   ```bash
   "$DOCS" search "distinctive project or topic terms" --limit 20
   ```

3. Write `/tmp/porio-doc-<slug>.md` as GitHub-flavored markdown with YAML frontmatter:

   ```markdown
   ---
   title: Exact document title
   description: One-sentence summary.
   project: porio-hub
   kind: handoff
   date: 2026-07-19
   slug: 2026-07-19-exact-topic
   tags: [dns, oauth]
   ---

   ## Status

   Lead with the conclusion or current status.
   ```

   `project` is lowercase kebab-case. `kind` is `handoff`, `discovery`, `review`, `walkthrough`, or `note`. Use a new descriptive slug for a distinct historical record; reuse a slug only when intentionally updating that record. Name every code-fence language. Prefer tables for enumerable facts and reference repository files as `path:line`.

4. Publish the temporary file:

   ```bash
   "$DOCS" publish /tmp/porio-doc-2026-07-19-exact-topic.md
   ```

5. Treat the document as published only after both verification calls succeed:

   ```bash
   "$DOCS" get 2026-07-19-exact-topic
   "$DOCS" view 2026-07-19-exact-topic >/dev/null
   ```

6. Remove the temporary markdown and report `https://html.porio.ai/d/<slug>`.

Frontmatter drives metadata. `publish --slug <slug>` explicitly overrides its slug, and re-publishing the same slug upserts that D1 record.

### Images

Images live in the private `porio-html` R2 bucket, never inline as base64 and never in Git. Upload under a deterministic document-scoped key:

```bash
"$DOCS" upload-image 2026-07-19-exact-topic /tmp/01-context.png
```

Reference the returned root-relative `/i/...` URL in markdown. Supported extensions are png, jpg/jpeg, gif, webp, svg, and avif, up to 20 MB. Re-uploading the same name replaces the image.

### Content requirements

- Lead with status, then completed work.
- Record owner actions with exact non-secret values and where to enter them.
- Include verification, remaining risks, assumptions, rollback notes, and a clear “not completed by agent” section when relevant.
- Never include secret values. Name the secret and point to where the owner sets it.
- Do not imply owner-only work is complete until confirmed.

The system reference is `/home/porio/porioHQ/html-porio-ai/AGENTS.md` (`## porio-html`). The worker checkout is `/home/porio/porioHQ/html-porio-ai`, and its D1 database is `porio-html-db`.

## Mode B — explicit non-Porio standalone HTML

- Use this mode only when the user explicitly requests a local/self-contained `.html` deliverable and the content is not a durable Porio document.
- Write to `<project-root>/html/<slug>.html`. If the page has images, use `html/<slug>/index.html` plus sibling `NN-<context>.png` files with relative `src` paths; never base64-inline them.
- Ensure the project ignores `/html/`.
- Produce one self-contained HTML file with inline CSS, a system font stack, no CDN or external requests, and correct `file://` behavior. Default to dark-first (`color-scheme: dark`) and about `60rem` maximum width.
- Lead with the conclusion; use semantic headings, tables, `<code>`, and `path:line` references. End by reporting the local file path.
