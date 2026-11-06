# Code quality

Follow project architecture and public contracts. Prefer clear responsibilities,
naming, and data flow; separate domain logic from presentation where appropriate.
Preserve behavior outside the task. Do not impose file-length targets or add
abstractions for hypothetical future reuse. Judge clarity and maintainability,
not line count. Technology choices and performance budgets belong in project documents.

Least new code. Before writing code, take the first answer that works:
1. Does it need to exist? Name unrequested features or options instead of building them.
2. Does the codebase already do it? Reuse it (see the project's code map, `.project-os/cache/code-map.md`, when given).
3. Does the language or platform standard library do it?
4. Does an already installed dependency do it?
5. Only then write the smallest complete code for it.
Judge by how much new code a reader must understand, not by line count.

Never cut, however small the task: validation at trust boundaries, error handling that
prevents data loss, security, accessibility, and anything the request asked for.

A deliberate limit gets one comment: `shortcut: <the limit>, <when to upgrade>`. It is a
recorded decision, not a hidden gap; the upgrade trigger is required.
