# NHL postgame-window validation

Validated for v1.2.0 on September 3, 2026. These checks used captured ESPN fixtures and synthetic timing in an isolated Home Assistant instance at `localhost:8128`. They were not a live-broadcast test. Production Home Assistant was not changed.

## Automated checks

The complete checks were run independently for all three sibling repositories:

| Repository | Python tests | JavaScript tests |
| --- | ---: | ---: |
| NFL | 151 | 46 |
| NHL | 169 | 52 |
| NBA | 191 | 63 |
| Total | 511 | 161 |

All **672 tests passed**. This repository contributed 169 Python and 52 JavaScript tests. Ruff, JavaScript syntax checks, and `git diff --check` also passed in every repository.

Coverage includes default-off configuration, fractional hours, invalid inputs, exact expiry relative to recorded timestamps, overlapping pregame/postgame windows, unknown/future finishes, live-game overrides, navigation isolation, timer cleanup, and reconnect behavior. An additional read-only comparison found no visibility differences across 3,780 shared timing/status combinations.

## Isolated Home Assistant checks

All three integrations were available and supplied upcoming-game start metadata. The served `?v=120` card modules matched the repository files byte-for-byte.

Captured regulation fixtures supplied explicit ESPN end-of-game markers. For NHL, `tests/fixtures/summary_401803619_final.json` yielded `2026-04-11T23:38:10Z`. This is the ESPN-reported marker timestamp, not a guarantee of the actual final-whistle time.

Using Home Assistant's real atomic storage, known finish metadata survived a new tracker instance without rebasing the timestamp or making a duplicate summary fetch. An initially unknown final did not invent a postgame window. The observed-transition fallback is approximate and applies only to a closely observed live-to-final change; kickoff and browser-load time are not substituted for a finish.

## Browser checks

In a Home Assistant Sections dashboard, all three cards passed these fixture-based checks:

- Recent finals were visible during an active postgame window.
- A synthetic window with ten seconds remaining expired automatically with no new Home Assistant state update and `refresh_rate: 0`.
- After expiry, each card remained connected, its `hui-card` wrapper was hidden, and its measured height was zero.
- An overlapping next-game window, with the next start twelve hours away, kept the card visible.
- Unknown and future finish timestamps did not create postgame visibility.
- Live games remained visible.
- An automatically selected next game forty-eight hours away remained visible when a recent finish still qualified for the postgame extension.

## Scope and limits

Both time settings are per card. `show_after_hours: 0` adds no extension. When `show_within_hours: 0`, hiding remains disabled regardless of the postgame setting. The feature changes visibility, not automatic game selection.

The expiry boundary is calculated from an ESPN-reported marker or an approximate observed transition, not from a guaranteed exact whistle. Browser scheduling or background throttling can delay a visible repaint. The card's timer does not poll ESPN; the backend may recover and cache a previous final summary.

All three visual card editors exposed the new hours field with default 0. Changing it to 4 produced `show_after_hours: 4` in the card YAML and persisted successfully in Home Assistant dashboard storage. Editor previews remained visible even when the normal dashboard card was hidden. The vertical-stack layout also collapsed all three expired cards to zero-height wrappers.

Automated tests and replayed fixtures do not establish live-feed latency or live-broadcast synchronization.
