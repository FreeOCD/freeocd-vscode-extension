# FreeOCD Pull Request

## Summary

<!-- One-paragraph summary of the change. What does it do and why? -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing behaviour to change)
- [ ] New MCU target
- [ ] Documentation / tests only

## How has this been tested?

<!-- Describe the tests you ran to verify your changes. Include any manual
     test steps with hardware, especially flash/verify/recover/RTT runs. -->

- [ ] `npm run lint`
- [ ] `npm run lint:targets`
- [ ] `npx tsc --noEmit -p .`
- [ ] `npm test`
- [ ] Verified on real hardware: <!-- probe + MCU + firmware -->

## Checklist

- [ ] I have read `CONTRIBUTING.md`.
- [ ] My code follows the project's TypeScript strict mode.
- [ ] I kept existing tests green and added new tests where appropriate.
- [ ] I updated documentation (README / CHANGELOG / AI_REVIEW) if user-visible behaviour changed.
- [ ] I did not commit generated artifacts (`out/`, `dist/`, `*.vsix`).
- [ ] I did not hard-code platform-specific paths.
