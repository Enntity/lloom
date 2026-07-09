This directory contains development-only signing metadata for the checked-in
community seed host.

Private keys are not packaged. Source checkouts may keep a local development
private key here for stable smoke-test signatures, but installed packages use a
process-local ephemeral Ed25519 key when `lloom-host serve` needs to emit signed
demo recipe packs.

Production hosts must use their own signing keys and publish the corresponding
public keys.
