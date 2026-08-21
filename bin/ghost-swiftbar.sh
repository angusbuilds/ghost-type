#!/bin/bash
# SwiftBar entry point. SwiftBar runs plugins with a minimal environment, so we set PATH
# (so node + tmux resolve) and dispatch: no args → render the menu; args → run a ghost command.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
NODE="/opt/homebrew/bin/node"
GT="/Users/angus/dev/ghost-type"
if [ "$#" -eq 0 ]; then
  exec "$NODE" "$GT/bin/ghost-haunt-plugin.mjs"
else
  exec "$NODE" "$GT/bin/ghost.mjs" "$@"
fi
