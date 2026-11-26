#!/usr/bin/env python3
# SPDX-License-Identifier: BSD-3-Clause

import json
import struct
import unittest
from pathlib import Path
from runpy import run_path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

module = run_path(str(Path(__file__).with_name("validate-vsix.py")))
validate, main, TARGETS, REQUIRED = module["validate"], module["main"], module["TARGETS"], module["REQUIRED"]
expected_prebuilds = module["expected_prebuilds"]


def native(fmt, machine, hard_float=True):
    if fmt == "elf":
        data = bytearray(64)
        data[:4] = b"\x7fELF"
        data[5] = 1
        struct.pack_into("<H", data, 18, machine)
        if machine == 0x28 and hard_float:
            struct.pack_into("<I", data, 36, 0x5000400)
        return bytes(data)
    if fmt == "macho":
        return b"\xcf\xfa\xed\xfe" + struct.pack("<I", machine) + bytes(24)
    data = bytearray(0x86)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\x00\x00"
    struct.pack_into("<H", data, 0x84, machine)
    return bytes(data)


class ValidateVsixTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, target, version="1.2.3", binaries=None, skip=(), manifest_version=None):
        _, fmt, machine = TARGETS[target]
        if binaries is None:
            binaries = {member: native(fmt, machine) for member in expected_prebuilds(target)}
        path = self.dir / f"ext-{target}.vsix"
        with ZipFile(path, "w") as archive:
            archive.writestr("extension.vsixmanifest", f"""
                <PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
                  <Metadata>
                    <Identity Id="freeocd-extension" Publisher="FreeOCD"
                              Version="{manifest_version or version}" TargetPlatform="{target}" />
                  </Metadata>
                </PackageManifest>""")
            files = {member: b"x" for member in REQUIRED if member not in skip}
            files["extension/out/extension.js"] = b"x"
            files["extension/out/targets/index.json"] = json.dumps({"targets": ["nordic/nrf54/nrf54l15"]})
            files["extension/out/targets/nordic/nrf54/nrf54l15.json"] = b"{}"
            files["extension/package.json"] = json.dumps({
                "name": "freeocd-extension", "publisher": "FreeOCD",
                "version": version, "main": "./out/extension.js",
            })
            files.update(binaries)
            for member, data in files.items():
                if member not in skip:
                    archive.writestr(member, data)
        return path

    def test_accepts_every_target(self):
        for target in TARGETS:
            with self.subTest(target=target):
                self.assertEqual(validate(self.build(target), "1.2.3"), target)

    def test_rejects_version_mismatch(self):
        with self.assertRaisesRegex(ValueError, "does not match expected"):
            validate(self.build("linux-x64"), "1.2.4")

    def test_rejects_manifest_mismatch(self):
        with self.assertRaisesRegex(ValueError, "version does not match the manifest"):
            validate(self.build("linux-x64", manifest_version="9.9.9"), "1.2.3")

    def test_rejects_missing_required_file(self):
        with self.assertRaisesRegex(ValueError, "missing archive member: extension/out/dap.umd.js"):
            validate(self.build("linux-x64", skip={"extension/out/dap.umd.js"}), "1.2.3")

    def test_rejects_missing_hid_loader(self):
        for member in ("extension/node_modules/node-hid/binding-options.js",
                       "extension/node_modules/pkg-prebuilds/lib/prebuild.js"):
            with self.subTest(member=member), self.assertRaisesRegex(ValueError, f"missing archive member: {member}"):
                validate(self.build("linux-x64", skip={member}), "1.2.3")

    def test_rejects_missing_mcu_definition(self):
        member = "extension/out/targets/nordic/nrf54/nrf54l15.json"
        with self.assertRaisesRegex(ValueError, f"missing MCU definition: {member}"):
            validate(self.build("linux-x64", skip={member}), "1.2.3")

    def test_rejects_soft_float_armhf(self):
        soft = {m: native("elf", 0x28, hard_float=False) for m in expected_prebuilds("linux-armhf")}
        with self.assertRaisesRegex(ValueError, "invalid native binding for linux-armhf"):
            validate(self.build("linux-armhf", binaries=soft), "1.2.3")

    def test_rejects_wrong_architecture(self):
        wrong = {m: native("elf", TARGETS["linux-x64"][2]) for m in expected_prebuilds("linux-arm64")}
        with self.assertRaisesRegex(ValueError, "invalid native binding for linux-arm64"):
            validate(self.build("linux-arm64", binaries=wrong), "1.2.3")

    def test_rejects_mz_without_pe_signature(self):
        bad = {m: b"MZ" + bytes(0x3A) + (0x80).to_bytes(4, "little") for m in expected_prebuilds("win32-x64")}
        with self.assertRaisesRegex(ValueError, "invalid native binding for win32-x64"):
            validate(self.build("win32-x64", binaries=bad), "1.2.3")

    def test_rejects_foreign_prebuilds(self):
        _, fmt, machine = TARGETS["linux-armhf"]
        binaries = {m: native(fmt, machine) for m in expected_prebuilds("linux-armhf")}
        binaries.update({m: native("elf", 0x3E) for m in expected_prebuilds("linux-x64")})
        with self.assertRaisesRegex(ValueError, "foreign node-hid prebuilds"):
            validate(self.build("linux-armhf", binaries=binaries), "1.2.3")

    def test_rejects_missing_hidraw_prebuild(self):
        _, fmt, machine = TARGETS["linux-x64"]
        binaries = {m: native(fmt, machine) for m in expected_prebuilds("linux-x64") if "hidraw" not in m}
        with self.assertRaisesRegex(ValueError, "missing node-hid prebuilds"):
            validate(self.build("linux-x64", binaries=binaries), "1.2.3")

    def test_all_requires_every_target(self):
        for target in TARGETS:
            self.build(target)
        main(["--version", "1.2.3", "--all", str(self.dir)])
        (self.dir / "ext-linux-armhf.vsix").unlink()
        with self.assertRaisesRegex(SystemExit, "expected targets"):
            main(["--version", "1.2.3", "--all", str(self.dir)])

    def test_rejects_duplicate_target(self):
        first = self.build("linux-x64")
        first.rename(self.dir / "copy-a.vsix")
        self.build("linux-x64")
        with self.assertRaisesRegex(SystemExit, "duplicate VSIX target"):
            main(["--version", "1.2.3", "--all", str(self.dir)])


if __name__ == "__main__":
    unittest.main()
