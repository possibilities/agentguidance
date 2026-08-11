#!/bin/bash
# Re-survey sweep: walk the local checkouts, resolve upstreams, diff our open
# requests against the watched set. Emits only NEW-REQUEST / GONE.
#
# Ships with the skill and takes no arguments: everything machine-specific
# lives in the scratchpad below. Run it with `bash <path-to-this-script>`.

SD="${XDG_STATE_HOME:-$HOME/.local/state}/watch-requests"
mkdir -p "$SD/state"
UPSTREAMS="$SD/upstreams"          # cached resolved upstream set
SEEN="$SD/seen-requests"           # the watched set; poll.sh reads this
CHECKOUTS_SIG="$SD/checkouts.sig"
INTERVAL="${WATCH_REQUESTS_INTERVAL:-600}"

resolve_upstreams() {
  # A remote owned by someone else is the upstream; our fork points at a parent.
  for d in "$HOME"/code/*/ "$HOME"/src/*/; do
    [ -e "$d/.git" ] || continue
    git -C "$d" remote -v 2>/dev/null | awk '/\(fetch\)/{print $2}' | while read -r url; do
      slug=$(sed -E 's#^git@github.com:#(#; s#^https://github.com/##; s#^\(##; s#\.git$##' <<<"$url")
      case "$slug" in */*) ;; *) continue ;; esac
      if [ "${slug%%/*}" != "$(gh api user --jq .login 2>/dev/null)" ]; then
        echo "$slug"
      else
        gh api "repos/$slug" --jq '.parent.full_name // empty' 2>/dev/null
      fi
    done
  done | sort -u | grep -v '^$' | while read -r up; do
    # Drop archived upstreams here, at collection: an archived repository can
    # never merge or close anything, so a request against one is unactionable
    # rather than pending, and every stage downstream stays free of the case.
    [ "$(gh api "repos/$up" --jq '.archived' 2>/dev/null)" = "true" ] && continue
    echo "$up"
  done
}

while true; do
  # Re-resolve upstreams only when the set of checkouts changed; the walk is
  # the expensive half, listing our requests per upstream is the cheap half.
  sig=$(ls -d "$HOME"/code/*/ "$HOME"/src/*/ 2>/dev/null | cksum)
  if [ ! -s "$UPSTREAMS" ] || [ "$sig" != "$(cat "$CHECKOUTS_SIG" 2>/dev/null)" ]; then
    if resolve_upstreams > "$UPSTREAMS.tmp" 2>/dev/null && [ -s "$UPSTREAMS.tmp" ]; then
      mv "$UPSTREAMS.tmp" "$UPSTREAMS"
      printf '%s\n' "$sig" > "$CHECKOUTS_SIG"
    else
      rm -f "$UPSTREAMS.tmp"
    fi
  fi

  cur=""
  ok=1
  while read -r up; do
    [ -n "$up" ] || continue
    if out=$(gh pr list --repo "$up" --author @me --state open --json number --jq '.[].number' 2>/dev/null); then
      for n in $out; do cur="$cur$up#$n"$'\n'; done
    else
      ok=0   # a failed listing is missing data, never an empty upstream
    fi
  done < "$UPSTREAMS"

  # Never diff against a partial sweep: a transient API failure would read as
  # every request on that upstream having vanished.
  if [ "$ok" = 1 ]; then
    cur=$(printf '%s' "$cur" | sort -u | grep -v '^$')
    prev=$(sort -u "$SEEN" 2>/dev/null)
    if [ -s "$SEEN" ]; then
      comm -13 <(printf '%s\n' "$prev") <(printf '%s\n' "$cur") | while read -r r; do
        [ -n "$r" ] && echo "SURVEY NEW-REQUEST $r — folding into the watch; read its current state, it may already carry a review or a red run"
      done
      comm -23 <(printf '%s\n' "$prev") <(printf '%s\n' "$cur") | while read -r r; do
        [ -n "$r" ] && echo "SURVEY GONE $r — left the open set (merged or closed); handle the aftermath, then prune its state file"
      done
    fi
    printf '%s\n' "$cur" > "$SEEN"
  fi

  sleep "$INTERVAL"
done
