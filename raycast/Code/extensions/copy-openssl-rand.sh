#!/usr/bin/env bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Copy Random String
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🤖

# Documentation:
# @raycast.author AceroM
# @raycast.authorURL https://raycast.com/AceroM

openssl rand -base64 32 | pbcopy
