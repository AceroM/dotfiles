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

install_yazi() {
    if command -v yazi &> /dev/null; then
        echo "Yazi is already installed."
        return
    fi

    echo "Installing Yazi..."
    if ! command -v cargo &> /dev/null; then
        echo "Rust is required to install Yazi. Installing Rust..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        source $HOME/.cargo/env
    fi

    cargo install --locked yazi-fm
    echo "Yazi installed successfully."
}

install_datagrip() {
    if command -v datagrip &> /dev/null; then
        echo "DataGrip is already installed."
        return
    fi

    echo "Installing DataGrip..."
    sudo snap install datagrip --classic
    echo "DataGrip installed successfully."
}

install_autokey() {
    if command -v autokey-gtk &> /dev/null; then
        echo "AutoKey is already installed."
        return
    fi

    echo "Installing AutoKey..."
    sudo apt update
    sudo apt install -y python3-dbus python3-pyinotify python3-xlib wmctrl
    sudo apt install -y python3-gi gir1.2-gtk-3.0 gir1.2-gtksource-3.0 gir1.2-appindicator3-0.1 gir1.2-glib-2.0 gir1.2-notify-0.7 zenity
    sudo apt install -y autokey-gtk
    echo "AutoKey installed successfully."
}

install_fd() {
    if command -v fdfind &> /dev/null; then
        echo "fd-find is already installed."
        return
    fi

    echo "Installing fd-find..."
    sudo apt update
    sudo apt install -y fd-find
    echo "fd-find installed successfully."
}

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt &> /dev/null; then
        install_gh
        install_yazi
        install_datagrip
        install_autokey
        install_fd
        stow .
    else
        echo "Unsupported Linux distribution."
    fi
else
    echo "Unsupported operating system."
fi
