source ~/.local/share/omakub/defaults/bash/rc
source ~/.bash_aliases
source ~/.bash_private
source ~/create_pr.sh

x() {
  git add .
  git commit -m "changes"
  git push
}

