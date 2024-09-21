source ~/.local/share/omakub/defaults/bash/rc
source ~/.bash_aliases
source ~/.bash_private

export drop_public="DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

x() {
  git add .
  git commit -m "changes"
  git push
}

