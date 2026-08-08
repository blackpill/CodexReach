#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
CODEX="$(command -v codex)"
BIN_DIR="$(dirname "$NODE")"
PLIST="$HOME/Library/LaunchAgents/com.local.feishu-codex-bridge.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/.data"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.local.feishu-codex-bridge</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/dist/src/server.js</string></array>
<key>WorkingDirectory</key><string>$ROOT</string>
<key>EnvironmentVariables</key><dict>
  <key>CODEX_BIN</key><string>$CODEX</string>
  <key>PATH</key><string>$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$ROOT/.data/bridge.log</string>
<key>StandardErrorPath</key><string>$ROOT/.data/bridge.error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.local.feishu-codex-bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已安装并启动。日志：$ROOT/.data/bridge.log"
