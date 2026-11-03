# Security

Report a vulnerability through [GitHub's private reporting](https://github.com/Enntity/accord/security/advisories/new),
not a public issue. Include the version, platform and steps to reproduce.

## What Accord protects

Accord runs as your user, with bearer credentials in private files. Local clients reach
the service over a Unix socket in the private data directory, so another user on the
machine cannot stand in for it. Anything running as your user can read those files, so
Accord offers no protection from it.

A linked host is trusted to represent its own agents and to request worker access to
your registered resources. It sees activity lines and resources, not session history,
unless you run `accord share-sessions`. Before sending a link credential, each host
requires the other to prove it holds the link.

## Known limits

- **Windows** has no Unix socket path, so local clients use a loopback TCP port. Another
  user on the machine could hold that port while Accord is down and capture a credential.
- **Tunnels** are loopback ports. Someone with accounts on both linked hosts could relay
  the link proof while a tunnel is down, so avoid links between hosts you share.
- **Messages** are untrusted data. A peer, including one on a linked host, can wake an
  idle conversation up to six times an hour and put bounded text in its context. Its
  text can attempt prompt injection, so set `ACCORD_WAKE_PER_HOUR=0` if your agents run
  with permissive settings and you do not trust your peers.
- **Redaction** is best effort and cannot recognize every secret format.
- **Reservations** are agreements unless a driver enforces them. See
  [the process driver](docs/PROCESS-DRIVER.md) for what enforcement covers.
- **The browser board** uses the loopback TCP port. Paste its token only while the
  service is running.
