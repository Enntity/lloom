# Releasing LLooM

LLooM uses Semantic Versioning for public releases. Until 1.0, minor versions may introduce documented contract changes; patch versions should remain backward compatible.

## Release checklist

1. Confirm `main` is clean and current.
2. Move shipped entries from `Unreleased` in `CHANGELOG.md` into a dated version section.
3. Update `package.json` and `package-lock.json` together.
4. Run the complete release gate:

   ```bash
   npm ci
   npm run check
   npm run format:check
   npm run lint
   npm test
   npm run interchange:check
   npm run package:check
   npm audit --audit-level=high
   npm pack --dry-run
   git diff --check
   ```

5. Inspect the tarball file list for keys, generated configuration, machine-local paths, and unintended artifacts.
6. Merge the release pull request.
7. Create an annotated `vX.Y.Z` tag from the reviewed commit and publish matching GitHub release notes.
8. Publish npm only from the tagged commit, with provenance enabled and two-factor authentication required for maintainers.
9. Verify a clean install in a temporary home and run `lloom --offline` plus `lloom doctor --no-runtimes`.

Do not publish from a dirty checkout or bypass a failing CI, package, secret, license, or vulnerability check.
