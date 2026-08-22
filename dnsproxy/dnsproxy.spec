%global goipath github.com/AdguardTeam/dnsproxy

Name:           dnsproxy
Version:        0.84.0
Release:        1%{?dist}
Summary:        DNS proxy with support for encrypted DNS protocols

License:        Apache-2.0
URL:            https://github.com/AdguardTeam/dnsproxy
Source0:        %{url}/archive/refs/tags/v%{version}/%{name}-%{version}.tar.gz
# Generated with Fedora's go_vendor_archive tool.
Source1:        %{name}-%{version}-vendor.tar.xz

BuildRequires:  gcc
BuildRequires:  golang >= 1.26.5
BuildRequires:  go-rpm-macros

%gometa -f

%description
dnsproxy is a DNS proxy that supports DNS-over-HTTPS, DNS-over-TLS,
DNS-over-QUIC, and DNSCrypt upstream and downstream connections.

%prep
%autosetup -n %{name}-%{version} -a 1

# Upstream requests the next Go patch release.  Fedora 44 currently carries
# 1.26.5; patch releases do not change the Go language version, and building
# with the distro toolchain avoids downloading a compiler during the build.
sed -Ei 's/^go 1\.26\.[0-9]+$/go 1.26.5/' go.mod

%build
export GO111MODULE=on
export GOTOOLCHAIN=local
export GOFLAGS='-mod=vendor'
export GO_LDFLAGS='-X github.com/AdguardTeam/golibs/version.version=v%{version} -X github.com/AdguardTeam/golibs/version.branch=release -X github.com/AdguardTeam/golibs/version.revision=rpm'
%gobuild -o %{name} .

%install
install -D --mode=0755 %{name} %{buildroot}%{_bindir}/%{name}

# Fedora's Go dependency generator turns this file into versioned
# bundled(golang(...)) Provides for the vendored modules.
install -D --mode=0644 vendor/modules.txt \
    %{buildroot}%{_licensedir}/%{name}/modules.txt

%check
export GO111MODULE=on
export GOTOOLCHAIN=local
export GOFLAGS='-mod=vendor'
# The proxy and upstream packages contain integration tests that require
# external DNS services or network namespace features unavailable in COPR.
# Run all deterministic package tests; both excluded packages are still
# compiled into the binary above.
test_packages="$(go list ./... | grep -Ev '^%{goipath}/(proxy|upstream)$')"
%gotest ${test_packages}
%{buildroot}%{_bindir}/%{name} --version | grep --fixed-strings 'v%{version}'

%files
%license LICENSE
%license %{_licensedir}/%{name}/modules.txt
%doc README.md config.yaml.dist
%{_bindir}/%{name}

%changelog
* Sat Aug 15 2026 Christopher Eby <kreed@kreed.org> - 0.84.0-1
- Initial package
