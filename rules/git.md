# Git and scope

Preserve unrelated staged, unstaged, and untracked work. Inspect the selected diff
before editing. Remove newly obsolete code only within scope; avoid broad cleanup.
Destructive Git operations require explicit authorization. Follow project policy
for commits, pushes, and pull requests; honor authorization already given for a
concrete action without repeated requests. Implementation permission is not deployment
permission. `approvalRequiredFor` is workflow guidance, never a host permission bypass;
omission requires explicit authorization for every action listed in the config schema.

Version one's release workflow ends at a report. It never deploys, publishes,
executes migrations, or writes to production. Configured checks are trusted code:
review them for side effects and existing authorization before execution. The runner
cannot enforce their behavior or determine whether a command is safe.
