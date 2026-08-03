#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "usage: $0 <sum_...> [--apply] [recovery options...]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
remote_host="${NIRI_PROD_HOST:-10.0.0.112}"
remote_user="${NIRI_PROD_USER:-niri}"
remote_harness="${NIRI_PROD_HARNESS:-/home/niri/harness}"

quoted_args=()
for arg in "$@"; do
  quoted_args+=("$(printf '%q' "$arg")")
done

remote_command="cd $(printf '%q' "$remote_harness") && set -euo pipefail; tmp=\$(mktemp /tmp/niri-compaction-recovery.XXXXXX.ts); trap 'rm -f \"\$tmp\"' EXIT; cat > \"\$tmp\"; node --import tsx \"\$tmp\" ${quoted_args[*]}"
sudo_command="sudo -u $(printf '%q' "$remote_user") -H bash -lc $(printf '%q' "$remote_command")"

# Stream the local recovery runner into a mode-600 remote temporary file. This
# keeps the procedure usable before the helper itself has been deployed there.
exec ssh -o BatchMode=yes "$remote_host" "$sudo_command" < "$script_dir/recover-compaction.ts"
