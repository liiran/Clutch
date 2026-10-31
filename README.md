# Clutch

**Build with bricks in your browser. Describe what you want, check the preview, and watch it snap together.**

<p align="center">
  <img src="docs/media/demo.gif" alt="Clutch building a house from a chat message: the title drops onto the baseplate, the Start building button is pressed and the last brick clicks into place, a request for a small house appears as a translucent preview that is dragged to a new spot and drops into place when applied, a second request adds a path, trees and a fence, and then the Replay button plays the model going together." width="800">
</p>

<p align="center"><em>A real recording: one request builds a house, a second adds a garden to it, and Replay plays it back. <a href="docs/media/demo.mp4">Sharper video (MP4)</a>.</em></p>

## Start it

You need [Node.js](https://nodejs.org) 22.6 or newer.

```bash
npm install
npm run dev
```

Then open **http://127.0.0.1:5173/**. On Windows, you can double-click `start-local.bat` instead, which does all of this for you.

Clutch runs only on your own computer.

## Connect the chat

Building by hand works straight away. The chat needs one of these:

- **Claude Code:** install [Claude Code](https://claude.com/claude-code) and sign in. There is nothing else to set up. With a Claude subscription, messages count toward your plan's usage limits.
- **An Anthropic API key:** copy `.env.example` to `.env.local`, set `ANTHROPIC_API_KEY`, and restart. The key stays on your computer. Each message is billed to your API account, so set a spend limit in the [Claude Console](https://console.anthropic.com).

If a key is set, the chat uses it instead of Claude Code. The top of the chat panel shows which model and connection are in use.

The chat uses Sonnet unless you set `CLUTCH_CLAUDE_MODEL` in `.env.local`. You can use `haiku` (cheapest), `sonnet`, `opus`, or a full model name. See `.env.example` for the other settings.

## Ask the chat to build

Type what you want. It appears as a see-through preview, and nothing changes until you press **Apply**.

<p align="center">
  <img src="docs/media/preview.png" alt="A translucent preview of a white house with a red roof on a green baseplate. The chat panel on the right shows the request, the reply, a green Checked card reading all attached, nothing overlapping, and a bar with Discard and Apply buttons." width="760">
</p>

Drag the preview to move it, or press R to turn it. It turns red where it doesn't fit.

Every piece is checked before you see it: nothing can overlap, and every piece has to connect back to the baseplate. If there is a problem, the model gets one chance to fix it. The card in the chat tells you how it went.

Then keep going. The chat sees your current build, so you can add to it, change colours or take things away.

<p align="center">
  <img src="docs/media/garden.png" alt="The finished build seen from the front: a white house with a red roof and door, two windows, a tree on each side, a sand path and a white fence with a gap for the path. The chat panel shows both requests and their replies." width="760">
</p>

## Or build by hand

Pick a part and a colour on the left, then click the baseplate. A ghost shows where the piece will land.

<p align="center">
  <img src="docs/media/by-hand.gif" alt="Picking a blue brick and placing two on the baseplate, then stacking yellow bricks and red slopes on top, then painting one piece white and selecting another." width="760">
</p>

| Input | What it does |
|---|---|
| Left drag, right drag, scroll | Orbit, pan, zoom |
| V, B, P, E | Select, Place, Paint, Erase |
| R | Rotate |
| Alt + click | Pick up a part and its colour |
| G, C | Move or copy the selected piece |
| Delete | Delete the selected piece |
| H | Hide or show the chat |
| F | Frame the build |
| Esc | Stop, or deselect |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| ? | Show these in the app |

## Replay and parts

**Replay** plays your model from the baseplate up, step by step, like an instruction booklet. **Parts list** shows every piece and every step.

<p align="center">
  <img src="docs/media/replay.png" alt="The house partway through a replay, with the roof not yet on and the walls half built. A bar along the bottom shows step 9 of 23, the pieces in this step, a slider and speed control." width="49%">
  <img src="docs/media/parts.png" alt="The Parts list: pieces with pictures and counts on the left, and numbered build steps on the right." width="49%">
</p>

## Keep your work

Builds save by themselves in your browser. **My builds** has the rest:

- **Saved builds:** your latest 24.
- **Download:** a `.clutch` file you can keep or move to another computer.
- **Share:** copies a link with the whole build inside it. It only works where Clutch is running, so use Download to send a build to someone else.

## The rules

- The baseplate is 64 × 64 studs, and builds can reach 32 bricks tall with up to 3000 pieces.
- There are 44 parts in 22 colours.
- Pieces sit on a stud grid and turn in quarter turns. They cannot overlap.
- By hand, a piece with nothing to grip is allowed and flagged.

## How it works

1. Your request and the current build go to a small local server (`server/api.ts`).
2. It asks Claude, through Claude Code (`server/claude-cli.ts`) or your API key (`server/anthropic-api.ts`). Claude has no tools, so it cannot touch your files. It can only return a list of build actions.
3. The server checks those actions against the rules (`src/core/actions.ts`) and sends any problems back once to be fixed.
4. Your browser shows the result as a preview, ready to apply or discard.

```
src/core/      the rules, shared by the browser and the server
src/render/    the 3D scene: models, drawing, sound and part pictures
src/app/       the editor: tools, parts menu, chat, replay, saving and the opening
src/styles/    the look
server/        the local server, the two Claude connections and the prompt
tests/         automated tests, including the real editor in Chrome
bench/         real test requests, and the recordings in this file
```

Clutch is built to stay light on a weak computer. It draws only when something changes, and lowers its quality by itself if drawing falls behind.

## Development

```bash
npm test            # the rules, the server and both Claude connections
npm run test:e2e    # the real editor in Chrome (needs npm run dev running)
npm run build       # type checks and a production build
npm run perf        # frame times on a 3000 piece build
npm run landing     # what the opening costs (CLUTCH_SOFTWARE=1 for no GPU)
npm run bench       # real prompts through the real model
npm run media       # re-records the pictures and videos here (needs ffmpeg)
```

`npm run bench` and `npm run media` send real chat messages. The other commands make no AI calls.

LEGO is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.
