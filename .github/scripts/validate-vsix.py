#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause
"""Validate FreeOCD VSIX packages before they are published.

Usage: validate-vsix.py --version X.Y.Z [--target T | --all] PATH...

PATH may be a .vsix file or a directory containing .vsix files. Each package
is checked for archive integrity, manifest/package.json identity, version,
required extension files, and the node-hid prebuilds for exactly its target
(including the ELF/Mach-O/PE architecture). With --all, every target in
TARGETS must be present exactly once.
"""

import argparse
import json
import struct
import sys
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

IDENTITY = ".//{http://schemas.microsoft.com/developer/vsx-schema/2011}Identity"
PREBUILDS = "extension/node_modules/node-hid/prebuilds/"
BINDING = "node-napi-v4.node"

# target -> (node-hid prebuild suffix, binary format, machine id)
TARGETS = {
    "darwin-arm64": ("darwin-arm64", "macho", 0x0100000C),
    "darwin-x64": ("darwin-x64", "macho", 0x01000007),
    "win32-arm64": ("win32-arm64", "pe", 0xAA64),
    "win32-x64": ("win32-x64", "pe", 0x8664),
    "linux-arm64": ("linux-arm64", "elf", 0xB7),
    "linux-x64": ("linux-x64", "elf", 0x3E),
    "linux-armhf": ("linux-arm", "elf", 0x28),
}

REQUIRED = (
    "extension/package.json",
    "extension/LICENSE.txt",
    "extension/out/mcp-server.js",
    "extension/out/dap.umd.js",
    "extension/out/targets/index.json",
    "extension/out/targets/probe-filters.json",
    "extension/vendor/dapjs/LICENSE",
    "extension/vendor/freeocd-web/LICENSE",
    "extension/node_modules/node-hid/package.json",
    "extension/node_modules/node-hid/nodehid.js",
    "extension/node_modules/node-hid/binding-options.js",
    "extension/node_modules/pkg-prebuilds/bindings.js",
    "extension/node_modules/pkg-prebuilds/lib/prebuild.js",
)
TARGETS_DIR = "extension/out/targets/"
EF_ARM_ABI_FLOAT_HARD = 0x400


def binary_machine(data, fmt):
    """Return the machine id of a native binary, or None if the header is invalid.

    32-bit ARM ELF binaries must use the hard-float ABI (linux-armhf).
    """
    if fmt == "elf":
        if len(data) < 52 or data[:4] != b"\x7fELF" or data[5] != 1:
            return None
        machine = struct.unpack_from("<H", data, 18)[0]
        if machine == 0x28 and not struct.unpack_from("<I", data, 36)[0] & EF_ARM_ABI_FLOAT_HARD:
            return None
        return machine
    if fmt == "macho":
        if len(data) < 8 or data[:4] != b"\xcf\xfa\xed\xfe":
            return None
        return struct.unpack_from("<I", data, 4)[0]
    if fmt == "pe":
        if len(data) < 0x40 or data[:2] != b"MZ":
            return None
        offset = struct.unpack_from("<I", data, 0x3C)[0]
        if offset < 0x40 or len(data) < offset + 6 or data[offset:offset + 4] != b"PE\x00\x00":
            return None
        return struct.unpack_from("<H", data, offset + 4)[0]
    raise ValueError(f"unknown binary format: {fmt}")


def expected_prebuilds(target):
    suffix = TARGETS[target][0]
    dirs = [f"HID-{suffix}"]
    if suffix.startswith("linux-"):
        dirs.append(f"HID_hidraw-{suffix}")
    return {f"{PREBUILDS}{d}/{BINDING}" for d in dirs}


def validate(path, version):
    with ZipFile(path) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"invalid archive member: {corrupt}")
        identity = ElementTree.fromstring(archive.read("extension.vsixmanifest")).find(IDENTITY)
        if identity is None:
            raise ValueError("missing VSIX identity")
        target = identity.get("TargetPlatform")
        if target not in TARGETS:
            raise ValueError(f"unexpected target: {target}")

        package = json.loads(archive.read("extension/package.json"))
        for field, attribute in (("name", "Id"), ("publisher", "Publisher"), ("version", "Version")):
            if not package.get(field) or package[field] != identity.get(attribute):
                raise ValueError(f"package.json {field} does not match the manifest")
        if package["version"] != version:
            raise ValueError(f"package version {package['version']} does not match expected {version}")

        main = package.get("main")
        entry = PurePosixPath(main) if isinstance(main, str) else None
        if entry is None or entry.is_absolute() or ".." in entry.parts:
            raise ValueError("invalid extension entry point")
        entry = PurePosixPath(*[p for p in entry.parts if p != "."])
        if not entry.parts:
            raise ValueError("invalid extension entry point")

        names = set(archive.namelist())
        for member in (f"extension/{entry}", *REQUIRED):
            if member not in names:
                raise ValueError(f"missing archive member: {member}")
            if archive.getinfo(member).file_size == 0:
                raise ValueError(f"empty archive member: {member}")

        index = json.loads(archive.read(f"{TARGETS_DIR}index.json"))
        ids = index.get("targets") if isinstance(index, dict) else None
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise ValueError("out/targets/index.json has no target list")
        for target_id in ids:
            member = f"{TARGETS_DIR}{target_id}.json"
            if ".." in PurePosixPath(target_id).parts or member not in names:
                raise ValueError(f"missing MCU definition: {member}")

        expected = expected_prebuilds(target)
        shipped = {n for n in names if n.startswith(PREBUILDS) and n.endswith(".node")}
        if missing := expected - shipped:
            raise ValueError(f"missing node-hid prebuilds: {', '.join(sorted(missing))}")
        if extra := shipped - expected:
            raise ValueError(f"foreign node-hid prebuilds: {', '.join(sorted(extra))}")
        _, fmt, machine = TARGETS[target]
        for member in sorted(expected):
            if binary_machine(archive.read(member), fmt) != machine:
                raise ValueError(f"invalid native binding for {target}: {member}")
        return target


def collect(paths):
    files = []
    for raw in paths:
        path = Path(raw)
        files.extend(sorted(path.glob("*.vsix")) if path.is_dir() else [path])
    return files


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", required=True, help="expected package version (without leading v)")
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--target", choices=sorted(TARGETS), help="expect exactly one VSIX for this target")
    scope.add_argument("--all", action="store_true", help="expect exactly one VSIX per target")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args(argv)

    seen = set()
    files = collect(args.paths)
    if not files:
        raise SystemExit("no VSIX files found")
    for path in files:
        try:
            target = validate(path, args.version)
        except (BadZipFile, KeyError, ValueError, OSError, ElementTree.ParseError, json.JSONDecodeError) as error:
            raise SystemExit(f"{path.name}: {error}") from error
        if target in seen:
            raise SystemExit(f"duplicate VSIX target: {target}")
        seen.add(target)
        print(f"{path.name}: verified {target} {args.version}")

    expected = set(TARGETS) if args.all else {args.target}
    if seen != expected:
        raise SystemExit(f"expected targets {sorted(expected)}, got {sorted(seen)}")


if __name__ == "__main__":
    sys.exit(main())
