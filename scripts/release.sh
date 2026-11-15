#!/usr/bin/env bash
# Create a numbered release of the factory.
#
# On main, the workflows refer to each other and to the setup action at @main.
# A repository that pins a release must get every part from that same release,
# so this makes one commit on top of main in which those references name the
# release tag, and tags that commit. Nothing is pushed; the command to push the
# tag is printed at the end.
set -euo pipefail

version="${1:-}"
if ! [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh vMAJOR.MINOR.PATCH" >&2
  exit 2
fi
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "the working tree has uncommitted changes" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
  echo "tag $version already exists" >&2
  exit 1
fi

start="$(git rev-parse HEAD)"
restore() { git checkout -q --detach "$start" 2>/dev/null || true; git checkout -q - 2>/dev/null || true; }
branch="$(git symbolic-ref -q --short HEAD || true)"

git checkout -q --detach "$start"
files=(.github/workflows/run.yml .github/workflows/attempt.yml)
sed -i -E "s#(uses: amasaun/factory/[A-Za-z0-9_./-]+)@main#\1@${version}#" "${files[@]}"
if grep -nE "uses: amasaun/factory/.*@main" "${files[@]}"; then
  echo "some references still point at main" >&2
  git checkout -q -- "${files[@]}"; [ -n "$branch" ] && git checkout -q "$branch"
  exit 1
fi
if git diff --quiet; then
  echo "no references were rewritten; is this the factory repository?" >&2
  [ -n "$branch" ] && git checkout -q "$branch"
  exit 1
fi
git add "${files[@]}"
git -c user.name="${GIT_AUTHOR_NAME:-factory-release}" -c user.email="${GIT_AUTHOR_EMAIL:-factory-release@users.noreply.github.com}" \
  commit -q -m "Release ${version}"
git tag "$version"
[ -n "$branch" ] && git checkout -q "$branch"

echo "Tagged $(git rev-parse --short "$version") as $version."
echo "To publish it:  git push origin $version"
