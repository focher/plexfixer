#!/bin/sh
#
# Shipped in the DMG for builds that are signed but not notarized.
#
# macOS attaches a "quarantine" flag to anything downloaded from the internet.
# For an app without an Apple notarization ticket, that flag is what produces
# "Apple could not verify PlexFixer is free of malware" — and since macOS
# Sequoia, Control-clicking the app no longer offers a way past it. Removing
# the flag from this one app is the same decision the old Control-click → Open
# made, and nothing else on the system is affected.
#
# You do not need this for a notarized build, and you do not need it at all if
# you would rather use System Settings → Privacy & Security → Open Anyway.

set -eu

# Defaults to the usual place; pass a path, or drop an app onto this file in
# Finder, to point it somewhere else.
APP="${1:-/Applications/PlexFixer.app}"

printf '\nPlexFixer — letting macOS open this build\n\n'

if [ ! -d "$APP" ]; then
  HERE=$(cd "$(dirname "$0")" && pwd)
  if [ -d "$HERE/PlexFixer.app" ]; then
    printf 'PlexFixer has not been installed yet.\n'
    printf 'Drag it onto the Applications folder in this window first, then run this again.\n\n'
  else
    printf 'No PlexFixer at %s.\n' "$APP"
    printf 'Install it first, then run this again.\n\n'
  fi
  exit 1
fi

printf 'Clearing the download flag on %s\n' "$APP"
xattr -dr com.apple.quarantine "$APP"

printf 'Checking the signature is still intact\n'
if codesign --verify --strict "$APP" 2>/dev/null; then
  # -dvv, not -dv: the Authority lines only appear at the second level.
  printf '  signed by: %s\n' "$(codesign -dvv "$APP" 2>&1 | awk -F'=' '/^Authority/ { print $2; exit }')"
else
  printf '  WARNING: this copy does not pass its own signature check. Do not run it;\n'
  printf '  download it again from the releases page.\n\n'
  exit 1
fi

printf '\nOpening PlexFixer.\n\n'
open "$APP"
