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
- **quad9ctl** manages routing: a persistent off switch, standing
  per-network bypass rules, and per-domain ECS exceptions.
- **A NetworkManager dispatcher** re-applies the rules as connections come
  and go.
- **quad9ctl-portal-helper** runs the GNOME captive-portal sign-in browser
  against the network's own resolver, and nothing else.
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

## Disabling

`quad9ctl disable` turns Quad9 off entirely until re-enabled — including
across reboots: it masks the resolved drop-in in `/etc` and masks the proxy
unit so nothing starts at boot. Transient situations are better served by a
network bypass or an ECS exception.

```bash
quad9ctl status
sudo quad9ctl disable
sudo quad9ctl enable
```

## Per-network bypass

A standing bypass rule hands public DNS to the network's own resolver while
connected. That gives up Quad9's threat blocking on that network, so reserve
it for networks whose resolver you trust — a home router that resolves and
caches for the whole LAN, for example. The NetworkManager dispatcher
re-applies the rules whenever a connection (including VPNs) comes up or goes
down, so the bypass follows the network: connect and Quad9 is bypassed,
disconnect and it returns.

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

Disabling Quad9 always wins over the rules; re-enabling returns routing to
rule-driven behaviour, so on a listed network it comes back bypassed and the
status says why.

## Quick settings

The Quad9 DNS quick-settings tile in GNOME Shell is an indicator: its fill
shows whether Quad9 is resolving right now, the subtitle names the reason
when it is not (such as "Bypassed on Home"), and the tile disappears
entirely while Quad9 is disabled. Its menu toggles the bypass rule for the
connected network and opens the settings window, which mirrors everything
the CLI exposes: a master switch that gates the other settings, routing,
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

## Captive portal sign-in

Portals are detected at the HTTP layer — NetworkManager's connectivity check
resolves and fetches normally, the portal intercepts the request and answers
with a redirect — so Quad9 does not stop GNOME from offering the sign-in
window. What it does stop is the page loading, whenever the redirect points at
a hostname only the network's own resolver knows (`login.gateway`,
`wifi.hotel.local`): Quad9 answers NXDOMAIN and sign-in is impossible.

`quad9ctl-portal-helper` handles that case with no configuration and nothing
to turn on. It wraps GNOME's sign-in browser, running it in a mount namespace
against the connected link's DHCP resolver, and is used whenever a D-Bus
service file for `org.gnome.Shell.PortalHelper` names it as the `Exec=`:

```
[D-BUS Service]
Name=org.gnome.Shell.PortalHelper
Exec=/usr/libexec/quad9ctl-portal-helper
```

That file belongs to gnome-shell, so this package ships only the wrapper and
leaves the substitution to whatever assembles the system — an image build can
replace gnome-shell's copy after its package transaction. Without it the
wrapper is inert and sign-in behaves exactly as it did before.

The swap is confined to that one process tree. Nothing the sign-in browser
resolves is cached by dnsproxy or systemd-resolved, no other program's
lookups change while sign-in is in progress, and there is no state to undo
afterwards — the namespace disappears with the browser. Two files are
replaced inside it: `resolv.conf`, listing the link's servers, and
`nsswitch.conf`, with `nss-resolve` dropped from the `hosts` line. The second
is what makes the first take effect, since `nss-resolve` talks to
systemd-resolved directly and never reads `resolv.conf` at all.

The sign-in browser gives up Quad9's malware blocking for as long as it runs,
against a network that has not been authenticated yet. It is a browser
rendering a page chosen by that network either way; the bypass changes who
resolves the names on it, not who serves them. Anything the wrapper cannot
determine — no default route, no link DNS, `bwrap` missing — falls through to
the unmodified helper, as does a system where Quad9 is disabled or already
bypassed for the network.

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
