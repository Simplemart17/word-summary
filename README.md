# Selah

A passage of Scripture read aloud over quiet music, followed by a short reflection: a summary, key lessons tied to specific verses, cross-references and a prayer. A stained-glass rose window is drawn for each passage and lights up as it is read.

## Run it

```sh
npm install   # once
npm start
```

`npm start` opens <http://localhost:4747> in your browser. It needs Node 20 or newer, and the [Claude Code](https://claude.com/claude-code) CLI installed and signed in with your Claude subscription (run `claude` once in a terminal to check).

The first start downloads the reading voice (about 325 MB, once). The terminal prints "Voice: ready" when it is done; until then the page waits for it before reading.

### On your phone

```sh
npm run start:lan
```

The terminal prints an address such as `http://192.168.1.20:4747`. Open it on a phone that is on the same Wi-Fi. In this mode anyone on that network can open the app and use your Claude subscription through it, so use it at home, not on shared Wi-Fi. Plain `npm start` only answers on this computer.

The reading carries on when the phone's screen is off, and the lock screen's play, pause and next controls work it. Because the phone then treats Selah like a music player, the ring/silent switch does not mute it. Switching to another app may still pause it; that is the phone's rule for web pages.

### From anywhere, in Docker through a Cloudflare tunnel

This runs Selah in a container and gives it a public `https` address. Because that address is on the open internet, Selah asks for a password before showing anything, and the container will not start without one.

1. Copy `.env.example` to `.env` and set `SELAH_PASSWORD` (at least 10 characters).
2. On your own computer run `claude setup-token`, and paste the token it prints into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. This is what lets the container use your Claude subscription. Without it everything works except new reflections.
3. Start it and get the address:

```sh
npm run docker:up     # build and start; the first build takes a few minutes
npm run docker:url    # print the public address
```

Open that address on any device and sign in. The sign-in lasts thirty days on each device.

- `npm run docker:logs` shows what the app is doing, and `npm run docker:down` stops it and closes the tunnel.
- The address is a random `trycloudflare.com` one and **changes every time the tunnel starts**. For a fixed address on your own domain, create a tunnel in the Cloudflare dashboard, point its public hostname at `http://selah:4747`, put its token in `.env` as `TUNNEL_TOKEN`, and set `COMPOSE_PROFILES=named`.
- Your history and saved reflections stay in `library/` on your computer, shared with the ordinary `npm start`.
- The app is copied into the image when it is built, so after changing any file run `npm run docker:up` again.
- Anyone with both the address and the password can use your Claude subscription through it. Keep both to yourself, and change the password in `.env` (then `npm run docker:up`) if it gets out; that signs every device out.

## What it does

**Choosing a passage.** The Bible is divided into 2,680 sections: a story, a parable, a psalm, a step in an argument. Very short sections are joined to a neighbour and very long ones divided, so each is 5 to 30 verses. From "Choose a passage" you can:

- be given one you have not had before, from anywhere, one testament or one book;
- open today's passage, which is the same all day;
- read in order, a section at a time, from any book;
- go to a reference such as `John 3:16-21` or `Psalm 23` (up to 60 verses).

"Next passage" repeats whichever of the first or third you last chose.

**The reflection.** Claude writes it, and then a second Claude call reads it against the passage and the creeds before you see it. A note at the foot of each reflection says what the second reading found. Small faults are corrected and listed; a draft with a serious fault is thrown away and written again once, and if that also fails nothing is shown. Settings let you choose its length (short, standard, long) and the tradition it is written for.

**Questions.** Under the reflection you can ask about the passage. Answers follow the same rules but are not given the second check.

**History and favourites.** Every passage you open is listed under History, and you can mark favourites. Reflections and answers are saved in `library/`, so reopening a passage costs nothing and takes no time.

**The voice.** Claude writes text, not audio, so the reading is done by [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open-weight neural voice that runs on your own computer. It is free, needs no account, and sends nothing to a speech service. Settings has six voices and a pace control. Names the voice gets wrong are respelled for it first; the list is `pronunciations.json`.

**The music.** A few slow chords in a mode chosen for the kind of writing, made in the browser with no audio files. Settings has four styles: soft pad and bells, soft pad alone, organ, harp.

**Sleep timer.** Stop at the end of the passage, or keep passages coming for 15 to 60 minutes and then fade out. Each further passage is a new reflection, so a long timer uses more of your subscription.

**Save as audio.** Mixes the whole reading, voice over music, into one file in your Downloads folder. It is an `.m4a` if `ffmpeg` or macOS's `afconvert` is on the computer, and a much larger `.wav` if not.

**The window.** The outer ring has one pane per verse, lit as that verse is read. The glass colours show which part of the Bible the passage is from, and the pattern is drawn from the reference, so a passage always gets the same window. Click a pane, or a verse number, to read from that verse.

## Keeping the reflections faithful

`prompt.js` holds everything Claude is told. The writer must say only what the passage says, read it in context, and stay within what Christians confess together in the Apostles' and Nicene Creeds. By default, where the Catholic, Orthodox and Protestant traditions read a passage differently, it keeps to the common ground and names the difference in a separate "Where Christians differ" note. If you choose a tradition in Settings, it may explain that tradition's reading, labelled as such, and still notes that others differ. Every lesson cites the verses it rests on, and the page links each lesson back to them.

The second reader is given the same standard and looks for things stated as being in the passage that are not, teaching that departs from the creeds, promises lifted out of their setting, lessons their verses do not support, and cross-references that are wrong.

This lowers the risk of error; it cannot remove it. The reflections are a study aid, not an authority.

## Cost

The app uses your Claude subscription, never an API key (`ANTHROPIC_API_KEY` is removed from the environment for every call). A new reflection is two Claude calls, the writing and the check, and takes roughly half a minute to a minute; the passage is read aloud meanwhile. A question is one call. Anything already in `library/` is free.

## Files

| Part | What it does |
| --- | --- |
| `server.js` | Serves the page and answers its requests |
| `scripture.js` | The Bible text, its sections, and finding a passage |
| `reflect.js` | Writing, checking and saving reflections; answering questions |
| `prompt.js` | Everything Claude is told |
| `library.js` | History, favourites, reading progress and saved reflections |
| `voice.js`, `voice-worker.js` | The reading voice, run on its own thread |
| `auth.js` | The password sign-in, used when `SELAH_PASSWORD` is set |
| `Dockerfile`, `compose.yaml`, `.env.example` | Running in Docker behind a Cloudflare tunnel |
| `pronunciations.json` | Respellings for names the voice gets wrong |
| `data/` | The two translations and the section breaks |
| `public/` | The page: `app.js`, the window, the music, the narrator, the recorder |
| `library/` | Your own data, created on first use and not kept in git |

## Settings in the environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4747` | Port the server listens on |
| `SELAH_MODEL` | `opus` | Model alias or full name passed to `claude --model` |
| `SELAH_EFFORT` | `medium` | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max` |
| `SELAH_REVIEW` | on | `off` skips the second check, halving the cost of a new reflection |
| `SELAH_CLAUDE_BIN` | found automatically | Path to the `claude` executable |
| `SELAH_VOICE` | full | `small` uses a 90 MB voice model that sounds slightly rougher |
| `SELAH_PASSWORD` | none | Ask for this password before showing anything (at least 10 characters) |
| `HOST` | this computer only | Address to listen on; the container sets `0.0.0.0` |
| `SELAH_LIBRARY` | `library/` | Another folder for history and saved reflections, for example when testing |

`npm run dev` restarts the server when a file changes and does not open the browser.

## Adding to it

- **A name is mispronounced.** Add it to `pronunciations.json` with a plain respelling (`"Job": "Jobe"`) and restart. The respelling is only ever spoken, never shown.
- **More voices.** Add them to `VOICES` in `voice.js`; the Kokoro model card lists them all.
- **Another tradition, or different rules.** Edit `TRADITIONS` or the standard at the top of `prompt.js`.

## Sources

The World English Bible and the King James Version are in the public domain; the text came from the [getbible.net](https://getbible.net) v2 API (`scripts/build-data.mjs`). The section breaks are the positions of the headings in the Berean Standard Bible, also in the public domain (`scripts/build-sections.mjs`); only the positions are used, not its text.
