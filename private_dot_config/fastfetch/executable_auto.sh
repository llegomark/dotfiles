#!/bin/sh
# Run fastfetch with a logo that fits the current terminal width, so the info column is never cut off.
# Info lines are at most ~69 chars and fastfetch pads 4 columns after the logo:
#   >= 110 cols: full Arch logo (37 wide)   >= 87 cols: arch_small (14 wide)   narrower: no logo
# Extra arguments are passed through to fastfetch.

cols=$(tput cols 2>/dev/null)
cols=${cols:-120}

if [ "$cols" -ge 110 ]; then
  exec fastfetch "$@"
elif [ "$cols" -ge 87 ]; then
  exec fastfetch --logo arch_small "$@"
else
  exec fastfetch --logo none "$@"
fi
