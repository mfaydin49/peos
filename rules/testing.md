# Testing

Test observable behavior, public contracts, important edge cases, and high-risk
domain rules. Add regression tests for bugs when practical. Prefer meaningful
isolation with fixtures, mocks, and helpers over tests that mirror implementation.
Use the project's tools; impose neither a universal coverage target nor a new framework.
Run added/changed tests with terminating commands and report actual outcomes.
Creating tests is not verification. Never weaken checks or acceptance criteria to pass.
After a fix, rerun affected checks; after a material change, invalidate affected evidence.
