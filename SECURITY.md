# Security Policy

## Supported Versions

durable-agents is pre-1.0 software. Security fixes are applied to the latest
released `0.x` minor line only. Older versions are not patched — please upgrade
to the most recent release before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report vulnerabilities privately through one of these channels:

1. **GitHub Security Advisories (preferred).** Open a private report via the
   ["Report a vulnerability"](https://github.com/antonalag/durable-agents/security/advisories/new)
   button on the repository's **Security** tab. This keeps the report
   confidential until a fix is published.
2. **Email.** If you cannot use GitHub Security Advisories, email
   **anjoalDev@gmail.com** with the details below.

Please include as much of the following as you can:

- A description of the vulnerability and its impact
- The affected version(s) and environment (Node.js version, store backend)
- Step-by-step reproduction instructions or a minimal proof of concept
- Any relevant logs, stack traces, or configuration (with secrets redacted)

## What to Expect

- **Acknowledgement** within 5 business days of your report.
- An initial assessment and severity classification, and we will keep you
  updated on progress toward a fix.
- Coordinated disclosure: we will agree on a disclosure timeline with you and
  credit you in the advisory unless you prefer to remain anonymous.
- If a report is declined, we will explain why.

## Scope

In scope:

- The `durable-agents` library code in this repository (runtime, stores,
  adapters, dashboard, CLI).

Out of scope:

- Vulnerabilities in third-party dependencies — report those to the respective
  maintainers (we will still upgrade once a fix is available).
- Issues that require a pre-compromised host, a malicious `costFunction` or
  workflow function supplied by the operator, or physical/privileged access to
  the machine running the runtime.

## Handling Secrets and Data

When preparing a report, **do not include real credentials, API keys, tokens,
or production data.** Redact connection strings and use placeholder values. The
runtime persists workflow inputs, outputs, and metadata to the configured store;
treat that store as sensitive and secure it accordingly in your deployment.
