#!/usr/bin/env bash
# Type check: run TypeScript's allowJs+checkJs over plain JS sources.
#
# A plain-JS project gets no compiler protection: wrong types in JSDoc, missing
# arguments and undefined variables all fall to a human reader. This hands that
# job to tsc.
#
# Usage: ./test/typecheck.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/do-typecheck"

if [ ! -x "$WORK/node_modules/.bin/tsc" ]; then
  echo "-> First run: installing typescript and @types/node into $WORK"
  mkdir -p "$WORK"
  ( cd "$WORK" && npm install --silent typescript@5 @types/node@22 >/dev/null 2>&1 )
fi

cat > "$WORK/jsconfig.json" <<EOF
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": false,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "typeRoots": ["$WORK/node_modules/@types"],
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["$ROOT/lib/*.js", "$ROOT/host.js"]
}
EOF

OUT="$("$WORK/node_modules/.bin/tsc" -p "$WORK/jsconfig.json" 2>&1 | grep -v "Cannot find module 'electron'" || true)"

if [ -z "$OUT" ]; then
  echo "✅ Type check passed"
  exit 0
fi

echo "$OUT"
echo
echo "❌ Type check found problems"
exit 1
