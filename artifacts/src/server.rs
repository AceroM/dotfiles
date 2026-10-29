//! The HTTP side: pages for people, a small JSON API for the CLI, and a server-sent event stream
//! that tells open pages to reload when what they show changes.

use crate::context::Context;
use crate::db::{slugify, Db, Filter, Write};
use crate::{pages, render, Args, DEFAULT_PORT};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Redirect, Response,
    },
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

struct AppState {
    db: Mutex<Db>,
    events: broadcast::Sender<String>,
    base_url: String,
    port: u16,
}

type Shared = Arc<AppState>;

fn fail(status: StatusCode, message: impl Into<String>) -> Response {
    (status, message.into()).into_response()
}

fn db_error(error: rusqlite::Error) -> Response {
    fail(StatusCode::INTERNAL_SERVER_ERROR, format!("sqlite: {error}"))
}

/// `$XDG_DATA_HOME/artifacts/artifacts.db`, else `~/.local/share/artifacts/artifacts.db`. Outside the
/// checkout, so pages never sit in the source tree.
fn default_db_path() -> String {
    let data = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    format!("{data}/artifacts/artifacts.db")
}

pub async fn serve(raw: &[String]) -> Result<(), String> {
    let args = Args::parse(raw, &[])?;
    let port: u16 = args
        .get("port")
        .or_else(|| std::env::var("ARTIFACTS_PORT").ok())
        .map(|p| p.parse().map_err(|_| format!("bad port {p:?}")))
        .transpose()?
        .unwrap_or(DEFAULT_PORT);
    let db_path = args
        .get("db")
        .or_else(|| std::env::var("ARTIFACTS_DB").ok())
        .unwrap_or_else(default_db_path);
    let db = Db::open(std::path::Path::new(&db_path)).map_err(|e| format!("opening {db_path}: {e}"))?;
    let (events, _) = broadcast::channel(64);
    let state: Shared = Arc::new(AppState { db: Mutex::new(db), events, base_url: format!("http://localhost:{port}"), port });

    let app = Router::new()
        .route("/", get(index))
        .route("/events", get(events_stream))
        .route("/api/artifacts", get(api_list).post(api_create))
        .route("/api/artifacts/:slug", get(api_get).delete(api_delete))
        .route("/api/artifacts/:slug/assets/*name", put(api_put_asset))
        .route("/api/run", post(api_run))
        .route("/api/tags", get(api_tags).post(api_add_tag))
        .route("/api/tags/:tag", axum::routing::delete(api_remove_tag))
        .route("/a/:slug", get(|Path(slug): Path<String>| async move { Redirect::permanent(&format!("/a/{slug}/")) }))
        .route("/a/:slug/", get(page))
        .route("/a/:slug/*rest", get(page_rest))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("binding 127.0.0.1:{port}: {e}"))?;
    println!("artifacts: http://localhost:{port}  ·  {db_path}");
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}

fn announce(state: &AppState, payload: Value) {
    // No subscribers is fine: nobody has a page open.
    let _ = state.events.send(payload.to_string());
}

fn filter_from(query: &HashMap<String, String>) -> Filter {
    Filter {
        q: query.get("q").filter(|v| !v.is_empty()).cloned(),
        kind: query.get("kind").filter(|v| !v.is_empty()).cloned(),
        tag: query.get("tag").filter(|v| !v.is_empty()).cloned(),
        limit: query.get("limit").and_then(|v| v.parse().ok()).unwrap_or(pages::PAGE_SIZE),
        offset: query.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0),
    }
}

async fn index(State(s): State<Shared>, Query(query): Query<HashMap<String, String>>) -> Response {
    let filter = filter_from(&query);
    let db = s.db.lock().expect("db lock");
    let items = match db.list(&filter) {
        Ok(items) => items,
        Err(e) => return db_error(e),
    };
    if query.contains_key("partial") {
        return Html(pages::list_rows(&items)).into_response();
    }
    let tags = db.tags().unwrap_or_default();
    Html(pages::index(&items, &filter, &tags)).into_response()
}

async fn events_stream(State(s): State<Shared>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(s.events.subscribe()).filter_map(|msg| msg.ok().map(|data| Ok(Event::default().data(data))));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
struct CreateRequest {
    kind: String,
    title: String,
    summary: Option<String>,
    question: Option<String>,
    source: String,
    #[serde(default)]
    ctx: Context,
    slug: Option<String>,
    #[serde(default)]
    new: bool,
    #[serde(default)]
    check: bool,
}

fn render_request(req: &CreateRequest) -> Result<(String, String), String> {
    match req.kind.as_str() {
        "code-path" => {
            let spec: Value = serde_json::from_str(&req.source).map_err(|e| format!("the code-path spec is not JSON: {e}"))?;
            let rendered = render::code_path(&spec, &req.ctx)?;
            Ok((rendered.html, rendered.check))
        }
        "md" => {
            let base = req.ctx.repo_root.as_deref().or(req.ctx.cwd.as_deref());
            Ok((render::markdown(&req.source, &req.title, base), String::new()))
        }
        "html" => Ok((req.source.clone(), String::new())),
        other => Err(format!("unknown kind {other:?}: use code-path, md or html")),
    }
}

async fn api_create(State(s): State<Shared>, Json(req): Json<CreateRequest>) -> Response {
    if let Some(slug) = &req.slug {
        if slugify(slug) != *slug {
            return fail(StatusCode::BAD_REQUEST, format!("slug {slug:?} must be lowercase letters, digits and dashes"));
        }
    }
    if req.title.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "a title is required");
    }
    // Rendering a code path shells out to git, so keep it off the async workers.
    let (req, rendered) = match tokio::task::spawn_blocking(move || {
        let rendered = render_request(&req);
        (req, rendered)
    })
    .await
    {
        Ok(pair) => pair,
        Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let (html, check) = match rendered {
        Ok(pair) => pair,
        Err(e) => return fail(StatusCode::UNPROCESSABLE_ENTITY, e),
    };
    if req.check {
        return Json(json!({ "check": check })).into_response();
    }

    let ctx_json = serde_json::to_string(&req.ctx).unwrap_or_else(|_| "{}".into());
    let saved = {
        let mut db = s.db.lock().expect("db lock");
        db.save(&Write {
            slug: req.slug.as_deref(),
            force_new: req.new,
            kind: &req.kind,
            title: req.title.trim(),
            summary: req.summary.as_deref().filter(|v| !v.is_empty()),
            question: req.question.as_deref().filter(|v| !v.is_empty()),
            source: &req.source,
            html: &html,
            ctx: &ctx_json,
            repo: req.ctx.repo.as_deref(),
            branch: req.ctx.branch.as_deref(),
            sha: req.ctx.sha.as_deref(),
            ticket: req.ctx.ticket.as_deref(),
            source_file: req.ctx.source_file.as_deref(),
            session_id: req.ctx.session_id.as_deref(),
        })
    };
    let (slug, revision) = match saved {
        Ok(saved) => saved,
        Err(e) => return db_error(e),
    };
    announce(&s, json!({ "slug": slug, "revision": revision }));
    Json(json!({ "slug": slug, "revision": revision, "url": format!("{}/a/{slug}/", s.base_url), "check": check })).into_response()
}

async fn api_list(State(s): State<Shared>, Query(query): Query<HashMap<String, String>>) -> Response {
    let db = s.db.lock().expect("db lock");
    match db.list(&filter_from(&query)) {
        Ok(items) => Json(
            items
                .iter()
                .map(|i| {
                    json!({
                        "slug": i.slug, "kind": i.kind, "title": i.title, "summary": i.summary, "repo": i.repo,
                        "tags": i.tags, "branch": i.branch, "ticket": i.ticket, "revision": i.revision,
                        "updated_at": i.updated_at, "url": format!("{}/a/{}/", s.base_url, i.slug),
                    })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => db_error(e),
    }
}

async fn api_get(State(s): State<Shared>, Path(slug): Path<String>) -> Response {
    let db = s.db.lock().expect("db lock");
    match db.get(&slug) {
        Ok(Some(a)) => Json(json!({
            "slug": a.slug, "kind": a.kind, "title": a.title, "summary": a.summary, "question": a.question,
            "source": a.source, "ctx": serde_json::from_str::<Value>(&a.ctx).unwrap_or(Value::Null),
            "revision": a.revision, "created_at": a.created_at, "updated_at": a.updated_at,
            "url": format!("{}/a/{}/", s.base_url, a.slug),
        }))
        .into_response(),
        Ok(None) => fail(StatusCode::NOT_FOUND, format!("no page {slug:?}")),
        Err(e) => db_error(e),
    }
}

async fn api_delete(State(s): State<Shared>, Path(slug): Path<String>) -> Response {
    let deleted = s.db.lock().expect("db lock").delete(&slug);
    match deleted {
        Ok(true) => {
            announce(&s, json!({ "slug": slug, "deleted": true }));
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, format!("no page {slug:?}")),
        Err(e) => db_error(e),
    }
}

/// The tag rules, and the tags that match at least one page.
async fn api_tags(State(s): State<Shared>) -> Response {
    let db = s.db.lock().expect("db lock");
    match (db.tag_rules(), db.tags()) {
        (Ok(rules), Ok(tags)) => Json(json!({
            "rules": rules.iter().map(|(tag, pattern)| json!({ "tag": tag, "pattern": pattern })).collect::<Vec<_>>(),
            "tags": tags,
        }))
        .into_response(),
        (Err(e), _) | (_, Err(e)) => db_error(e),
    }
}

#[derive(Deserialize)]
struct TagRule {
    tag: String,
    pattern: String,
}

async fn api_add_tag(State(s): State<Shared>, Json(rule): Json<TagRule>) -> Response {
    let tag = rule.tag.trim();
    if tag.is_empty() || tag.contains(['\u{1f}', '/']) || rule.pattern.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "a tag needs a name (no '/') and a glob");
    }
    let added = s.db.lock().expect("db lock").add_tag_rule(tag, rule.pattern.trim());
    match added {
        Ok(()) => {
            announce(&s, json!({ "tags": true }));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => db_error(e),
    }
}

async fn api_remove_tag(
    State(s): State<Shared>,
    Path(tag): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let removed = s.db.lock().expect("db lock").remove_tag_rule(&tag, query.get("pattern").map(String::as_str));
    match removed {
        Ok(0) => fail(StatusCode::NOT_FOUND, format!("no tag rule {tag:?}")),
        Ok(_) => {
            announce(&s, json!({ "tags": true }));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => db_error(e),
    }
}

#[derive(Deserialize)]
struct RunRequest {
    code: String,
    /// The page it was run from: the block runs in that page's directory.
    slug: Option<String>,
    /// The block's own directory, absolute or relative to the page's.
    cwd: Option<String>,
    shell: Option<String>,
}

async fn api_run(State(s): State<Shared>, headers: HeaderMap, Json(req): Json<RunRequest>) -> Response {
    if !crate::run::same_origin(&headers, s.port) {
        return fail(StatusCode::FORBIDDEN, "blocks only run from this server's own pages");
    }
    let page_dir = req.slug.as_deref().and_then(|slug| {
        let a = s.db.lock().expect("db lock").get(slug).ok().flatten()?;
        let ctx: Context = serde_json::from_str(&a.ctx).ok()?;
        ctx.cwd.or(ctx.repo_root)
    });
    let dir = match crate::run::resolve_dir(req.cwd.as_deref(), page_dir.as_deref()) {
        Ok(dir) => dir,
        Err(e) => return fail(StatusCode::UNPROCESSABLE_ENTITY, e),
    };
    let shell = crate::run::shell_for(req.shell.as_deref());
    let first = req.code.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    println!("run  {} · {} · {first}", req.slug.as_deref().unwrap_or("-"), dir.display());
    match crate::run::start(crate::run::Run { code: &req.code, shell, dir: &dir, slug: req.slug.as_deref() }) {
        Ok(body) => (
            [(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
            body,
        )
            .into_response(),
        Err(e) => fail(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        && !matches!(name, "raw" | "source")
        && !name.starts_with("r/")
}

async fn api_put_asset(State(s): State<Shared>, Path((slug, name)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> Response {
    if !valid_asset_name(&name) {
        return fail(StatusCode::BAD_REQUEST, format!("asset name {name:?} must be a relative path that is not raw, source or r/…"));
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_else(|| crate::content_type(&name))
        .to_string();
    let stored = s.db.lock().expect("db lock").put_asset(&slug, &name, &content_type, &body);
    match stored {
        Ok(true) => {
            announce(&s, json!({ "slug": slug, "asset": name }));
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, format!("no page {slug:?}")),
        Err(e) => db_error(e),
    }
}

fn render_page(s: &AppState, slug: &str, revision: Option<i64>) -> Response {
    let db = s.db.lock().expect("db lock");
    let a = match db.get(slug) {
        Ok(Some(a)) => a,
        Ok(None) => return (StatusCode::NOT_FOUND, Html(pages::not_found(&format!("No page {slug:?}")))).into_response(),
        Err(e) => return db_error(e),
    };
    let revisions = db.revisions(a.id).unwrap_or_default();
    let old = match revision {
        Some(n) => match db.revision(a.id, n) {
            Ok(Some(r)) => Some(r),
            Ok(None) => return (StatusCode::NOT_FOUND, Html(pages::not_found(&format!("{slug} has no revision {n}")))).into_response(),
            Err(e) => return db_error(e),
        },
        None => None,
    };
    let ctx: Context = serde_json::from_str(old.as_ref().map(|r| r.ctx.as_str()).unwrap_or(&a.ctx)).unwrap_or_default();
    let (newer, older) = db.neighbors(a.updated_at, a.id).unwrap_or_default();
    Html(pages::artifact(pages::View {
        artifact: &a,
        ctx: &ctx,
        revisions: &revisions,
        old: old.as_ref().map(|r| (r.revision, r.title.as_str(), r.html.as_str(), r.created_at)),
        newer,
        older,
    }))
    .into_response()
}

async fn page(State(s): State<Shared>, Path(slug): Path<String>) -> Response {
    render_page(&s, &slug, None)
}

/// `/a/<slug>/raw`, `/a/<slug>/source`, `/a/<slug>/r/<n>/[raw]`, and anything else is an asset,
/// so a page's relative `src="shots/x.png"` resolves without rewriting.
async fn page_rest(State(s): State<Shared>, Path((slug, rest)): Path<(String, String)>) -> Response {
    if let Some(after) = rest.strip_prefix("r/") {
        let (n, tail) = after.split_once('/').unwrap_or((after, ""));
        let Ok(n) = n.parse::<i64>() else {
            return fail(StatusCode::NOT_FOUND, "bad revision");
        };
        if !after.contains('/') {
            return Redirect::permanent(&format!("/a/{slug}/r/{n}/")).into_response();
        }
        return match tail {
            "" => render_page(&s, &slug, Some(n)),
            "raw" => {
                let db = s.db.lock().expect("db lock");
                match db.get(&slug).ok().flatten().and_then(|a| db.revision(a.id, n).ok().flatten()) {
                    Some(r) => Html(r.html).into_response(),
                    None => fail(StatusCode::NOT_FOUND, "no such revision"),
                }
            }
            asset => serve_asset(&s, &slug, asset),
        };
    }
    match rest.as_str() {
        "raw" | "source" => {
            let db = s.db.lock().expect("db lock");
            match db.get(&slug) {
                Ok(Some(a)) if rest == "raw" => Html(a.html).into_response(),
                Ok(Some(a)) => {
                    let ct = if a.kind == "code-path" { "application/json; charset=utf-8" } else { "text/plain; charset=utf-8" };
                    ([(header::CONTENT_TYPE, ct)], a.source).into_response()
                }
                Ok(None) => fail(StatusCode::NOT_FOUND, format!("no page {slug:?}")),
                Err(e) => db_error(e),
            }
        }
        asset => serve_asset(&s, &slug, asset),
    }
}

fn serve_asset(s: &AppState, slug: &str, name: &str) -> Response {
    match s.db.lock().expect("db lock").asset(slug, name) {
        Ok(Some((content_type, bytes))) => ([(header::CONTENT_TYPE, content_type)], bytes).into_response(),
        Ok(None) => fail(StatusCode::NOT_FOUND, format!("{slug} has no asset {name:?}")),
        Err(e) => db_error(e),
    }
}
