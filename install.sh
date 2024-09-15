#!/bin/bash

install_gh() {
    if command -v gh &> /dev/null; then
        echo "GitHub CLI (gh) is already installed."
        return
    fi

    echo "Installing GitHub CLI (gh) for Debian-based systems..."
    if ! command -v wget &> /dev/null; then
        sudo apt update && sudo apt install wget -y
    fi
    sudo mkdir -p -m 755 /etc/apt/keyrings
    wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
    sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    sudo apt update
    sudo apt install gh -y
    echo "GitHub CLI (gh) installed successfully."
}

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt &> /dev/null; then
        install_gh
        stow .
    else
        echo "Unsupported Linux distribution."
    fi
else
    echo "Unsupported operating system."
fi
