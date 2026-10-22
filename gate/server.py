"""Local privacy gate: the Laya PII classifier (goku-san/laya-experts, "pii" flavour, Apache-2.0) behind a tiny HTTP API.

Runs on this Mac only (127.0.0.1), behind a bearer key, so the agent can mark every person, address, account number,
email, phone number or amount in a message before anything goes to a cloud model. The rule-based span finder ships
with the model (demo/pii_demo.py) and must match the one it was trained with, so it's imported from the model folder.

  POST /detect {"text": "..."}  ->  {"entities": [{"text", "label", "score", "start", "end"}], "ms": N}
  GET  /health                  ->  {"ok": true}

Start: gate/.venv/bin/python -I gate/server.py   (reads LAYA_GATE_KEY, LAYA_MODEL_DIR, LAYA_GATE_PORT from the env)
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.environ.get("LAYA_MODEL_DIR", os.path.join(ROOT, "data", "models", "laya-experts"))
KEY = os.environ.get("LAYA_GATE_KEY", "")
PORT = int(os.environ.get("LAYA_GATE_PORT", "8089"))
MAX_CHARS = 4000

if not KEY:
    sys.exit("LAYA_GATE_KEY is not set; refusing to serve without a key")

sys.path.insert(0, os.path.join(MODEL_DIR, "demo"))  # the model's own span finder (-I drops cwd and PYTHONPATH)
from pii_demo import PiiRedactor  # noqa: E402

import torch  # noqa: E402  (installed with laya)

t0 = time.time()
# The local copy of the model, never a Hub download at request time. CPU, not Apple's GPU: torch's MPS backend
# crashed ("A command encoder is already encoding to this command buffer") on the second request; the model card's
# latency figures are CPU anyway. LAYA_DEVICE=mps to try the GPU again.
redactor = PiiRedactor(model=MODEL_DIR, subfolder="pii", device=os.environ.get("LAYA_DEVICE", "cpu"))
LOCK = threading.Lock()  # one inference at a time
print(f"[gate] Laya PII loaded in {time.time() - t0:.1f}s", flush=True)


def detect(text: str):
    started = time.time()
    with LOCK:
        result = redactor.detect(text, threshold=0.5, region="US")
    entities = [{"text": e.text, "label": e.label, "score": float(e.score), "start": e.start, "end": e.end}
                for e in result.entities]
    return {"entities": entities, "ms": round((time.time() - started) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        return self.headers.get("authorization", "") == f"Bearer {KEY}"

    def do_GET(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        if self.path != "/detect":
            return self._send(404, {"error": "not found"})
        try:
            length = min(int(self.headers.get("content-length", "0")), 64_000)
            text = str(json.loads(self.rfile.read(length) or b"{}").get("text", ""))[:MAX_CHARS]
            self._send(200, detect(text))
        except Exception as exc:  # the caller fails closed on any non-200
            self._send(500, {"error": type(exc).__name__})

    def log_message(self, *_):  # never log request bodies (they are the user's messages)
        pass


if __name__ == "__main__":
    print(f"[gate] listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
