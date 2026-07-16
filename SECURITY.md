# Security Policy

## Supported versions

LLooM is pre-1.0. Security fixes are applied to the current `main` branch and, when releases exist, to the latest minor release when practical. Older development snapshots are not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/enntity/lloom/security/advisories/new>

Include the affected version or commit, platform, configuration, reproduction steps, impact, and any proposed mitigation. Please avoid accessing data or systems that are not yours while investigating.

The maintainers will acknowledge reports as soon as practical, validate the issue, coordinate a fix and disclosure, and credit reporters who want attribution.

## Security boundaries

- LLooM is local-first. Bind the gateway to loopback unless you have configured strong inference and admin credentials.
- Non-loopback serving is intentionally opt-in. Keep remote admin disabled unless you explicitly need it and understand the consequences.
- Applying backend or recipe plans can install packages, download models, create files and shims, and execute commands. Review dry-run output before using `--apply --yes` or `--go`.
- A signature proves which key signed a recipe pack. Trusting keys served by the same community host is equivalent to trusting that host and its TLS connection; use explicit local trusted keys for stronger publisher pinning.
- Development keys and the checked-in public seed key are not production trust roots.
- Model weights and external runtimes have their own licenses and security posture. LLooM does not make untrusted model code safe.
- The public community MVP is read-only by design. Proposals arrive through reviewed pull requests; anonymous recipe and benchmark uploads are disabled in production.
- Remote community feeds must use HTTPS and a locally pinned public signing key. Do not treat a signing key downloaded from the same remote host as an independent trust root.
- The production community deployment is isolated from inference, databases, and Docker control-plane access. See [`deploy/community/README.md`](deploy/community/README.md).

See [docs/architecture.md](docs/architecture.md) for route authorization and network-binding defaults.
