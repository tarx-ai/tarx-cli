#!/bin/bash
# TARX keep-warm — base GGUF tarx-brain-qwen-27b on 127.0.0.1:11445.
# Sends one tiny completion to keep the first-token path hot (prevents the
# cold-load latency cliff; separate from launchd KeepAlive which only keeps the
# PROCESS alive). Invoked every 5 min by com.tarx.founder-brain-qwen-keepwarm.
#
# SECURITY: the bearer is read from the key file into a shell var and sent via
# curl -H. It is never echoed, never logged, and the header/file are never
# printed. Only HTTP status + timestamp are logged.

set -u

KEY_FILE="$HOME/.tarx/founder-brain/qwen-api-key"
LOG="$HOME/.tarx/logs/qwen-keep-warm.log"
URL="http://127.0.0.1:11445/v1/chat/completions"
TS=$(date '+%Y-%m-%d %H:%M:%S')

mkdir -p "$(dirname "$LOG")"

if [ ! -r "$KEY_FILE" ]; then
  echo "[$TS] keep-warm SKIP: key file not readable" >> "$LOG"
  exit 0
fi

# Read key into variable; strip any trailing newline. Never printed.
KEY=$(tr -d '\r\n' < "$KEY_FILE")
if [ -z "$KEY" ]; then
  echo "[$TS] keep-warm SKIP: empty key" >> "$LOG"
  exit 0
fi

code=$(curl -s -m 180 -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${KEY}" \
  -d '{"model":"tarx-brain-qwen-27b","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}' 2>/dev/null)

unset KEY

echo "[$TS] keep-warm HTTP ${code:-000}" >> "$LOG"
exit 0
