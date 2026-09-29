#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Center Terminal
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🤖

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM

# Chrome's 1728x1084 window, centered in this display's 2560x1410 usable area.
# Yabai's grid positions this window one pixel lower and shorter than the input.
exec yabai -m window --grid 1410:2560:416:162:1728:1085
