#!/bin/bash

set -euo pipefail

real_git=${MAINTAIN_REAL_GIT:?}
trigger=${MAINTAIN_RACE_TRIGGER:-push}

for argument in "$@"; do
    if [ "$argument" = "$trigger" ] \
        && mkdir "${MAINTAIN_RACE_LOCK:?}" 2>/dev/null; then
        case "${MAINTAIN_RACE_ACTION:-update-ref}" in
            update-ref)
                "$real_git" --git-dir="${MAINTAIN_RACE_REPO:?}" update-ref \
                    "${MAINTAIN_RACE_REF:?}" "${MAINTAIN_RACE_SHA:?}"
                ;;
            write-pr-fixture)
                printf '%s\n' "${MAINTAIN_RACE_PR_LINES:?}" \
                    >"${MAINTAIN_RACE_PR_FILE:?}"
                ;;
            *)
                printf 'race-git: unknown action: %s\n' \
                    "$MAINTAIN_RACE_ACTION" >&2
                exit 64
                ;;
        esac
        break
    fi
done

exec "$real_git" "$@"
