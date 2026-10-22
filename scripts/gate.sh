#!/bin/zsh
# The local Laya privacy gate (gate/server.py on 127.0.0.1:8089). Cloud calls fail closed without it.
# Usage: scripts/gate.sh ensure | status | stop      (ensure = start it if /health doesn't answer, then wait for it)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="${STAGE_LOGS:-$REPO/data}"
set -a; . "$REPO/.env"; set +a          # LAYA_GATE_KEY lives in .env; server.py reads it from the environment
health() { curl -s -m 2 -H "Authorization: Bearer ${LAYA_GATE_KEY:-}" http://127.0.0.1:8089/health 2>/dev/null | grep -q '"ok": true'; }

case "${1:-status}" in
  status) health && echo "[gate] up" || { echo "[gate] DOWN"; exit 1; } ;;
  stop) pkill -f "gate/server.py" && echo "[gate] stopped" || echo "[gate] wasn't running" ;;
  ensure)
    if [ "${PRIVACY_GATE:-on}" = "off" ]; then echo "[gate] off (PRIVACY_GATE=off)"; exit 0; fi
    if health; then echo "[gate] up"; exit 0; fi
    [ -n "${LAYA_GATE_KEY:-}" ] || { echo "[gate] LAYA_GATE_KEY missing from .env" >&2; exit 1; }
    pkill -f "gate/server.py" 2>/dev/null
    (cd "$REPO" && nohup env LAYA_GATE_KEY="$LAYA_GATE_KEY" gate/.venv/bin/python -I gate/server.py > "$LOGS/gate.log" 2>&1 &)
    for _ in $(seq 1 60); do health && { echo "[gate] started"; exit 0; }; sleep 1; done
    echo "[gate] failed to start; see $LOGS/gate.log" >&2; exit 1 ;;
  *) echo "usage: $0 ensure|status|stop" >&2; exit 2 ;;
esac
