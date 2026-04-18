# Pick a firmware .hex file

FreeOCD reads **Intel HEX** format files. Most embedded toolchains (Zephyr,
nRF Connect SDK, arm-none-eabi, Pico SDK) can emit a `.hex` alongside the
`.elf` they normally produce.

## Steps

1. Run `FreeOCD: Select .hex File`.
2. Pick your firmware file (typically `build/...hex`).
3. Optionally enable **Auto-flash on save** to re-flash whenever the file
   changes (useful for TDD on hardware).

The selected `.hex` gets a small **F\*** badge in the Explorer so you can
see which file is wired up at a glance.
