#!/bin/sh
# tarx glyph — status of the local Glyph flywheel. Does not stop it.
set -u
PLIST="$HOME/Library/LaunchAgents/com.tarx.autonomy.plist"
LOG="$HOME/.tarx/logs/autonomy.out.log"
UID_N=$(id -u)

base=$(plutil -extract EnvironmentVariables.GLYPH_BASE_URL raw "$PLIST" 2>/dev/null || echo missing)
model=$(plutil -extract EnvironmentVariables.GLYPH_MODEL raw "$PLIST" 2>/dev/null || echo missing)
guard=$(plutil -extract EnvironmentVariables.GLYPH_SPEND_GUARD raw "$PLIST" 2>/dev/null || echo missing)
state=$(launchctl print "gui/${UID_N}/com.tarx.autonomy" 2>/dev/null | awk -F'= ' '/^\tstate = /{print $2; exit}')
pid=$(launchctl print "gui/${UID_N}/com.tarx.autonomy" 2>/dev/null | awk -F'= ' '/^\tpid = /{print $2; exit}')

echo "TARX glyph"
echo "  loop     ${state:-down}  pid ${pid:-none}"
echo "  model    $model"
echo "  guard    $guard"
if printf '%s' "$base" | grep -q '127.0.0.1:11450'; then
  echo "  door     local gateway :11450"
elif printf '%s' "$base" | grep -q 'compute.tarx.com'; then
  echo "  door     BLOCKED  base is compute.tarx.com"
else
  echo "  door     $base"
fi
if [ -f "$LOG" ]; then
  echo "  last"
  tail -n 3 "$LOG" | sed 's/^/    /'
else
  echo "  last     no log"
fi
