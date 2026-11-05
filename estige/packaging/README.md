# packaging

Format inputs for the pure-Go `.deb` / `.rpm` writer. `estige/build.sh
estige-packages` builds both artifacts into `out/` (gitignored); the writer
itself is `main.go` + `deb.go` + `rpm.go` here.

| Path                           | Owner                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `VERSION`                      | the one version spelling: `-version` output and both package versions (override with `ESTIGE_VERSION`) |
| `termux/env`                   | Termux exit-node env template, installed as `$PREFIX/etc/estige/env` mode 0600                         |
| `termux/service/run`           | runit run script: sources that env, execs `estige -mode exit`                                          |
| `termux/service/log/run`       | `svlogd` sink for the Combined Log Format stdout (docs/d106)                                           |
| `termux/service/down`          | shipped on purpose: `sv-enable` is the explicit start                                                  |
| `termux/postinst`              | prints the enable step; never starts an unedited credential                                            |
| `ol/estige.env`                | exit-node env template, `/etc/estige/estige.env` mode 0600                                             |
| `ol/estige-relay.env`          | relay env template, `/etc/estige/estige-relay.env` mode 0600                                           |
| `ol/estige.service`            | exit node unit: `VPN_OPERATOR_KEYS`, bind `PORT` (docs/d110)                                           |
| `ol/estige-relay.service`      | relay unit: `VPN_OPERATOR_TOKEN`, loopback listeners only                                              |
| `ol/prein.sh` … `ol/postun.sh` | RPM scriptlets (`%pre`, `%post`, `%preun`, `%postun`)                                                  |

The two units are separate files, not an `estige@.service` template: the roles
carry disjoint credentials and disjoint listeners (docs/d090), so a template
would need per-instance credential indirection for no gain.

Both env files are conffiles (`%config(noreplace)` in the RPM; `conffiles` in
the deb), so an upgrade never overwrites operator edits. Neither writer signs
anything: RPM signatures are an operator/repo concern, and the deb ships
unsigned.

Writers use only the standard library (`ar`, `tar`, `gzip`, `crypto/*`);
the RPM side emits a v3 lead, a signature header carrying the SIZE/SHA1/SHA256/
MD5/PAYLOADSIZE tags (the region RPM requires even for an unsigned package),
the immutable main header, and a gzip-compressed newc `cpio` payload. No
external packaging tool is needed on the build host.
