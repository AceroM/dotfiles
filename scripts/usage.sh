#!/bin/bash

# Find and display the top 20 largest files by size
find . -type f -exec du -h {} + 2>/dev/null | sort -rh | head -20
