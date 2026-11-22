#!/usr/bin/env python3
"""
Lichtgewicht HTTP server voor het O365 Okta Sync Dashboard op poort 5555.
Serveert de gebouwde frontend (/app/dist) en biedt echte container-endpoints:
- GET  /api/health
- GET  /api/status
- GET  /api/files?path=/...          (strikte filebrowser binnen LOCAL_SYNC_DIR)
- GET  /api/files/download?path=/... (strikte download binnen LOCAL_SYNC_DIR)
- POST /api/sync
- POST /api/logs/clear
"""
import datetime
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import urllib.parse
from collections import deque
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB_PORT = int(os.environ.get("WEB_PORT", "5555"))
DIST_DIR = os.environ.get("WEB_DIST_DIR", "/app/dist")
LOCAL_SYNC_DIR = os.environ.get("LOCAL_SYNC_DIR", "/data/sync")
HOST_SYNC_DIR_LABEL = os.environ.get("HOST_SYNC_DIR", "/opt/docker/callsheets/data")
VAULT_FILE = os.environ.get("TOKEN_VAULT_FILE", "/vault/token_cache.enc")
COOKIE_VAULT = os.environ.get("COOKIE_VAULT_FILE", "/vault/sp_cookies.enc")
SYNC_SCRIPT = os.environ.get("SYNC_SCRIPT_PATH", "/app/sync.py")
SYNC_LOG_FILE = os.environ.get("SYNC_LOG_FILE", "/tmp/oktasync.log")

ALLOWED_SYNC_MODES = {
    "force": "--force",
    "verify": "--verify",
}
MAX_OUTPUT_LINES = 300
MAX_RUN_HISTORY = 15
SYNC_TIMEOUT_SECONDS = 600


def get_app_version() -> str:
    env_ver = os.environ.get("APP_VERSION", "").strip()
    if env_ver:
        return env_ver
    version_file = "/app/VERSION"
    if os.path.isfile(version_file):
        with open(version_file, "r", encoding="utf-8") as f:
            return f.read().strip() or "v.01"
    return "v.01"


APP_VERSION = get_app_version()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

SYNC_LOCK = threading.Lock()
SYNC_STATE: dict = {
    "running": False,
    "mode": None,
    "command": None,
    "started_at": None,
    "finished_at": None,
    "exit_code": None,
    "output_lines": [],
    "runs": [],
}


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def get_vault_info() -> tuple[bool, str | None, str | None]:
    for path, label in ((COOKIE_VAULT, "sp_cookies.enc"), (VAULT_FILE, "token_cache.enc")):
        if os.path.isfile(path):
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(path)).astimezone().isoformat(timespec="seconds")
            return True, label, mtime
    return False, None, None


def read_sync_log(max_lines: int = MAX_OUTPUT_LINES) -> str:
    if os.path.isfile(SYNC_LOG_FILE):
        try:
            with open(SYNC_LOG_FILE, "r", encoding="utf-8", errors="replace") as lf:
                tail = deque((line.rstrip("\r\n") for line in lf), maxlen=max_lines)
            if tail:
                return "\n".join(tail)
        except OSError:
            pass
    return "\n".join(SYNC_STATE["output_lines"])


def _get_sync_root_real() -> str:
    return os.path.realpath(LOCAL_SYNC_DIR)


def resolve_safe_sync_path(requested_rel_path: str) -> tuple[str, str]:
    """
    Lost een relatief pad strikt op binnen LOCAL_SYNC_DIR (/data/sync <-> /opt/docker/callsheets/data).
    Blokkeert '..', null-bytes, symlinks en pad-ontsnappingen.
    """
    if "\x00" in requested_rel_path:
        raise PermissionError("Ongeldig pad.")

    base_real = _get_sync_root_real()
    normalized = requested_rel_path.replace("\\", "/").strip()
    parts = [p for p in normalized.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise PermissionError("Toegang buiten /opt/docker/callsheets/data is geblokkeerd.")

    candidate_joined = os.path.join(base_real, *parts) if parts else base_real

    # Controleer dat geen enkel segment een symlink naar buiten is
    check_path = base_real
    for part in parts:
        check_path = os.path.join(check_path, part)
        if os.path.islink(check_path):
            raise PermissionError("Symlinks zijn niet toegestaan in de filebrowser.")

    target_real = os.path.realpath(candidate_joined)
    if target_real != base_real and not target_real.startswith(base_real + os.sep):
        raise PermissionError("Toegang buiten /opt/docker/callsheets/data is geblokkeerd.")

    clean_rel = "/" + "/".join(parts) if parts else "/"
    return target_real, clean_rel


def scan_local_files(limit: int = 200) -> tuple[list[dict], int, int]:
    base_real = _get_sync_root_real()
    if not os.path.isdir(base_real):
        return [], 0, 0

    items: list[dict] = []
    total_count = 0
    total_bytes = 0

    for root, dirs, filenames in os.walk(base_real, followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not os.path.islink(os.path.join(root, d))]
        for fname in filenames:
            if fname.startswith("."):
                continue
            full_path = os.path.join(root, fname)
            if os.path.islink(full_path):
                continue
            try:
                full_real = os.path.realpath(full_path)
                if not full_real.startswith(base_real + os.sep):
                    continue
                stat = os.stat(full_real)
            except OSError:
                continue

            total_count += 1
            total_bytes += stat.st_size
            rel_path = os.path.relpath(full_real, base_real).replace(os.sep, "/")
            mod_dt = datetime.datetime.fromtimestamp(stat.st_mtime).astimezone()
            items.append(
                {
                    "id": f"local-{rel_path}",
                    "name": fname,
                    "relativePath": f"/{rel_path}",
                    "sizeBytes": stat.st_size,
                    "modifiedAt": mod_dt.strftime("%d-%m %H:%M"),
                    "mtime": stat.st_mtime,
                    "status": "gesynchroniseerd",
                }
            )

    items.sort(key=lambda x: x["mtime"], reverse=True)
    for item in items[:limit]:
        item.pop("mtime", None)
    return items[:limit], total_count, total_bytes


def browse_directory(requested_rel_path: str) -> dict:
    base_real = _get_sync_root_real()
    target_real, clean_rel = resolve_safe_sync_path(requested_rel_path)

    if not os.path.isdir(base_real):
        return {
            "status": "ok",
            "root_label": HOST_SYNC_DIR_LABEL,
            "container_dir": LOCAL_SYNC_DIR,
            "current_path": "/",
            "parent_path": None,
            "exists": False,
            "entries": [],
            "total_files": 0,
            "total_bytes": 0,
        }

    if not os.path.isdir(target_real):
        raise FileNotFoundError(f"Map niet gevonden binnen {HOST_SYNC_DIR_LABEL}: {clean_rel}")

    entries: list[dict] = []
    with os.scandir(target_real) as it:
        for entry in it:
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_symlink():
                    continue
                entry_real = os.path.realpath(entry.path)
                if not entry_real.startswith(base_real + os.sep):
                    continue
                stat = entry.stat(follow_symlinks=False)
                mod_dt = datetime.datetime.fromtimestamp(stat.st_mtime).astimezone()
                rel_entry = "/" + os.path.relpath(entry_real, base_real).replace(os.sep, "/")

                if entry.is_dir(follow_symlinks=False):
                    sub_count = 0
                    try:
                        with os.scandir(entry_real) as sub_it:
                            sub_count = sum(1 for s in sub_it if not s.name.startswith(".") and not s.is_symlink())
                    except OSError:
                        sub_count = 0
                    entries.append(
                        {
                            "name": entry.name,
                            "path": rel_entry,
                            "type": "dir",
                            "sizeBytes": 0,
                            "itemCount": sub_count,
                            "modifiedAt": mod_dt.strftime("%d-%m %H:%M"),
                        }
                    )
                elif entry.is_file(follow_symlinks=False):
                    entries.append(
                        {
                            "name": entry.name,
                            "path": rel_entry,
                            "type": "file",
                            "sizeBytes": stat.st_size,
                            "modifiedAt": mod_dt.strftime("%d-%m %H:%M"),
                        }
                    )
            except OSError:
                continue

    entries.sort(key=lambda e: (0 if e["type"] == "dir" else 1, e["name"].lower()))

    if clean_rel == "/":
        parent_path = None
    else:
        parent_rel = clean_rel.rsplit("/", 1)[0]
        parent_path = parent_rel if parent_rel else "/"

    _, total_files, total_bytes = scan_local_files(limit=1)
    return {
        "status": "ok",
        "root_label": HOST_SYNC_DIR_LABEL,
        "container_dir": LOCAL_SYNC_DIR,
        "current_path": clean_rel,
        "parent_path": parent_path,
        "exists": True,
        "entries": entries,
        "total_files": total_files,
        "total_bytes": total_bytes,
    }


def get_state_snapshot(include_files: bool = True) -> dict:
    vault_present, vault_type, vault_updated_at = get_vault_info()
    with SYNC_LOCK:
        output_text = read_sync_log()
        payload = {
            "status": "ok",
            "version": APP_VERSION,
            "port": WEB_PORT,
            "vault_present": vault_present,
            "vault_type": vault_type,
            "vault_updated_at": vault_updated_at,
            "cron_schedule": os.environ.get("SYNC_CRON_SCHEDULE", "0 8-20/2 * * *"),
            "shared_folder": os.environ.get("O365_SHARED_FOLDER", "/02. Callsheets"),
            "ignored_folders": os.environ.get("O365_IGNORE_FOLDERS", "Callsheets Archief"),
            "local_sync_dir": LOCAL_SYNC_DIR,
            "host_sync_dir": HOST_SYNC_DIR_LABEL,
            "running": SYNC_STATE["running"],
            "mode": SYNC_STATE["mode"],
            "command": SYNC_STATE["command"],
            "started_at": SYNC_STATE["started_at"],
            "finished_at": SYNC_STATE["finished_at"],
            "exit_code": SYNC_STATE["exit_code"],
            "output": output_text,
            "runs": list(SYNC_STATE["runs"]),
        }

    if include_files:
        files, total_files, total_bytes = scan_local_files()
        payload["files"] = files
        payload["total_files"] = total_files
        payload["total_bytes"] = total_bytes

    return payload


def _append_output(line: str) -> None:
    clean = line.rstrip("\r\n")
    with SYNC_LOCK:
        SYNC_STATE["output_lines"].append(clean)
        if len(SYNC_STATE["output_lines"]) > MAX_OUTPUT_LINES:
            SYNC_STATE["output_lines"] = SYNC_STATE["output_lines"][-MAX_OUTPUT_LINES:]


def _run_sync_worker(mode: str, flag: str) -> None:
    exit_code = -1
    timed_out = False
    proc: subprocess.Popen | None = None
    timer: threading.Timer | None = None
    before_size = os.path.getsize(SYNC_LOG_FILE) if os.path.isfile(SYNC_LOG_FILE) else 0

    def _on_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        if proc and proc.poll() is None:
            proc.kill()

    try:
        if not os.path.isfile(SYNC_SCRIPT):
            _append_output(f"[FOUT] Sync script niet gevonden op {SYNC_SCRIPT}")
            exit_code = 127
        else:
            proc = subprocess.Popen(
                [sys.executable, "-u", SYNC_SCRIPT, flag],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            timer = threading.Timer(SYNC_TIMEOUT_SECONDS, _on_timeout)
            timer.daemon = True
            timer.start()

            if proc.stdout is not None:
                for raw_line in proc.stdout:
                    _append_output(raw_line)
                proc.stdout.close()

            exit_code = proc.wait()
            if timed_out:
                _append_output(f"[FOUT] Sync afgebroken na timeout van {SYNC_TIMEOUT_SECONDS} seconden.")
                exit_code = 124
    except Exception as exc:
        _append_output(f"[FOUT] Kan sync.py niet uitvoeren: {exc}")
        exit_code = 1
    finally:
        if timer is not None:
            timer.cancel()

        after_size = os.path.getsize(SYNC_LOG_FILE) if os.path.isfile(SYNC_LOG_FILE) else 0
        if exit_code != 0 and after_size == before_size and SYNC_STATE["output_lines"]:
            try:
                with open(SYNC_LOG_FILE, "a", encoding="utf-8") as lf:
                    for line in SYNC_STATE["output_lines"]:
                        lf.write(line + "\n")
            except OSError:
                pass

        finished_at = now_iso()
        with SYNC_LOCK:
            SYNC_STATE["running"] = False
            SYNC_STATE["finished_at"] = finished_at
            SYNC_STATE["exit_code"] = exit_code
            summary_line = ""
            for line in reversed(SYNC_STATE["output_lines"]):
                if line.strip():
                    summary_line = line.strip()
                    break
            SYNC_STATE["runs"].insert(
                0,
                {
                    "id": f"run-{int(datetime.datetime.now().timestamp() * 1000)}",
                    "mode": mode,
                    "command": SYNC_STATE["command"],
                    "started_at": SYNC_STATE["started_at"],
                    "finished_at": finished_at,
                    "exit_code": exit_code,
                    "summary": summary_line or ("Voltooid" if exit_code == 0 else "Mislukt"),
                },
            )
            SYNC_STATE["runs"] = SYNC_STATE["runs"][:MAX_RUN_HISTORY]


def start_sync_job(mode: str) -> tuple[bool, dict]:
    flag = ALLOWED_SYNC_MODES[mode]
    with SYNC_LOCK:
        if SYNC_STATE["running"]:
            started = False
        else:
            SYNC_STATE["running"] = True
            SYNC_STATE["mode"] = mode
            SYNC_STATE["command"] = f"python3 {SYNC_SCRIPT} {flag}"
            SYNC_STATE["started_at"] = now_iso()
            SYNC_STATE["finished_at"] = None
            SYNC_STATE["exit_code"] = None
            SYNC_STATE["output_lines"] = []
            started = True

    if started:
        worker = threading.Thread(target=_run_sync_worker, args=(mode, flag), daemon=True)
        worker.start()

    return started, get_state_snapshot(include_files=False)


def clear_logs() -> tuple[bool, dict]:
    with SYNC_LOCK:
        if SYNC_STATE["running"]:
            return False, {}
        SYNC_STATE["output_lines"] = []
        SYNC_STATE["runs"] = []
        SYNC_STATE["exit_code"] = None
        SYNC_STATE["command"] = None
        SYNC_STATE["mode"] = None
        SYNC_STATE["started_at"] = None
        SYNC_STATE["finished_at"] = None
        try:
            if os.path.isfile(SYNC_LOG_FILE):
                with open(SYNC_LOG_FILE, "w", encoding="utf-8"):
                    pass
        except OSError:
            pass
    return True, get_state_snapshot(include_files=True)


class SpaRequestHandler(SimpleHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_allowed_post_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urllib.parse.urlparse(origin)
        origin_host = parsed.netloc.lower()
        fwd_host = (self.headers.get("X-Forwarded-Host") or "").split(",")[0].strip().lower()
        allowed_hosts = {
            (self.headers.get("Host") or "").strip().lower(),
            fwd_host,
        }
        allowed_hosts.discard("")
        return origin_host in allowed_hosts

    def do_GET(self) -> None:
        parsed_url = urllib.parse.urlparse(self.path)
        clean_path = parsed_url.path
        query_params = urllib.parse.parse_qs(parsed_url.query)

        if clean_path == "/api/health":
            vault_present, vault_type, _ = get_vault_info()
            with SYNC_LOCK:
                sync_running = SYNC_STATE["running"]
            self._send_json(
                200,
                {
                    "status": "ok",
                    "version": APP_VERSION,
                    "port": WEB_PORT,
                    "vault_present": vault_present,
                    "vault_type": vault_type,
                    "sync_running": sync_running,
                    "cron_schedule": os.environ.get("SYNC_CRON_SCHEDULE", "0 8-20/2 * * *"),
                    "shared_folder": os.environ.get("O365_SHARED_FOLDER", "/02. Callsheets"),
                    "ignored_folders": os.environ.get("O365_IGNORE_FOLDERS", "Callsheets Archief"),
                    "local_sync_dir": LOCAL_SYNC_DIR,
                    "host_sync_dir": HOST_SYNC_DIR_LABEL,
                },
            )
            return

        if clean_path == "/api/status":
            self._send_json(200, get_state_snapshot(include_files=True))
            return

        if clean_path == "/api/files":
            req_path = query_params.get("path", ["/"])[0]
            try:
                listing = browse_directory(req_path)
                self._send_json(200, listing)
            except PermissionError as exc:
                self._send_json(403, {"status": "error", "error": str(exc)})
            except FileNotFoundError as exc:
                self._send_json(404, {"status": "error", "error": str(exc)})
            return

        if clean_path == "/api/files/download":
            req_path = query_params.get("path", [""])[0]
            if not req_path:
                self._send_json(400, {"status": "error", "error": "Bestandspad ontbreekt"})
                return
            try:
                target_real, _ = resolve_safe_sync_path(req_path)
            except PermissionError as exc:
                self._send_json(403, {"status": "error", "error": str(exc)})
                return

            if not os.path.isfile(target_real) or os.path.islink(target_real):
                self._send_json(404, {"status": "error", "error": "Bestand niet gevonden"})
                return

            fname = os.path.basename(target_real)
            safe_ascii = re.sub(r'[^A-Za-z0-9._ -]', '_', fname)
            mime_type, _ = mimetypes.guess_type(target_real)
            try:
                file_size = os.path.getsize(target_real)
                with open(target_real, "rb") as f:
                    self.send_response(200)
                    self.send_header("Content-Type", mime_type or "application/octet-stream")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header(
                        "Content-Disposition",
                        f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{urllib.parse.quote(fname)}",
                    )
                    self.send_header("Content-Length", str(file_size))
                    self.end_headers()
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except OSError as exc:
                self._send_json(500, {"status": "error", "error": f"Kan bestand niet lezen: {exc}"})
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

    def do_POST(self) -> None:
        clean_path = self.path.split("?", 1)[0]

        if clean_path not in ("/api/sync", "/api/logs/clear"):
            self._send_json(404, {"status": "error", "error": "Onbekend endpoint"})
            return

        if not self._is_allowed_post_origin():
            self._send_json(403, {"status": "error", "error": "Niet-toegestane herkomst (Origin mismatch)"})
            return

        try:
            content_length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            self._send_json(400, {"status": "error", "error": "Ongeldige Content-Length header"})
            return

        if content_length < 0 or content_length > 4096:
            self._send_json(413, {"status": "error", "error": "Request body te groot"})
            return

        if clean_path == "/api/logs/clear":
            if content_length > 0:
                self.rfile.read(content_length)
            cleared, snapshot = clear_logs()
            if not cleared:
                self._send_json(
                    409,
                    {"status": "error", "error": "Kan log niet wissen zolang er een synchronisatie actief is."},
                )
                return
            snapshot["logs_cleared"] = True
            self._send_json(200, snapshot)
            return

        mode = "force"
        if content_length > 0:
            raw_body = self.rfile.read(content_length)
            try:
                body_json = json.loads(raw_body.decode("utf-8"))
                if isinstance(body_json, dict) and "mode" in body_json:
                    mode = str(body_json["mode"]).strip().lower()
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"status": "error", "error": "Ongeldige JSON payload"})
                return

        if mode not in ALLOWED_SYNC_MODES:
            self._send_json(
                400,
                {
                    "status": "error",
                    "error": f"Ongeldige sync-modus '{mode}'. Kies uit: {', '.join(sorted(ALLOWED_SYNC_MODES))}",
                },
            )
            return

        started, snapshot = start_sync_job(mode)
        if not started:
            snapshot["sync_status"] = "already_running"
            self._send_json(409, snapshot)
            return

        snapshot["sync_status"] = "started"
        self._send_json(202, snapshot)

    def log_message(self, format: str, *args) -> None:
        return


def main() -> None:
    handler = partial(SpaRequestHandler, directory=DIST_DIR if os.path.isdir(DIST_DIR) else ".")
    server = ThreadingHTTPServer(("0.0.0.0", WEB_PORT), handler)
    print(f"[WEB] O365 Okta Sync UI actief op http://0.0.0.0:{WEB_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
