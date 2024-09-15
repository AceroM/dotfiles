source ~/.local/share/omakub/defaults/bash/rc
source ~/.bash_aliases
source ~/.bash_private

x() {
  git add .
  git commit -m "changes"
  git push
}

