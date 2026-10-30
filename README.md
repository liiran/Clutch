# Clutch

Build with bricks in your browser. Pick parts and snap them together by hand, or describe what you want in the chat, check the preview, and watch it go together.

Named after clutch power, the grip that holds two bricks together.

## Running it

```bash
npm install
npm run dev
# http://127.0.0.1:5173/        the landing scene
# http://127.0.0.1:5173/?edit   straight to the editor
```

On Windows, `start-local.bat` does the same in its own window.

The chat runs through the [Claude Code](https://claude.com/claude-code) CLI signed in on your computer, so there is no API key to set up. It needs `claude` installed and signed in. The app only runs locally for now. To change the model, copy `.env.example` to `.env.local`:

| Setting | Effect |
|---|---|
| `CLUTCH_CLAUDE_MODEL` | `sonnet` by default, which follows the latest Sonnet. Use a full name, such as `claude-sonnet-4-6`, to pin one. |
| `CLUTCH_CLAUDE_EFFORT` | `medium` by default. Higher builds better and takes longer. |
| `CLUTCH_CLAUDE_BIN` | The path to `claude`, if it cannot be found automatically. |

## How the chat works

```
        "Build a small house with a red roof"
                        |
                        v
             +---------------------+
             |     Local server    |   the request, the build as text,
             |  server/api.ts      |   and the earlier chat
             +---------------------+
                        |
                        v
             +---------------------+
             |    Claude Code CLI  |   no tools, and the reply must match
             |  server/claude-cli  |   a JSON schema of actions
             +---------------------+
                        |
                        v
             +---------------------+
             |    Check the build  |   collisions and floating pieces go
             |  core/actions.ts    |   back to the model once, in detail
             +---------------------+
                        |
                        v
             +---------------------+
             |    Ghost preview    |   the same actions run again in the browser,
             |  Apply or Discard   |   so what was checked is what gets built
             +---------------------+
```

The model works in big actions (`walls`, `fill`, `roof`, `voxels`) and exact ones (`place`). The big actions lay real pieces with staggered joints, so a whole house is a few lines. The server never trusts a reply: every action runs against the same rules as a piece placed by hand.

## Using it

| Input | Action |
|---|---|
| Left drag | Orbit |
| Right drag | Pan |
| Scroll | Zoom |
| V, B, P, E | Select, Place, Paint, Erase |
| R | Rotate |
| Alt + click | Pick up a part and its colour |
| G, C | Move or copy the selected piece |
| Delete | Delete the selected piece |
| Esc | Stop, or deselect |
| F | Frame the build |
| Ctrl+Z, Ctrl+Y | Undo, redo |

**Build** plays the model going together step by step, and **Parts** lists every piece and step. Builds save automatically in the browser, and can be downloaded as `.clutch` files or shared as a link.

## The rules

- The baseplate is 48 × 48 studs, and builds can reach 32 bricks tall with up to 3000 pieces. One chat reply can add up to 1500.
- Pieces sit on a stud grid and turn in quarter turns. They cannot overlap.
- A piece is attached when it grips a stud, in a chain back to the baseplate. By hand, a piece with nothing to grip is allowed and flagged. The chat has to fix them, with one retry.

## Under the hood

| What | How |
|---|---|
| Language | TypeScript, with no UI framework |
| 3D | Three.js. One instanced mesh per part, so a large build is a few dozen draw calls |
| Hover | A ray walked through the occupancy grid, so its cost does not grow with the build |
| Drawing | Only when something changed, and shadows only when the build changes |
| Light by design | Simple lighting, painted baseplate studs, low-detail models and no blur over the 3D view |
| Slow devices | Quality steps down by itself when drawing falls behind, and remembers for next time |
| Build and dev server | Vite |

```
src/core/      the rules, with no browser code; the server runs them too
  parts.ts       the catalogue: footprints, studs, what grips
  grid.ts        occupancy, collisions, the attachment check
  actions.ts     what a list of chat actions builds
  tiling.ts      turns cells into real pieces, with staggered joints
  steps.ts       build order and the parts list
src/render/    Three.js: the stage, generated models, instancing, sound, thumbnails
src/app/       the editor: store, tools, sidebar, chat, replay, projects, landing
server/        the local chat API, the CLI adapter and the prompt
tests/         unit and server tests; e2e/ drives the real editor in Chrome
bench/         real requests through the real chat, with a picture of each result
```

## Testing

```bash
npm test            # the rules, the server and the CLI adapter
npm run test:e2e    # the real editor in Chrome (needs npm run dev running)
npm run perf        # frame times on a 3000 piece build
npm run landing     # what the landing page costs (CLUTCH_SOFTWARE=1 for no GPU)
npm run bench       # real prompts through the real model, with pictures
npm run build       # type checks and a production build
```

LEGO is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.
