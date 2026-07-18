---
name: html
description: Read AND write html.porio.ai docs. READ — when a prompt references an https://html.porio.ai/d/<slug> (or /md/<slug>) link, curl it back as markdown with the VPS-sourced token (the app is auth-gated; WebFetch won't work). WRITE — on /html or "a doc / write-up / handoff / walkthrough / QA report", publish markdown to html.porio.ai in a Porio repo (return the /d/<slug> link) or a local .html file elsewhere. Triggers: any "html.porio.ai" link, "/html", "read this doc", "save a doc", "write this up", "handoff", "give me a link".
---

# /html — html.porio.ai docs (read + write)

Porio's durable docs are **markdown in D1 behind https://html.porio.ai** (Google-OAuth reader for humans, bearer token for agents). The app is **auth-gated**, so a plain fetch/WebFetch of a doc URL returns the login gate — always go through the API with the token below.

## The token (needed for every read and write)

Canonical source is the VPS file `/home/porio/html/.env.local` (it is **not** in Doppler):

```bash
# From the mac (this machine): read it over SSH.
TOKEN=$(ssh -o BatchMode=yes root@178.156.146.209 \
  "sudo -u porio bash -lc \"grep '^DOCS_INGEST_TOKEN=' /home/porio/html/.env.local | cut -d= -f2\"")
```

(An agent running **on the VPS** reads it directly: `TOKEN=$(grep '^DOCS_INGEST_TOKEN=' /home/porio/html/.env.local | cut -d= -f2)`.)

---

## READ — resolve a linked doc to markdown

**Whenever a prompt references an `https://html.porio.ai/d/<slug>` or `/md/<slug>` link, fetch its markdown and read it before acting.** Extract the slug (last path segment) and curl `/md/<slug>`:

```bash
URL="https://html.porio.ai/d/2026-07-12-quante-patreon-stripe-flows"   # the linked doc
SLUG=$(printf '%s' "$URL" | sed -E 's#[?#].*$##; s#/+$##; s#.*/##')
curl -s "https://html.porio.ai/md/$SLUG" -H "Authorization: Bearer $TOKEN"
# → the raw markdown (frontmatter + body). `?token=$TOKEN` as a query param also works.
```

- **Images** referenced as `/i/<path>` are fetched the same way: `curl -s "https://html.porio.ai/i/<path>" -H "Authorization: Bearer $TOKEN"`.
- **Search / discover** across all docs: `curl -s "https://html.porio.ai/api/docs?q=<terms>&limit=20" -H "Authorization: Bearer $TOKEN"` → JSON `{documents,total}` (searches title/slug/description/project/kind/tags). Omit `q` + page with `?offset=&limit=` to list.
- Do **not** use WebFetch on `/d/<slug>` — it's the auth-gated HTML page, not the content.

---

## WRITE — two modes, pick by location

- **In a Porio repo (cwd under `~/porio`) → publish markdown to html.porio.ai** and give the user the `/d/<slug>` link. Default for all Porio work.
- **Anywhere else → write a self-contained local `.html`** file (Mode B).

### Mode A — Porio repo → html.porio.ai

1. Do the work first; gather real payloads/screenshots. Never invent values.
2. Author GitHub-flavored markdown with YAML frontmatter, saved as a seed in `<repo>/html/<slug>.md` (root `html/` is gitignored scratch):

   ```markdown
   ---
   title: Exact document title
   description: One-sentence summary.
   project: quante            # lowercase-kebab — quante, porio-void, porio-hub, dev-porio, porio-html, app, web, …
   kind: walkthrough          # handoff | discovery | review | walkthrough | note
   date: 2026-07-12
   tags: [patreon, stripe]
   slug: 2026-07-12-<topic>   # YYYY-MM-DD-<topic>; the upsert key
   ---

   ## Summary
   Lead with the conclusion / verdict box, then detail.
   ```

   Name code-fence languages (shiki). `> [!WARNING]` alerts and `::: tip … :::` containers render styled. Tables for enumerable facts (records, env vars, IDs, state machines). Reference repo files as `path:line`.

3. **Publish** (upsert by slug — re-POST the same slug to update the same doc/link):

   ```bash
   jq -n --rawfile md "<repo>/html/<slug>.md" --arg slug "<slug>" '{markdown:$md, slug:$slug}' \
     | curl -s -X POST https://html.porio.ai/api/docs \
         -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @-
   # → {"slug":"…","created":true,"url":"/d/…"}
   ```

4. **Report the live URL** `https://html.porio.ai/d/<slug>` — the link the user wants.

**Images** (screenshots/diagrams): never base64-inline. Upload keyed by slug, then reference the returned `/i/...` path (deterministic — re-POST replaces):

```bash
curl -s -X POST "https://html.porio.ai/api/images/<slug>/01-context.png" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: image/png" --data-binary @01-context.png
# markdown: ![alt](/i/<slug>/01-context.png)   (png/jpg/gif/webp/svg/avif, ≤20MB)
```

Content rules: lead with the conclusion; tables/payloads over prose; never include secret values (name them + where they're set); mark owner-only work "handoff required" until confirmed; prefer updating an existing slug over a near-duplicate. The system reference is the box `/home/porio/html/AGENTS.md` (`## porio-html`); app = the `porio-html` Void worker (`github.com/AceroM/porio-html`, checkout `/home/porio/html`, D1 `porio-html-db`).

### Mode B — Non-Porio → self-contained local `.html`

- Write to `<project-root>/html/<slug>.html` (kebab-case slug). Images → own subfolder `html/<slug>/index.html` + sibling `NN-<context>.png` with **relative** `src`, never base64.
- Ensure `html/` is gitignored (`/html/`). One `<html>` file, zero external requests: inline CSS, system font stack, no CDN; readable as `file://`. Dark-first (`color-scheme: dark`), ~60rem max-width.
- Lead with the conclusion; real headings, tables, `<code>`, `path:line` refs. End by printing the file path.
