#!/bin/zsh
# Stage deploy: pin the live worktree to a commit, reset the demo data, restart panel + live agent, check readiness,
# then rehearse that same commit on a throwaway DB. Only committed code goes live; the shared checkout can be mid-edit.
# Usage: scripts/stage-deploy.sh [commit]   (default: HEAD of this checkout)
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIVE="$(dirname "$REPO")/fin-agent-live"
LOGS="${STAGE_LOGS:-$REPO/data}"
COMMIT="$(git -C "$REPO" rev-parse "${1:-HEAD}")"
export FIN_DB="$REPO/data/fin.db" # the panel and the agent share the main checkout's DB

if [ ! -d "$LIVE" ]; then git -C "$REPO" worktree add --detach "$LIVE" "$COMMIT"; fi
git -C "$LIVE" checkout --detach -q "$COMMIT"
ln -sfn "$REPO/node_modules" "$LIVE/node_modules"
ln -sf "$REPO/.env" "$LIVE/.env"
mkdir -p "$LIVE/bin" && cp "$REPO/bin/fm" "$LIVE/bin/fm"
echo "[stage] live worktree at $(git -C "$LIVE" log --oneline -1)"

"$REPO/scripts/gate.sh" ensure || echo "[warn] privacy gate down: cloud features will fail closed"
# Stop the old processes (both ports), reset demo data in place, start fresh.
pkill -f "src/main.ts --live" 2>/dev/null || true
for port in 4545 4546; do lsof -ti tcp:$port | xargs kill 2>/dev/null || true; done
sleep 1
(cd "$LIVE" && bun run scripts/reset.ts)
(cd "$LIVE" && nohup bun run src/panel/server.ts > "$LOGS/panel.log" 2>&1 &)
(cd "$LIVE" && nohup bun run src/main.ts --live --stage > "$LOGS/live.log" 2>&1 &)
sleep 6
grep -E "\[check\]|handlers loaded|watching|warm" "$LOGS/live.log" || true
curl -s -o /dev/null -w "[stage] panel http://127.0.0.1:4545 → %{http_code}\n" 127.0.0.1:4545/

# Rehearse the same commit on its own throwaway DB (rehearse never touches FIN_DB), deterministic voice.
(cd "$LIVE" && env -u FIN_DB VOICE=plain bun run scripts/rehearse.ts) | tail -15
echo "[stage] live log: $LOGS/live.log"
