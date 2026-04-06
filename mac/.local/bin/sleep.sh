#!/bin/bash

case "$1" in
    on)
        sudo pmset disablesleep 0
        ;;
    off)
        sudo pmset disablesleep 1
        ;;
    *)
        echo "Usage: sleep.sh [on|off]"
        exit 1
        ;;
esac
