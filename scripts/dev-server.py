#!/usr/bin/env python3
"""Serve Qujing's static dist/ locally with correct ES module and WASM MIME types.

Usage: python scripts/dev-server.py [--port 8000]
Bind only to loopback. For remote mobile access, deploy via HTTPS.
"""
import argparse
import mimetypes
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DIST = Path(__file__).resolve().parents[1] / "dist"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    mimetypes.add_type("text/javascript", ".mjs", strict=True)
    mimetypes.add_type("application/javascript", ".js", strict=True)
    mimetypes.add_type("application/wasm", ".wasm", strict=True)
    mimetypes.add_type("application/manifest+json", ".webmanifest", strict=True)
    mimetypes.add_type("application/octet-stream", ".tflite", strict=True)
    mimetypes.add_type("application/json", ".json", strict=True)
    handler = partial(SimpleHTTPRequestHandler, directory=str(DIST))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Qujing dev server: http://localhost:{args.port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
