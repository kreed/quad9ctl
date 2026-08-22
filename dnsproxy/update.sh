#!/usr/bin/bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 VERSION" >&2
  exit 2
fi

version="${1#v}"
if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid dnsproxy version: ${version}" >&2
  exit 2
fi

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
spec="${package_dir}/dnsproxy.spec"
current_version="$(awk '$1 == "Version:" { print $2; exit }' "${spec}")"

if [[ "${version}" == "${current_version}" ]]; then
  echo "dnsproxy ${version} is already packaged"
  exit 0
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

source_archive="${work_dir}/dnsproxy-${version}.tar.gz"
curl --fail --location --silent --show-error \
  --output "${source_archive}" \
  "https://github.com/AdguardTeam/dnsproxy/archive/refs/tags/v${version}.tar.gz"
tar --extract --gzip --file "${source_archive}" --directory "${work_dir}"

vendor_archive="${package_dir}/dnsproxy-${version}-vendor.tar.xz"
GOTOOLCHAIN=auto go_vendor_archive create \
  --output "${vendor_archive}" \
  "${work_dir}/dnsproxy-${version}"

sed -Ei \
  -e "s/^(Version:[[:space:]]+).*/\\1${version}/" \
  -e 's/^Release:.*/Release:        1%{?dist}/' \
  "${spec}"

old_vendor_archive="${package_dir}/dnsproxy-${current_version}-vendor.tar.xz"
if [[ "${old_vendor_archive}" != "${vendor_archive}" ]]; then
  rm -f -- "${old_vendor_archive}"
fi

changelog_date="$(LC_ALL=C date '+%a %b %d %Y')"
changelog_entry="* ${changelog_date} Christopher Eby <kreed@kreed.org> - ${version}-1
- Update to dnsproxy ${version}
"
updated_spec="${work_dir}/dnsproxy.spec"
awk -v entry="${changelog_entry}" \
  '{ print; if ($0 == "%changelog") print entry }' \
  "${spec}" > "${updated_spec}"
install --mode=0644 "${updated_spec}" "${spec}"

echo "updated dnsproxy from ${current_version} to ${version}"
