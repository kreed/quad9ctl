# quad9ctl

Route public DNS through [Quad9](https://quad9.net)'s threat-blocking service
over strict DNS over QUIC, with systemd-resolved keeping network-specific
domains — `lan`, VPN search domains — on their per-link resolvers.

The pieces, all installed by the `quad9ctl` RPM:

- **quad9-dnsproxy.service** runs a hardened local
  [dnsproxy](https://github.com/AdguardTeam/dnsproxy) on `127.0.0.1:53` with a
  bounded 4 MiB cache and coalesced duplicate queries.
- **resolved drop-ins** point systemd-resolved's global scope at the proxy
  (`DNS=127.0.0.1:53`, `Domains=~.`) and pull the proxy in via `Wants=`.
- **quad9ctl** manages routing: a temporary manual bypass, standing
  per-network bypass rules, and per-domain ECS exceptions.
- **A NetworkManager dispatcher** re-applies the rules as connections come
  and go.
- **gnome-shell-extension-quad9** (separate RPM) adds a quick-settings toggle
  fronting the same tool.

## Install

From the [COPR repository](https://copr.fedorainfracloud.org/coprs/kreed/quad9ctl/):

```bash
sudo dnf copr enable kreed/quad9ctl
sudo dnf install quad9ctl gnome-shell-extension-quad9   # extension optional
sudo systemctl restart systemd-resolved                  # picks up the drop-ins
```

On bootc/ostree images, install both packages at image build time; the
routing takes effect on first boot with no scriptlet requirements.

## Manual bypass

The temporary bypass returns public DNS to the active network's resolver and
stops the proxy, cancelling any requests still pending there. It is cleared
automatically at reboot:

```bash
quad9ctl status
sudo quad9ctl disable
sudo quad9ctl enable
```

## Per-network bypass

Networks whose own resolver should handle public DNS — such as a home router
that already forwards to Quad9 and caches for the whole LAN — can be given a
standing bypass rule. The NetworkManager dispatcher re-applies the rules
whenever a connection (including VPNs) comes up or goes down, so the bypass
follows the network: connect and Quad9 is bypassed, disconnect and it
returns.

```bash
quad9ctl network list
sudo quad9ctl network add            # the currently active connection
sudo quad9ctl network add "Home"     # by connection name or UUID
sudo quad9ctl network remove "Home"
```

Rules match the NetworkManager connection profile (by UUID), not the SSID,
and are stored in `/etc/dnsproxy/networks`. Note the usual caveat: an access
point imitating a saved network activates the same profile, so a rule is a
statement of trust in the network, not an authentication of it.

A manual `quad9ctl disable` always wins over the rules; `quad9ctl enable`
clears only the manual bypass, so on a listed network routing stays bypassed
and the status says why.

## Quick settings

The Quad9 DNS quick-settings toggle in GNOME Shell fronts the same tool.
Pressing it is `quad9ctl enable`/`disable`; its fill tracks the manual state
only, while the subtitle surfaces transient conditions such as "Bypassed on
Home". The menu toggles the bypass rule for the connected network and opens
the settings window, which mirrors everything the CLI exposes: routing,
proxy and resolver status, the network bypass list, and ECS exceptions. A
polkit rule (`io.github.kreed.quad9ctl`) lets administrators (wheel members)
in an active local session run quad9ctl through pkexec without a password
prompt; everyone else authenticates as admin.

The extension ships disabled; turn it on with:

```bash
gnome-extensions enable quad9@kreed.github.io
```

or enable it for all users through a gschema override for
`org.gnome.shell enabled-extensions`.

## ECS exceptions

Queries go to Quad9's ECS-stripped service by default, so no part of your
address reaches authoritative servers. The trade-off is that DNS-based geo
routing sees the Quad9 anycast node instead of you, and latency-routed
records can answer with a POP on the wrong continent.

Individual domains can opt in to Quad9's ECS-enabled service, which forwards
your address truncated to a /24. Malware blocking and DNSSEC are identical on
both; only subnet privacy differs, and only for the domains listed:

```bash
quad9ctl ecs list
sudo quad9ctl ecs add example.com
sudo quad9ctl ecs remove example.com
```

There are no exceptions by default, and nothing is shipped to configure
them: `quad9ctl` writes `/etc/dnsproxy/ecs.env` when the first exception is
added and removes it again with the last. The service reads that path
optionally, so its absence simply contributes no upstream argument.

They only help where the authoritative honours ECS from any resolver. Akamai
restricts it to an allowlist of resolver operators, and Cloudflare and Fastly
are anycast and ignore it, so exceptions for domains they front do nothing.
Confirm one is worth keeping by comparing a few rounds of:

```bash
dig +short @9.9.9.9 <host>    # ECS stripped
dig +short @9.9.9.11 <host>   # ECS forwarded
```

## Packaging

Two source packages build in COPR from this repository:

- `quad9ctl/` — this project. The spec uses rpkg templating, so every commit
  touching the directory produces a unique NVR; build locally with
  `cd quad9ctl && rpkg local`.
- `dnsproxy/` — RPM packaging for upstream dnsproxy with vendored Go modules;
  a scheduled workflow tracks upstream releases.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT) at your option. dnsproxy itself is Apache-2.0 by
its upstream.
