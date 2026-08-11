#!/bin/bash
# Status poll: read each watched request and emit only NAMED EVENTS.
# Silence is the steady state.
#
# Ships with the skill and takes no arguments. The watched set comes from the
# scratchpad (maintained by resurvey.sh), never from this file — a request
# list baked into the script would be machine state masquerading as code.
# Run it with `bash <path-to-this-script>`.

SD="${XDG_STATE_HOME:-$HOME/.local/state}/watch-requests"
mkdir -p "$SD/state"
SEEN="$SD/seen-requests"
GATES="$SD/gates"                 # optional: "npm:<package>:<last-version>"
INTERVAL="${WATCH_REQUESTS_INTERVAL:-600}"
ME="$(gh api user --jq .login 2>/dev/null)"

fetch() {
  gh pr view "$2" --repo "$1" \
    --json state,mergeable,mergeStateStatus,reviewDecision,headRefOid,comments,reviews,statusCheckRollup 2>/dev/null
}

while true; do
  while read -r req; do
    [ -n "$req" ] || continue
    repo="${req%%#*}"; num="${req##*#}"
    key="$(echo "${repo}_${num}" | tr '/' '_')"
    prev="$(cat "$SD/state/$key" 2>/dev/null)"

    j="$(fetch "$repo" "$num")" || true
    [ -z "$j" ] && continue

    state=$(jq -r '.state' <<<"$j")
    merge=$(jq -r '.mergeable' <<<"$j")
    mss=$(jq -r '.mergeStateStatus' <<<"$j")

    # UNKNOWN is missing data, never a state: re-read once, then carry forward.
    if [ "$merge" = "UNKNOWN" ]; then
      sleep 20
      j2="$(fetch "$repo" "$num")" || true
      if [ -n "$j2" ]; then
        j="$j2"
        state=$(jq -r '.state' <<<"$j"); merge=$(jq -r '.mergeable' <<<"$j"); mss=$(jq -r '.mergeStateStatus' <<<"$j")
      fi
      [ "$merge" = "UNKNOWN" ] && merge="$(cut -d'|' -f2 <<<"$prev")"
    fi

    # A rollup mid-run is pending, never a failure.
    ci=$(jq -r '[.statusCheckRollup[]? | select(.name != null)] as $c
      | if ($c | length) == 0 then "NONE"
        elif ($c | map(select(.status != null and .status != "COMPLETED")) | length) > 0 then "PENDING"
        elif ($c | map(select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "CANCELLED" or .conclusion == "STARTUP_FAILURE")) | length) > 0 then "FAILING"
        else "GREEN" end' <<<"$j")

    rd=$(jq -r '.reviewDecision // ""' <<<"$j")
    # Only what someone other than us wrote: our own replies are not events.
    othercom=$(jq -r --arg me "$ME" '[.comments[]? | select(.author.login != $me)] | length' <<<"$j")
    revs=$(jq -r --arg me "$ME" '[.reviews[]? | select(.author.login != $me)]
      | group_by(.author.login) | map((.[-1].author.login) + ":" + (.[-1].state)) | sort | join(",")' <<<"$j")

    cur="$state|$merge|$mss|$ci|$rd|$othercom|$revs"

    # A request with no recorded baseline is seeded silently. Guessing a
    # baseline is a false alarm already loaded; resurvey.sh has announced it.
    if [ -z "$prev" ]; then
      printf '%s\n' "$cur" > "$SD/state/$key"
      continue
    fi
    [ "$cur" = "$prev" ] && continue

    p_state=$(cut -d'|' -f1 <<<"$prev"); p_mss=$(cut -d'|' -f3 <<<"$prev")
    p_ci=$(cut -d'|' -f4 <<<"$prev"); p_com=$(cut -d'|' -f6 <<<"$prev"); p_revs=$(cut -d'|' -f7 <<<"$prev")

    [ "$state" != "$p_state" ] && echo "EVENT MERGE-OR-CLOSE $repo#$num: $p_state -> $state"
    [ "$ci" = "FAILING" ] && [ "$p_ci" != "FAILING" ] && echo "EVENT CI-FAILING $repo#$num"
    [ "$revs" != "$p_revs" ] && [ -n "$revs" ] && echo "EVENT REVIEW $repo#$num: $revs (was: ${p_revs:-none})"
    [ "${othercom:-0}" -gt "${p_com:-0}" ] 2>/dev/null && echo "EVENT COMMENT $repo#$num: $((othercom - p_com)) new from someone other than us"
    case "$mss" in
      BEHIND|DIRTY) [ "$mss" != "$p_mss" ] && echo "EVENT STALE-OR-CONFLICTING $repo#$num: $mss" ;;
    esac

    printf '%s\n' "$cur" > "$SD/state/$key"
  done < <(cat "$SEEN" 2>/dev/null)

  # Release gates: a fork standing in for a published package retires at the
  # release, not the merge. One line per gate, "npm:<package>:<last-version>".
  if [ -s "$GATES" ]; then
    tmp="$GATES.tmp"; : > "$tmp"
    while IFS=: read -r kind pkg last; do
      [ "$kind" = "npm" ] || { [ -n "$kind" ] && printf '%s\n' "$kind:$pkg:$last" >> "$tmp"; continue; }
      now="$(npm view "$pkg" version 2>/dev/null || true)"
      if [ -n "$now" ] && [ "$now" != "$last" ]; then
        echo "EVENT RELEASE $pkg: $last -> $now — confirm the fix is actually in it (changelog, tag, or diff), a version bump alone is not evidence"
        printf '%s\n' "npm:$pkg:$now" >> "$tmp"
      else
        printf '%s\n' "npm:$pkg:${last}" >> "$tmp"
      fi
    done < "$GATES"
    mv "$tmp" "$GATES"
  fi

  sleep "$INTERVAL"
done
