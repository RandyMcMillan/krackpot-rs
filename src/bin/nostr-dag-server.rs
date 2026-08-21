//! Serve the built demo site locally from `site/`.
//!
//! This is a small static file server for local preview. It expects `site/`
//! to contain the WASM build output and `index.html`, and it prints
//! `SERVER_URL=...` on startup.

use std::env;
use std::io;
use std::path::{Component, Path, PathBuf};

use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{error, info};

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3000;
const DEFAULT_SITE_DIR: &str = "site";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("server=info".parse()?),
        )
        .init();

    let host = env::var("HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let site_dir = env::var("SITE_DIR").unwrap_or_else(|_| DEFAULT_SITE_DIR.to_string());

    let addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&addr).await?;

    info!(%addr, site_dir = %site_dir, "nostr-dag server listening");
    println!("SERVER_URL=http://{addr}");

    loop {
        tokio::select! {
            result = listener.accept() => {
                let (stream, peer) = result?;
                let site_dir = site_dir.clone();
                tokio::spawn(async move {
                    if let Err(err) = handle_connection(stream, &site_dir).await {
                        error!(%peer, ?err, "request failed");
                    }
                });
            }
            _ = tokio::signal::ctrl_c() => {
                info!("shutdown requested");
                break;
            }
        }
    }

    Ok(())
}

async fn handle_connection(mut stream: TcpStream, site_dir: &str) -> io::Result<()> {
    let mut buffer = [0u8; 8192];
    let bytes_read = stream.read(&mut buffer).await?;
    if bytes_read == 0 {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or("/");

    let head_only = method == "HEAD";
    let response = if method != "GET" && method != "HEAD" {
        response_text(405, "Method Not Allowed", "Method Not Allowed", "text/plain; charset=utf-8")
    } else {
        match route_path(site_dir, path).await {
            Ok((body, content_type)) => response_bytes(200, "OK", body, content_type, head_only),
            Err(RouteError::NotFound) => {
                response_text(404, "Not Found", "Not Found", "text/plain; charset=utf-8")
            }
            Err(RouteError::BadRequest) => {
                response_text(400, "Bad Request", "Bad Request", "text/plain; charset=utf-8")
            }
            Err(RouteError::Io(err)) => {
                error!(?err, path = %path, "failed to read file");
                response_text(500, "Internal Server Error", "Internal Server Error", "text/plain; charset=utf-8")
            }
        }
    };

    stream.write_all(&response).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn route_path(site_dir: &str, path: &str) -> Result<(Vec<u8>, &'static str), RouteError> {
    let normalized = normalize_path(strip_query(path))?;
    let file_path = if normalized.is_empty() {
        PathBuf::from(site_dir).join("index.html")
    } else {
        let candidate = PathBuf::from(site_dir).join(&normalized);
        if fs::metadata(&candidate)
            .await
            .map(|meta| meta.is_dir())
            .unwrap_or(false)
        {
            candidate.join("index.html")
        } else {
            candidate
        }
    };

    let content_type = content_type_for_path(&file_path);
    let body = fs::read(&file_path).await.map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            RouteError::NotFound
        } else {
            RouteError::Io(err)
        }
    })?;

    Ok((body, content_type))
}

fn strip_query(path: &str) -> &str {
    path.split_once(['?', '#']).map(|(head, _)| head).unwrap_or(path)
}

fn normalize_path(path: &str) -> Result<PathBuf, RouteError> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }

    let mut out = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(RouteError::BadRequest),
        }
    }
    Ok(out)
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn response_text(status: u16, reason: &str, body: &str, content_type: &'static str) -> Vec<u8> {
    response_bytes(status, reason, body.as_bytes().to_vec(), content_type, false)
}

fn response_bytes(
    status: u16,
    reason: &str,
    body: Vec<u8>,
    content_type: &'static str,
    head_only: bool,
) -> Vec<u8> {
    let body_len = if head_only { 0 } else { body.len() };
    let body = if head_only { Vec::new() } else { body };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {body_len}\r\nConnection: close\r\n\r\n"
    )
    .into_bytes();
    response.extend_from_slice(&body);
    response
}

#[derive(Debug)]
enum RouteError {
    NotFound,
    BadRequest,
    Io(io::Error),
}
