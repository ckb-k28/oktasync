#!/usr/bin/env python3
"""
Lichtgewicht HTTP server voor het O365 Okta Sync Dashboard op poort 5555.
Serveert de gebouwde frontend (/app/dist) + /api/health endpoint zonder extra dependencies.
"""
import json
import mimetypes
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB_PORT = int(os.environ.get("WEB_PORT", "5555"))
DIST_DIR = os.environ.get("WEB_DIST_DIR", "/app/dist")
VAULT_FILE = os.environ.get("TOKEN_VAULT_FILE", "/vault/token_cache.enc")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class SpaRequestHandler(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        clean_path = self.path.split("?", 1)[0]

        if clean_path == "/api/health":
            payload = {
                "status": "ok",
                "port": WEB_PORT,
                "vault_present": os.path.exists(VAULT_FILE),
                "cron_schedule": os.environ.get("SYNC_CRON_SCHEDULE", "0 8-20/2 * * *"),
                "shared_folder": os.environ.get("O365_SHARED_FOLDER", "/02. Callsheets"),
                "ignored_folders": os.environ.get("O365_IGNORE_FOLDERS", "Callsheets Archief"),
            }
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if not os.path.isdir(DIST_DIR):
            fallback = (
                "<!doctype html><html lang='nl'><head><meta charset='utf-8'>"
                "<title>O365 Okta Sync</title></head><body style='font-family:sans-serif;padding:2rem'>"
                "<h1>O365 Okta Sync Container Actief (Poort 5555)</h1>"
                "<p>Frontend build (/app/dist) is niet aanwezig; de 2-uurlijkse Supercronic sync draait wel.</p>"
                "</body></html>"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(fallback)))
            self.end_headers()
            self.wfile.write(fallback)
            return

        dist_abs = os.path.abspath(DIST_DIR)
        requested = os.path.abspath(os.path.join(dist_abs, clean_path.lstrip("/")))
        if os.path.commonpath([dist_abs, requested]) != dist_abs or not os.path.isfile(requested):
            self.path = "/index.html"

        super().do_GET()

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    handler = partial(SpaRequestHandler, directory=DIST_DIR if os.path.isdir(DIST_DIR) else ".")
    server = ThreadingHTTPServer(("0.0.0.0", WEB_PORT), handler)
    print(f"[WEB] O365 Okta Sync UI actief op http://0.0.0.0:{WEB_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
