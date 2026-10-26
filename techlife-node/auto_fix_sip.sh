#!/usr/bin/env bash
set -euo pipefail

cd /usr/src/Tech_dialer/techlife-node

FILE="views/agent/index.ejs"
ROUTE="routes/api.js"
STAMP="$(date +%Y%m%d_%H%M%S)"

echo "=== 1. Checking project ==="
test -f "$FILE" || { echo "Missing $FILE"; exit 1; }
test -f "$ROUTE" || { echo "Missing $ROUTE"; exit 1; }

echo "=== 2. Backing up files ==="
cp -a "$FILE" "$FILE.bak_$STAMP"
cp -a "$ROUTE" "$ROUTE.bak_$STAMP"
echo "Backups created with suffix: $STAMP"

echo "=== 3. Checking installed SIP.js ==="
node -e '
try {
  const p = require("./node_modules/sip.js/package.json");
  console.log("Installed SIP.js version:", p.version);
  console.log("Package entry:", p.module || p.main || "(not specified)");
} catch {
  console.log("SIP.js package not found in node_modules.");
}
'

echo "=== 4. Checking the exact broken URL ==="
if grep -Fq \
  'https://cdn.jsdelivr.net/npm/sip.js@0.21.2/lib/platform/web/sip.min.js' \
  "$FILE"; then
  echo "Broken URL confirmed."
  echo "Not replacing it with a guessed URL."
else
  echo "Exact URL not found; no frontend changes made."
fi

echo "=== 5. Backend provisioning route ==="
sed -n '1,100p' "$ROUTE"

echo "=== 6. SIP initialization ==="
sed -n '50,175p' "$FILE"

echo
echo "Inspection complete. No application code was changed."
echo "Share the output above to determine the correct patch."
