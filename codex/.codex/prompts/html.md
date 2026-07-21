---
description: Publish or retrieve a Porio D1 document, or create an explicitly requested local HTML report
argument-hint: "[topic, html.porio.ai link, or local HTML request]"
---

Use the `html` skill.

Handle this request: $ARGUMENTS

Requirements:

- Choose the output by intent, not by the current directory.
- For Porio documentation or any html.porio.ai link, use the authenticated D1 archive and its bundled client. Search before publishing, draft under `/tmp`, verify through both structured and raw-markdown reads, remove the draft, and return the live `/d/<slug>` URL.
- Treat D1 as the sole durable Porio document store. Never add Porio docs or handoffs to Git, and never substitute a raw HTML file when the credential is unavailable.
- For an explicitly requested non-Porio local `.html` deliverable, build a self-contained file with no external requests and report its path.
- Upload document images through the archive client and reference their returned `/i/...` URLs; never base64-inline them.
- Include completed work, owner-only pending work, exact non-secret values, verification, risks, and next actions when relevant. Never include secret values.
