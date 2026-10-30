# Security evaluation rubric

Input: the spec (or task), `changes.diff`, the matched triggers, `checks.json` (look for
checks of kind `security`), and the files the diff touches. Start from the triggers and
follow data from its source to where it is used.

Blocking (`critical` or `high`):

- Secrets, credentials or tokens in code, fixtures, logs or configuration.
- Missing authentication, authorization or resource-ownership check at a boundary.
- Untrusted input reaching a query, shell command, file path, template, deserializer
  or redirect without validation or a safe API (injection, path traversal, SSRF).
- Sensitive data written to logs, error messages, analytics or client responses.
- Weak or misused cryptography (home-made schemes, static IVs, fast hashes for
  passwords, disabled certificate checks).
- A new dependency with a known critical vulnerability reported by a configured check,
  or a new or changed install/lifecycle script (`preinstall`, `postinstall`, `prepare`)
  that runs code on install without a stated need.
- File paths built from untrusted input without resolving them (realpath) and checking
  they stay inside an allowed root.
- LLM features: model output used as code, a query, a shell command, a URL or HTML
  without validation; permissions or data access decided by the prompt instead of code;
  retrieved or user content placed into prompts without treating it as untrusted.

Non-blocking: defense-in-depth improvements, missing rate limits where abuse is
unlikely, hardening headers.

A trigger match is not a finding. Report a finding only with the concrete path from
input to impact; if the change is safe, return PASS with no findings. Scanner results
and AI review do not guarantee security; list unassessed areas in `notAssessed`.
