Name:           quad9ctl
Version:        {{{ git_version name=quad9ctl lead=1 }}}
Release:        1%{?dist}
Summary:        Quad9 DNS-over-QUIC routing control for systemd-resolved

License:        Apache-2.0 OR MIT
URL:            https://github.com/kreed/quad9ctl
Source0:        {{{ git_dir_pack }}}

BuildArch:      noarch
BuildRequires:  python3
BuildRequires:  systemd-rpm-macros
Requires:       dnsproxy
Requires:       python3
Requires:       NetworkManager
Requires:       systemd-resolved
Requires:       polkit
# The captive-portal sign-in bypass runs the browser in a mount namespace.
Requires:       bubblewrap

%description
quad9ctl routes public DNS through a local dnsproxy instance speaking strict
DNS over QUIC to Quad9, while systemd-resolved keeps network-specific domains
on their per-link resolvers. It manages a persistent off switch, standing
per-network bypass rules applied by a NetworkManager dispatcher, and
per-domain EDNS Client Subnet exceptions, and can confine the GNOME
captive-portal sign-in browser to the network's own resolver.

%package -n gnome-shell-extension-quad9
Summary:        GNOME quick-settings toggle for Quad9 DNS routing
Requires:       %{name} = %{version}-%{release}
Requires:       gnome-shell

%description -n gnome-shell-extension-quad9
A GNOME Shell quick-settings indicator fronting quad9ctl: it shows whether
Quad9 DNS over QUIC is resolving and why not when bypassed, switches the
bypass for the connected network, and opens a settings window for the master
switch, network bypass rules, ECS exceptions and routing status.

%prep
{{{ git_dir_setup_macro }}}

%install
install -D --mode=0755 quad9ctl %{buildroot}%{_bindir}/quad9ctl
install -D --mode=0755 quad9ctl-portal-helper \
    %{buildroot}%{_libexecdir}/quad9ctl-portal-helper
install -D --mode=0755 60-quad9 \
    %{buildroot}%{_prefix}/lib/NetworkManager/dispatcher.d/60-quad9
install -D --mode=0644 quad9-dnsproxy.service \
    %{buildroot}%{_unitdir}/quad9-dnsproxy.service
install -D --mode=0644 systemd-resolved.service.d/60-quad9-doq.conf \
    %{buildroot}%{_unitdir}/systemd-resolved.service.d/60-quad9-doq.conf
install -D --mode=0644 resolved.conf.d/60-quad9-doq.conf \
    %{buildroot}%{_prefix}/lib/systemd/resolved.conf.d/60-quad9-doq.conf
install -D --mode=0644 quad9ctl.tmpfiles.conf %{buildroot}%{_tmpfilesdir}/quad9ctl.conf
install -D --mode=0644 io.github.kreed.quad9ctl.policy \
    %{buildroot}%{_datadir}/polkit-1/actions/io.github.kreed.quad9ctl.policy
install -D --mode=0644 60-quad9ctl.rules \
    %{buildroot}%{_datadir}/polkit-1/rules.d/60-quad9ctl.rules
install -d %{buildroot}%{_datadir}/gnome-shell/extensions
cp -r quad9@kreed.github.io %{buildroot}%{_datadir}/gnome-shell/extensions/

# quad9ctl creates these on first use and removes them when emptied; ghosting
# them keeps 'rpm -qf' and erasure bookkeeping accurate.
install -d %{buildroot}%{_sysconfdir}/dnsproxy
touch %{buildroot}%{_sysconfdir}/dnsproxy/networks
touch %{buildroot}%{_sysconfdir}/dnsproxy/ecs.env
install -d %{buildroot}/run/quad9ctl

%check
python3 -m py_compile quad9ctl
python3 quad9ctl --help >/dev/null

%post
%tmpfiles_create quad9ctl.conf
%systemd_post quad9-dnsproxy.service

%preun
%systemd_preun quad9-dnsproxy.service

%postun
%systemd_postun quad9-dnsproxy.service

%files
%license LICENSE-APACHE LICENSE-MIT
%{_bindir}/quad9ctl
%{_libexecdir}/quad9ctl-portal-helper
%{_prefix}/lib/NetworkManager/dispatcher.d/60-quad9
%{_unitdir}/quad9-dnsproxy.service
%dir %{_unitdir}/systemd-resolved.service.d
%{_unitdir}/systemd-resolved.service.d/60-quad9-doq.conf
%dir %{_prefix}/lib/systemd/resolved.conf.d
%{_prefix}/lib/systemd/resolved.conf.d/60-quad9-doq.conf
%{_tmpfilesdir}/quad9ctl.conf
%{_datadir}/polkit-1/actions/io.github.kreed.quad9ctl.policy
%{_datadir}/polkit-1/rules.d/60-quad9ctl.rules
%dir %{_sysconfdir}/dnsproxy
%ghost %{_sysconfdir}/dnsproxy/networks
%ghost %{_sysconfdir}/dnsproxy/ecs.env
%ghost %dir /run/quad9ctl

%files -n gnome-shell-extension-quad9
%{_datadir}/gnome-shell/extensions/quad9@kreed.github.io/

%changelog
{{{ git_changelog name=quad9ctl }}}
