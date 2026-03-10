# impossibility report

## scope

User constraints:

- modify only `blaz` and `namenag`
- put session name **on** the input box top border line
- keep footer pwd line without the session name
- if an impossibility exists, report it

## hard limit in pi extension api

There is no extension API to:

- get the currently installed editor component
- wrap an already-installed editor component
- inject text directly into the built-in editor border line without owning
  editor rendering

That means border-line insertion requires `blaz` to affect editor setup via
`ctx.ui.setEditorComponent(...)`.

## consequence

`blaz` can reliably do the requested top-border rendering in these cases:

- when it installs the editor itself
- when it wraps a later `setEditorComponent(...)` call from another extension
- when a later extension restores the default editor with
  `setEditorComponent(undefined)`

What it **cannot** guarantee, without modifying another extension like
`pi-vim`, is retroactively wrapping an editor that some other extension has
already installed before `blaz` gets a chance.

So full editor-agnostic, load-order-independent coexistence is impossible
under the current API and the user constraint of not modifying `pi-vim`.

## current best-effort behavior

`blaz`:

- owns footer rendering, so footer session-name removal is reliable
- wraps editor rendering when it can reach editor setup
- omits the built-in `(auto)` compaction badge because extension api does
  not expose the real auto-compaction flag
- is verified to work in the current local setup via live `pi --session ...`
  reproduction

If another editor extension installs itself before `blaz` in a way `blaz`
cannot intercept, preserving that editor while also injecting into the same
border line is not guaranteed.
