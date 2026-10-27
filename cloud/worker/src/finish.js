// finish.sh: run by the Session DO in the box after Claude has exited and every process of user agent is killed.
// It lives here, not in the box, so nothing the agent did can change it. The box holds a `finish` grant
// (push + PR) only while this runs. Output: one JSON line per result.
//
// The agent could have left traps in files git, curl and jq read on their own, so none of them are trusted:
// - a fresh empty HOME (and XDG_CONFIG_HOME), so ~/.gitconfig, ~/.curlrc, ~/.jq and ~/.netrc are never read
// - GIT_CONFIG_NOSYSTEM=1, and .git/config rebuilt from scratch, which drops core.fsmonitor, filter drivers,
//   aliases, includes, url rewrites, pagers, credential helpers and anything else the agent wrote there
// - hooks off (core.hooksPath=/dev/null), and .git must be a real directory, not a symlink or gitdir file
export const FINISH_SH = String.raw`
set -eo pipefail
cd /workspace

H=$(mktemp -d)
export HOME="$H" XDG_CONFIG_HOME="$H" GIT_CONFIG_NOSYSTEM=1
if [ ! -d .git ] || [ -L .git ]; then echo "workspace .git is not a plain directory" >&2; exit 1; fi
cat > .git/config <<CFG
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
[remote "origin"]
	url = https://github.com/$REPO.git
	fetch = +refs/heads/*:refs/remotes/origin/*
CFG

emit() { jq -nc "$@"; }
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=agentbox -c user.email=agentbox@localhost "$@"; }

g add -A
if ! g diff --cached --quiet; then g commit -q -m "agentbox $SESSION: $MSG"; fi

if [ "$(g rev-list --count "origin/$BASE..HEAD")" = 0 ]; then emit '{agentbox:"nochanges"}'; exit 0; fi
if [ "$(g rev-parse -q --verify "refs/remotes/origin/$BRANCH" || true)" = "$(g rev-parse HEAD)" ]; then emit '{agentbox:"nonew"}'; exit 0; fi

emit --arg s "$(g diff --shortstat "origin/$BASE..HEAD")" '{agentbox:"diffstat",stat:$s}'
g push -q origin "HEAD:refs/heads/$BRANCH"

if [ -n "$PR_URL" ]; then emit --arg u "$PR_URL" '{agentbox:"pr",url:$u,updated:true}'; exit 0; fi
BODY=$(jq -nc --arg t "$TITLE" --arg h "$BRANCH" --arg b "$BASE" --arg body "$PRBODY" '{title:$t,head:$h,base:$b,body:$body}')
RESP=$(curl -q -sS -X POST "https://api.github.com/repos/$REPO/pulls" -H 'accept: application/vnd.github+json' -H 'content-type: application/json' -d "$BODY")
URL=$(printf '%s' "$RESP" | jq -r '.html_url // empty')
if [ -z "$URL" ]; then echo "PR create failed: $(printf '%s' "$RESP" | head -c 300)" >&2; exit 1; fi
emit --arg u "$URL" '{agentbox:"pr",url:$u}'
`;
