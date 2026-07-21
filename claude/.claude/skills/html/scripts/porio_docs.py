#!/usr/bin/env python3
"""Authenticated CLI for the html.porio.ai document archive."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "https://html.porio.ai"
DEFAULT_ENV_FILES = (
    Path.home() / ".config/porio/docs.env",
    Path("/home/porio/porioHQ/html-porio-ai/.env.local"),
)
IMAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def env_value(path: Path, key: str) -> str | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError):
        return None
    prefix = f"{key}="
    for line in lines:
        if not line.startswith(prefix):
            continue
        value = line[len(prefix) :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        return value or None
    return None


def token() -> str:
    direct = os.environ.get("DOCS_INGEST_TOKEN", "").strip()
    if direct:
        return direct

    configured = os.environ.get("PORIO_DOCS_ENV_FILE", "").strip()
    paths = ([Path(configured).expanduser()] if configured else []) + list(DEFAULT_ENV_FILES)
    for path in paths:
        value = env_value(path, "DOCS_INGEST_TOKEN")
        if value:
            return value

    raise SystemExit(
        "DOCS_INGEST_TOKEN is unavailable. Set it in the environment, set "
        "PORIO_DOCS_ENV_FILE, add ~/.config/porio/docs.env, or restore the "
        "canonical VPS html-porio-ai .env.local. "
        "Do not publish a Git fallback."
    )


def request(path: str, *, method: str = "GET", body: bytes | None = None, content_type: str | None = None) -> bytes:
    base_url = os.environ.get("PORIO_DOCS_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    headers = {
        "Authorization": f"Bearer {token()}",
        "Accept": "application/json, text/markdown",
        # Cloudflare blocks urllib's default browser signature (Error 1010).
        "User-Agent": "PorioDocs/1.0 (+https://html.porio.ai)",
    }
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(f"{base_url}/{path.lstrip('/')}", data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=45) as response:
            return response.read()
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise SystemExit(f"html.porio.ai returned HTTP {error.code}: {detail}") from None
    except URLError as error:
        raise SystemExit(f"html.porio.ai request failed: {error.reason}") from None


def print_json(payload: bytes) -> None:
    parsed = json.loads(payload.decode("utf-8"))
    print(json.dumps(parsed, indent=2, ensure_ascii=False))


def command_list(args: argparse.Namespace) -> None:
    query = urlencode({"offset": args.offset, "limit": args.limit})
    print_json(request(f"api/docs?{query}"))


def command_search(args: argparse.Namespace) -> None:
    query = urlencode({"q": args.query, "offset": args.offset, "limit": args.limit})
    print_json(request(f"api/docs?{query}"))


def command_get(args: argparse.Namespace) -> None:
    print_json(request(f"api/docs/{quote(args.slug, safe='')}"))


def command_view(args: argparse.Namespace) -> None:
    sys.stdout.buffer.write(request(f"md/{quote(args.slug, safe='')}"))


def command_publish(args: argparse.Namespace) -> None:
    if args.file == "-":
        markdown = sys.stdin.read()
    else:
        markdown = Path(args.file).read_text(encoding="utf-8")
    payload: dict[str, str] = {"markdown": markdown}
    if args.slug:
        payload["slug"] = args.slug
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    print_json(request("api/docs", method="POST", body=body, content_type="application/json"))


def command_upload_image(args: argparse.Namespace) -> None:
    path = Path(args.file)
    name = args.name or path.name
    if not IMAGE_NAME.fullmatch(name):
        raise SystemExit("Image name may contain only letters, numbers, dot, dash, and underscore.")
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    route = f"api/images/{quote(args.slug, safe='')}/{quote(name, safe='')}"
    print_json(request(route, method="POST", body=path.read_bytes(), content_type=content_type))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    listing = commands.add_parser("list", help="List document metadata")
    listing.add_argument("--offset", type=int, default=0)
    listing.add_argument("--limit", type=int, default=40)
    listing.set_defaults(run=command_list)

    search = commands.add_parser("search", help="Search the remote archive")
    search.add_argument("query")
    search.add_argument("--offset", type=int, default=0)
    search.add_argument("--limit", type=int, default=20)
    search.set_defaults(run=command_search)

    get = commands.add_parser("get", help="Get a structured document record")
    get.add_argument("slug")
    get.set_defaults(run=command_get)

    view = commands.add_parser("view", help="Print a document's raw markdown")
    view.add_argument("slug")
    view.set_defaults(run=command_view)

    publish = commands.add_parser("publish", help="Upsert markdown from a file or stdin")
    publish.add_argument("file", help="Markdown file path, or - for stdin")
    publish.add_argument("--slug", help="Explicit slug override")
    publish.set_defaults(run=command_publish)

    image = commands.add_parser("upload-image", help="Upload a private doc image")
    image.add_argument("slug")
    image.add_argument("file")
    image.add_argument("--name", help="Stored filename (defaults to the local basename)")
    image.set_defaults(run=command_upload_image)
    return root


def main() -> None:
    args = parser().parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
