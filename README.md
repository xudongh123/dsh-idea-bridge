# dsh-idea-bridge

A two-way bridge between [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) and IntelliJ IDEA.

- **DSH → IDEA**: right-click any file in DSH and open it in IDEA, on the right line.
- **IDEA → DSH**: right-click a selection (or a whole file) in IDEA and drop it into a running
  DSH session as a real `@` reference — it lands in the composer, it is **not** sent.

It is two halves that talk over a local HTTP route the DSH plugin owns:

```
┌────────────────────┐        /dsh-idea/*        ┌────────────────────┐
│  DSH (web + Host)  │ ◄───────────────────────► │  IntelliJ IDEA     │
│  dsh-idea-bridge   │   idea://open?file&line   │  DSH Bridge plugin │
└────────────────────┘                           └────────────────────┘
```

## Features

### In DSH

Every `file` context menu gains **在 IDEA 中打开 / Open in IDEA** — chat file references, the
workspace file tree, and changed-file cards:

```
open "idea://open?file=/abs/path&line=42"
```

IDEA is launched if it is not running, or focused on the matching project with the caret on that
line.

### In IDEA

Two actions in the editor context menu (`Send File to DSH` is also in the project tree):

| Action | Needs a selection | Result |
| --- | --- | --- |
| `Send Selection to DSH` | yes | a reference chip labelled `file.tf:12-21` in the composer |
| `Send File to DSH` | no | a reference chip for the whole file |

The target session is the one whose working directory equals the open project; when several
sessions share that directory, a chooser lists them by title. The draft is parked on the Host and
claimed by the browser half within about a second, then inserted through the composer's own
`insertReference()` — so it is a real chip, not pasted text.

## Install

### DSH half

From inside a running DSH session, install the bundle from this directory:

```
plugin_manager  action: "install_bundle"  target: "/absolute/path/to/dsh-idea-bridge"
```

The package is linked, not copied, so edits in the checkout are picked up by toggling
`include:idea-bridge` off and on.

The Host writes `~/.dsh/idea-bridge.json` with its current origin on every launch — the web port
changes each start, and the IDEA half reads that file instead of guessing.

### IDEA half

No Gradle: the plugin compiles against the jars shipped inside the IDE.

```bash
cd idea-plugin
./build.sh

cp build/dsh-idea-bridge.jar \
  "$HOME/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/dsh-idea-bridge/lib/"
```

Restart IDEA. Adjust the version directory for your installation.

Two build details worth knowing:

- The IntelliJ 2026.2 platform jars are **Java 25 bytecode** (class file 69), so the compiler must
  be the bundled JetBrains Runtime (`Contents/jbr/.../javac`); a system JDK 17 cannot even read
  them.
- The HTTP client must pin `HttpClient.Version.HTTP_1_1`. Java's default sends an h2c upgrade
  (`Connection: Upgrade, HTTP2-Settings`), and the DSH web server closes the socket on it — the
  client only sees `HTTP/1.1 header parser received no bytes`.

## Host routes

| Method | Path | Payload | Effect |
| --- | --- | --- | --- |
| POST | `/dsh-idea/open` | `{ file, line? }` | open an absolute path in IDEA |
| POST | `/dsh-idea/draft` | `{ sessionId, text, file?, line?, endLine? }` | park a selection draft |
| POST | `/dsh-idea/card` | `{ sessionId, file \| path \| seq+index[+source] }` | park a whole-file reference |
| POST | `/dsh-idea/pending` | `{ sessionId }` | browser claims the parked draft |
| POST | `/dsh-idea/repark` | `{ sessionId, draft }` | put a draft back after a failed insert |
| POST | `/dsh-idea/send` | `{ sessionId, text, file?, line? }` | queue the text as a user message and send it |
| GET | `/dsh-idea/sessions` | – | live sessions (`id`, `title`, `cwd`) |
| GET | `/dsh-idea/status` | – | health: IDEA installed, origin, endpoint list |

Security: only `content-type: application/json` is accepted (a cross-site form post cannot pass
that without a preflight this server never approves), and when an `Origin` header is present it
must equal the server's own origin. No route reads file contents.

## Layout

```
index.js              Host half: routes, draft parking, `open` invocation
client.js             Browser half: context menu item, composer inbox, card action
cordis.patch.yml      bundle patch that inserts the plugin
locale/{zh,en}.json   plugin card copy
idea-plugin/          the IntelliJ plugin (Java, no Gradle)
```

The browser half needs no build step: it is a plain `window.__ModuleLoader__.load({...})` module.
After editing either half, toggle `include:idea-bridge` off and on in `plugin_manager`; the file
change alone does not hot-reload.

## Known limitations

- `@` references resolve to a whole file. DSH's reference grammar has no `#L12-21` form, so a
  selection's line range lives in the chip label, not in the reference itself.
- A file outside the session workspace is parked by absolute path. The reference resolver passes
  absolute paths through untouched, but whether the session may read it depends on its sandbox.
- The visible action slot only exists on presented-file cards and the changes review tab; inline
  diff cards in the chat expose no slot, so there the context menu is the entry point.

## License

MIT
