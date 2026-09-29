# nv/next

Day-to-day build of Peasy: upstream `main` plus every open pull request of
mine, merged together so they can be used before they land.

## Merged branches

| PR | Branch | What it does |
|---|---|---|
| [#96](https://github.com/p-org/peasy-ide-vscode/pull/96) | `nv/remove-stately` | Removes Stately state machine visualization, which P 3.1 dropped |
| [#100](https://github.com/p-org/peasy-ide-vscode/pull/100) | `nv/background-single-compile` | Compiles in the background with a status bar item |
| [#99](https://github.com/p-org/peasy-ide-vscode/pull/99) | `nv/fix-visualizer-welcome` | Shows the visualizer view welcome content |
| [#95](https://github.com/p-org/peasy-ide-vscode/pull/95) | `fix-tilde-path` | Finds P when PATH contains `~` entries |

Base: `main` at `5daecec` (Release 1.1.0).

## Updating

When a PR changes, merge its branch again. When one lands upstream, merge
`main` and drop its row. To rebuild from scratch, start from `main` and merge
each branch above in order with `--no-ff`.
