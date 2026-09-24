# Dotfiles

These are my dotfiles.

## Private references

Keep machine-specific configuration and secrets under the ignored `private/` directory.
The pre-commit hook scans staged paths and content for terms listed in the local
`private/commit-denylist` file (one literal term per line, with no blank lines).
Enable it in a new checkout with `git config core.hooksPath .githooks` after
creating that file. The denylist itself stays outside Git.
