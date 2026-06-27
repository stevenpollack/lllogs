# tools

Repo tooling that isn't part of the shipped app.

## `gen-social-preview.ts` — GitHub social preview

Generates the branding placard used as the repo's social preview (the card shown when an
`lllogs` link is shared on GitHub / Slack / X).

```bash
bun tools/gen-social-preview.ts
```

Outputs into [`.github/`](../.github):

| file | size | use |
| --- | --- | --- |
| `social-preview.svg` | vector | source of truth (edit the generator, not this) |
| `social-preview.png` | 1280×640 | **upload this** under repo Settings → Social preview |
| `social-preview@2x.png` | 2560×1280 | crisp 2× for slide decks / docs |
| `social-preview-light.*` | — | light-theme variant of all three |

### Requirements

- [Bun](https://bun.sh) (the runtime).
- `rsvg-convert` from **librsvg** for SVG→PNG rasterization
  (`apt install librsvg2-bin`, `brew install librsvg`). The SVG renders without it; only the
  PNG step needs it.

### Setting it on GitHub

GitHub does not auto-pick a file from the repo — upload `social-preview.png` manually at
**Settings → General → Social preview**. Recommended spec is 1280×640.

### Notes

- The orange sunburst is a **recognizable stand-in** for the Claude/Anthropic mark, not the
  official trademarked asset. Swap in the real SVG (and mind Anthropic's brand guidelines) for
  exact fidelity.
- Tweak copy, colors, and the mock log lines directly in `gen-social-preview.ts` (the `DARK` /
  `LIGHT` theme objects and the `card()` line list), then re-run.
