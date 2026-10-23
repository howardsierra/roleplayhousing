# Roleplay Housing

A SillyTavern extension that tracks **where `{{char}}` and `{{user}}` live**: the type of home, its location, a room-by-room layout, amenities and notes. It feeds that to the model on every generation so homes stay consistent across a roleplay.

Inspired by [ST-Estate](https://github.com/Nufahi/ST-Estate). Estate builds lorebook entries for buildings. This extension stays smaller: it keeps one housing sheet per chat and injects it directly.

## Features

- **Auto-fill from the card.** When you open a chat that has no housing yet, the extension checks the character card (description, personality, scenario, first message) and your persona. If they mention a home, the model extracts it into the editor for you. It only records what the text says; it doesn't invent anything.
- **Everything stays editable.** Imported homes get a "from card" badge, and you can change any of their fields.
- **Describe it yourself.** If the card says nothing, add `{{char}}`'s home, `{{user}}`'s home, or a shared home, and fill in as much or as little as you like.
- **Flesh out.** Type one sentence (e.g. *"a cozy rundown farmhouse with a big porch"*) and click **Flesh out**. The model proposes a layout and amenities. Anything you already wrote is kept.
- **Living arrangement.** Choose whether they live together, live separately, or leave it unspecified.
- **Prompt injection** with a configurable position, depth, role and template. A live preview shows exactly what is sent.
- Saved **per chat**, so different stories with the same character can have different homes.

## Install

In SillyTavern, open **Extensions → Install extension** and paste this URL:

```
https://github.com/howardsierra/roleplayhousing
```

## Usage

- Open the editor from the **magic wand menu → Housing**, from **Extensions → Roleplay Housing → Open housing editor**, or with `/housing`.
- `/housing-detect` reads the card and persona again, merges the result, and opens the editor. Homes you added by hand are kept; earlier card-imported homes for the same owner are replaced.
- `/housing-get` returns the injected housing text, which you can pipe into other commands.
- Macros: `{{housing}}`, `{{char_home}}`, `{{user_home}}` can be used in presets, Author's Note, etc.

## Settings

| Setting | Default | |
|---|---|---|
| Inject housing into the prompt | on | Turn injection off without losing data. |
| When a chat has no housing yet | Read the card automatically | Or *Ask first* (shows a clickable toast), or *Do nothing*. A model call is only made when the card/persona contains housing-related words. |
| Injection position / depth / role | After story string, 4, System | Same choices as Author's Note. |
| Prompt template | — | `{{housing}}` is replaced with the housing block. |
| Include room-by-room layout | on | Turn off to save tokens. |
| Max tokens | 1200 | Response length for card reading and Flesh out. |

Card reading and Flesh out use your current main API through `generateRaw`.
