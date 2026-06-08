# Fork Workflow

This fork develops changes on `sparkplug604/nuggets` while keeping the original repository available as a read-only comparison remote.

## Remotes

```text
origin   https://github.com/sparkplug604/nuggets.git
upstream https://github.com/NeoVertex1/nuggets.git
```

`origin` is the only push target. `upstream` is used only for fetching and comparison.

For local safety, set the upstream push URL to a disabled value:

```bash
git remote set-url --push upstream DISABLED
```

## Branching

Use feature branches on the fork:

```bash
git switch main
git pull --ff-only origin main
git switch -c memory-governance
git push -u origin memory-governance
```

Do not work directly on `main` for memory-governance changes.

## Updating From Upstream

Fetch upstream when you want to compare or rebase against the original project:

```bash
git fetch upstream
git log --oneline --decorate --graph --all -20
```

Do not push to `upstream`. If a contribution back to the original project is desired, open a pull request from the fork after review.
