#!/bin/sh
# Regenerates the proof-mining export fixtures with Lean 4.35.0.
# Usage: LEAN_HOME=<Lean 4.35.0 install or stage1 build> sh generate.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here"/lean/*.lean "$work"/
cd "$work"
export PATH="$LEAN_HOME/bin:$PATH" LEAN_PATH="$LEAN_HOME/lib/lean:$work"
test "$(lean --version | cut -d' ' -f3 | tr -d ,)" = "4.35.0"
lean -o Task.olean Task.lean
leanexport Task -- NIR.statement > "$here/task.ndjson"
for module in Valid Sorry ExtraAxiom NativeDecide OtherStatement UnfoldedType; do
  lean -o "$module.olean" "$module.lean" > /dev/null
  leanexport "$module" -- NIR.solution > "$here/$(echo "$module" | tr '[:upper:]' '[:lower:]').ndjson"
done
lean -o Axioms.olean Axioms.lean
leanexport Axioms -- usesAll > "$here/axioms.ndjson"
