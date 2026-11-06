#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"
LABEL="com.local.codexreach.youtube-monitor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cd "$ROOT"
[[ -f "$ROOT/dist/src/youtube-monitor/run.js" ]] || { echo '请先运行 npm run build'; exit 1; }
# Check ABI compatibility without modifying shared node_modules or touching the live database.
"$NODE" --input-type=module -e 'import Database from "better-sqlite3"; new Database(":memory:").close();'
"$NODE" --env-file=.env --input-type=module -e 'import {readYouTubeConfig} from "./dist/src/youtube-monitor/config.js"; if(!readYouTubeConfig(process.env))throw Error("YouTube monitor is disabled");'
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.data"
python3 - "$PLIST" "$NODE" "$ROOT" "$LABEL" <<'PY'
import os, plistlib, sys
plist, node, root, label = sys.argv[1:]
with open(plist, 'wb') as f:
    plistlib.dump({
        'Label': label,
        'ProgramArguments': [node, root + '/dist/src/youtube-monitor/run.js'],
        'WorkingDirectory': root,
        'RunAtLoad': True,
        'KeepAlive': {'SuccessfulExit': False},
        'ThrottleInterval': 60,
        'StandardOutPath': root + '/.data/youtube-monitor.log',
        'StandardErrorPath': root + '/.data/youtube-monitor.error.log',
    }, f)
os.chmod(plist, 0o600)
PY
plutil -lint "$PLIST"
# Only replace this independent monitor; never restart the main CodexReach bot.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已启动独立 YouTube 监控服务：$LABEL"
