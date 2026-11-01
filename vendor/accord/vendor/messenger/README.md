These MIT-licensed files are copied without changes from Enntity Messenger
commit `08a788e25a80650f7a0355341852975cbe424d2b`:
`src/store.js`, `src/auth.js`, `src/errors.js`, and `LICENSE`.

Accord embeds the SQLite store in its host process. No Messenger daemon, account,
MongoDB dependency, or network access is needed. Keep messaging semantics upstream;
update these files together from a reviewed Messenger revision. Accord owns only
the address adapter and host transport outbox. The vendor integrity test pins the
exact upstream file hashes.
