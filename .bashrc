source ~/create_pr.sh
source ~/.local/share/omakub/defaults/bash/rc
source ~/.bash_aliases
source ~/.bash_private

# Create a PR using create_pr.sh
function gai() {
  create_pr
  update_pr_description
  open_pr_in_browser
}

# Create an empty commit
function x() {
  git add .
  git commit -m "changes"
  git push
}

