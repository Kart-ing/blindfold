#!/bin/zsh
# Switch the live agent + panel between the demo fixture and the user's real ledger, without resetting either.
# Usage: scripts/live-db.sh demo|real      (runs whatever commit the live worktree is pinned to; see stage-deploy.sh)
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="$(dirname "$REPO")/fin-agent-live"
LOGS="${STAGE_LOGS:-$REPO/data}"
case "${1:-}" in
  demo) export FIN_DB="$REPO/data/fin.db" ;;
  real) export FIN_DB="$REPO/data/real.db" ;;
  *) echo "usage: $0 demo|real" >&2; exit 2 ;;
esac
[ -f "$FIN_DB" ] || { echo "[live-db] $FIN_DB doesn't exist" >&2; exit 1; }
[ -d "$LIVE" ] || { echo "[live-db] no live worktree; run scripts/stage-deploy.sh first" >&2; exit 1; }

"$REPO/scripts/gate.sh" ensure || echo "[warn] privacy gate down: cloud features will fail closed"
pkill -f "src/main.ts --live" 2>/dev/null || true
for port in 4545 4546; do lsof -ti tcp:$port | xargs kill 2>/dev/null || true; done
sleep 1
(cd "$LIVE" && nohup bun run src/panel/server.ts > "$LOGS/panel.log" 2>&1 &)
(cd "$LIVE" && nohup bun run src/main.ts --live --stage > "$LOGS/live.log" 2>&1 &)
sleep 6
echo "[live-db] $1 → $FIN_DB at $(git -C "$LIVE" log --oneline -1)"
grep -E "\[check\]|handlers loaded|watching" "$LOGS/live.log" || true
curl -s -o /dev/null -w "[live-db] panel http://127.0.0.1:4545 → %{http_code}\n" 127.0.0.1:4545/
