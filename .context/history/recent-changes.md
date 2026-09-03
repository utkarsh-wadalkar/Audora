# Recent project history

This is intentionally a short decision-oriented history, not a replacement for
`git log`. It lets an agent identify recent assumptions before changing adjacent
code.

| Date | Commit / release | Meaning for current work |
| --- | --- | --- |
| 2026-08-29 | `792ea1b` | Single-song Apple Music URLs with `?i=<track-id>` are parsed as tracks rather than complete album links. |
| 2026-08-29 | `9867e1d` | Artist playback, album sorting, queue navigation, and automatic next-track behavior changed recently; preserve those flows when editing playback/UI. |
| 2026-08-19 | `36e4bab` | FLAC setup and artwork handling hardened for v1.5.3. |
| 2026-08-17 | `5ba0acf` | ALAC is converted to FLAC through an Audora-managed ffmpeg image because Chromium cannot decode ALAC. Do not remove the conversion stage casually. |
| 2026-08-04 | `b2068fd` / v1.5.2 | Version bump after 2FA and UI work. |
| 2026-07 | v1.5.0–v1.5.1 | Glass UI redesign, Docker portability, setup-wizard hang fix, wrapper reuse, live terminal panel, and offline banner were introduced. |

## Audora 2.0.0 release line

Audora 2.0.0 is the Windows x64 + Linux x64 desktop release line. Its defining
delivery rule is that each operating system receives a backend built natively on
the same operating system. The release process and artifact model are defined
in `.context/operations/release-contract.md`.

## Historical invariants worth preserving

- The wrapper container can stay running between app exits (`keep_wrapper_running`)
  to avoid rebuild churn.
- Apple Music auth and 2FA are interactive service flows; never add credentials
  to fixtures or project context.
- The FLAC conversion stage exists for Chromium playback compatibility.
- Electron renderer security is based on context isolation and the minimal
  preload API.
