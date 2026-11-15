#!/usr/bin/env bash
# 类型检查：用 TypeScript 的 allowJs+checkJs 检查纯 JS 代码。
#
# 纯 JS 项目没有编译器保护，注释里的类型错误、参数缺失、
# 未定义变量都只能靠人眼。这个脚本把这些交给 tsc。
#
# 用法：./test/typecheck.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/do-typecheck"

if [ ! -x "$WORK/node_modules/.bin/tsc" ]; then
  echo "→ 首次运行，安装 typescript 与 @types/node 到 $WORK"
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
  echo "✅ 类型检查通过"
  exit 0
fi

echo "$OUT"
echo
echo "❌ 类型检查发现问题"
exit 1
