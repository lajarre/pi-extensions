# note on the simpler blaz variant

## why this branch exists

The previous `blaz` tried to render the session name **on** the editor's top
border line.

That required taking part in editor ownership via
`ctx.ui.setEditorComponent(...)`.

With `pi-vim` in the mix, that creates a real load-order risk: whichever
extension effectively owns the editor last wins.

## api limit

Pi's current extension API does not expose a way to:

- inspect the already-installed editor component
- wrap an already-installed editor component after the fact
- inject text into the built-in editor border without participating in
  editor ownership

## chosen trade-off here

This simpler branch avoids the clash entirely:

- session name moves to the empty line **above** the input box top border,
  right-aligned
- footer cwd line removes the repeated session name
- no editor ownership / no `setEditorComponent(...)` hook
- `pi-vim` behavior stays intact

So this branch is intentionally the compatibility-first version.
