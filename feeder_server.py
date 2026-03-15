"""
Feeder HTTP server — HTTP-only, no internal scheduler.

- Runs on port 8080.
- POST /run  → executes the feeder pipeline once and returns JSON result.
- Scheduling is handled by cron_scheduler.py (single source of truth).
"""
import json
import os
import subprocess
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer

from dotenv import load_dotenv
load_dotenv()


# ---------------------------------------------------------------------------
# Internal helper: run the feeder pipeline as a subprocess
# ---------------------------------------------------------------------------
def _run_pipeline() -> dict:
    try:
        result = subprocess.run(
            ["python", "-m", "feeder.pipeline"],
            capture_output=True,
            text=True,
            timeout=300,
            env={
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
            },
        )
        success = result.returncode == 0
        return {
            "success": success,
            "log": result.stdout,
            "error": result.stderr if not success else "",
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Feeder pipeline timed out (5 min limit)"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class FeederHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/run":
            response = _run_pipeline()
            status = 200 if response["success"] else 500
            body = json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress noisy access logs


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def run():
    server = ThreadingHTTPServer(("0.0.0.0", 8080), FeederHandler)
    print("✅ Feeder HTTP server running on port 8080 (scheduling handled by cron_scheduler.py)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    run()
