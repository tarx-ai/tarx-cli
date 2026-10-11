#!/usr/bin/env python3
"""TARX local control surface. Textual TUI, not a plain terminal chat."""

import json
import os
import subprocess
import urllib.request
from datetime import datetime

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.events import Key
from textual.markup import escape
from textual.widgets import Static, TextArea

URL = os.environ.get("TARX_CHAT_URL", "http://127.0.0.1:11450")
KEY = os.environ.get("TARX_CHAT_KEY", "")
PROMPT = os.environ.get("TARX_CHAT_PROMPT", "")
HIST = os.environ.get("TARX_CHAT_HIST", "")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff"}
MODES = ("normal", "plan", "ask", "always-approve")
MODE_NOTE = {
    "normal": "",
    "plan": "Reply with a short plan only. Do not claim you executed anything.\n\n",
    "ask": "If one fact is missing, ask one question. Do not claim you executed anything.\n\n",
    "always-approve": "The operator is in always-approve. This chat has no tools. Do not claim you ran any.\n\n",
}
COMMANDS = (
    ("/exit", "Leave TARX"),
    ("/clear", "Clear the screen, keep memory"),
    ("/presence", "Read Always On presence"),
    ("/glyph", "Read the local Glyph loop"),
    ("/mode", "Cycle compose mode"),
    ("/help", "Show the shortcut chrome"),
)
LOGO = """
        *****      ******      *****
       *******     ******     *******
      ********    ********    ********
      *********   ********    ********
     **********  **********  **********
     ***** ***** ********** ***** *****
     ***** **********  ********** ******
    *****  **********  **********  *****
      **    *********  *********
            ********    ********
             ******      ******
****          ****        ****          ****
****                                    ****
*****                                  *****
 *****                                *****
  ******                            ******
    ******                        ******
     *******                    *******
       **********           *********
          ************************
              ****************
""".strip("\n")


def system_text():
    base = "You are TARX."
    try:
        base = open(PROMPT, encoding="utf-8").read()
    except Exception:
        pass
    live = ""
    sh = os.path.expanduser("~/.tarx/bin/tarx-live-context.sh")
    if os.path.isfile(sh):
        try:
            live = subprocess.check_output([sh], stderr=subprocess.DEVNULL, timeout=8).decode()
        except Exception:
            live = ""
    return base + "\n\n" + live


def load_history():
    h = [{"role": "system", "content": system_text()}]
    try:
        prior = json.load(open(HIST, encoding="utf-8"))
        prior = [m for m in prior if m.get("role") in ("user", "assistant")][-12:]
        h.extend(prior)
    except Exception:
        pass
    return h


def save_history(h):
    if not HIST:
        return
    keep = []
    for m in h:
        if m.get("role") not in ("user", "assistant"):
            continue
        c = m.get("content")
        if not isinstance(c, str):
            c = "[photo]"
        keep.append({"role": m["role"], "content": c})
    try:
        os.makedirs(os.path.dirname(HIST), exist_ok=True)
        json.dump(keep[-40:], open(HIST, "w", encoding="utf-8"))
    except Exception:
        pass


def clipboard_info():
    try:
        return subprocess.check_output(
            ["osascript", "-e", "clipboard info"], stderr=subprocess.DEVNULL, timeout=3
        ).decode()
    except Exception:
        return ""


def clipboard_image():
    info = clipboard_info()
    if not any(k in info for k in ("PNGf", "TIFF", "JPEG", "GIFf")):
        return None
    dest = f"/tmp/tarx-clip-{os.getpid()}.png"
    raw = "/tmp/tarx-clip-raw"
    kind = "PNGf" if "PNGf" in info else "JPEG" if "JPEG" in info else "TIFF" if "TIFF" in info else "GIFf"
    script = f'''
set outPath to POSIX file "{raw}"
try
  set d to the clipboard as «class {kind}»
on error
  return "no"
end try
set f to open for access outPath with write permission
set eof f to 0
write d to f
close access f
return "ok"
'''
    try:
        r = subprocess.check_output(["osascript", "-e", script], stderr=subprocess.DEVNULL, timeout=5).decode().strip()
    except Exception:
        return None
    if r != "ok" or not os.path.isfile(raw) or os.path.getsize(raw) < 16:
        return None
    try:
        subprocess.check_call(
            ["sips", "-s", "format", "png", "-Z", "1280", raw, "--out", dest],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    try:
        os.remove(raw)
    except Exception:
        pass
    return dest if os.path.isfile(dest) else None


def b64_png(path):
    import base64
    return base64.b64encode(open(path, "rb").read()).decode()


def user_content(text, images, mode):
    text = (MODE_NOTE.get(mode) or "") + (text or "")
    if not images:
        return text
    parts = [{"type": "text", "text": text.strip() or "Look at the attached photo."}]
    for p in images:
        parts.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64_png(p)}})
    return parts


def stream_reply(messages, on_delta):
    body = json.dumps({
        "model": "tarx/t-supercomputer",
        "messages": messages,
        "stream": True,
        "max_tokens": 1024,
    }).encode()
    req = urllib.request.Request(
        URL.rstrip("/") + "/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
        method="POST",
    )
    full = []
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except Exception as e:
        detail = ""
        if hasattr(e, "read"):
            try:
                detail = e.read().decode()[:300]
            except Exception:
                detail = ""
        return "", (detail or str(e))[:300]
    for raw in resp:
        line = raw.decode(errors="replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            delta = json.loads(payload).get("choices", [{}])[0].get("delta", {}).get("content") or ""
        except Exception:
            continue
        if delta:
            full.append(delta)
            on_delta("".join(full))
    return "".join(full), ""


def read_presence():
    try:
        return json.load(open(os.path.expanduser("~/.tarx/always-on/presence.json")))
    except Exception:
        return {}


def fuzzy(query):
    q = query.strip().lower()
    if not q.startswith("/"):
        return []
    needle = q[1:]
    hits = []
    for name, help_text in COMMANDS:
        body = name[1:]
        if needle in body or all(ch in body for ch in needle):
            hits.append((name, help_text))
    return hits[:6]


class Composer(TextArea):
    async def _on_key(self, event: Key) -> None:
        app = self.app
        if event.key == "enter":
            event.stop()
            event.prevent_default()
            app.submit_from_keys()
            return
        if event.key == "shift+enter":
            event.stop()
            event.prevent_default()
            self.insert("\n")
            return
        if event.key in ("up", "down") and app.palette_open:
            event.stop()
            event.prevent_default()
            app.move_palette(-1 if event.key == "up" else 1)
            return
        await super()._on_key(event)


class Turn(Static):
    def __init__(self, who: str, text: str = "", **kwargs):
        super().__init__(**kwargs)
        self.who = who
        self.body = text
        self.cursor = False
        self.add_class(who)

    def on_mount(self) -> None:
        self.redraw()

    def set_body(self, text: str, cursor: bool = False) -> None:
        self.body = text
        self.cursor = cursor
        self.redraw()

    def redraw(self) -> None:
        label = {"user": "you", "tarx": "tarx", "sys": "sys"}.get(self.who, self.who)
        caret = " [cyan]▌[/]" if self.cursor else ""
        self.update(f"[b]{label}[/]  {escape(self.body)}{caret}")


class TarxChat(App):
    TITLE = "TARX"
    CSS = """
    Screen { background: #0c0c10; color: #d7dbe6; }
    #status {
        height: 2;
        background: #101014;
        color: #d7dbe6;
        padding: 0 1;
        border-bottom: solid #1c2430;
    }
    #log { height: 1fr; padding: 1 1 0 1; background: #0c0c10; }
    #empty { color: #00e5ff; padding: 1 2; }
    #tagline { color: #8b93a7; padding: 0 2 1 2; }
    Turn { margin: 0 0 1 0; }
    Turn.user { color: #d7dbe6; }
    Turn.tarx { color: #d7dbe6; }
    Turn.sys { color: #ffb000; }
    Turn.user Static, Turn.user { color: #d7dbe6; }
    #dock { height: auto; max-height: 7; background: #14141c; padding: 0 1; display: none; }
    #dock.open { display: block; border-top: solid #ff2d6a; }
    #chips { height: 1; color: #00e5ff; padding: 0 1; display: none; }
    #chips.on { display: block; }
    Composer, TextArea {
        height: auto;
        max-height: 8;
        min-height: 1;
        background: #0c0c10;
        border: none;
        padding: 0 1;
    }
    Composer:focus, TextArea:focus { border: none; }
    #rule { height: 1; color: #00e5ff; }
    #chrome { height: 1; background: #101014; color: #8b93a7; padding: 0 1; }
    .help-on { color: #00e5ff; }
    """
    BINDINGS = [
        Binding("shift+tab", "cycle_mode", "Mode", priority=True),
        Binding("ctrl+x", "toggle_help", "Shortcuts", priority=True),
        Binding("ctrl+v", "attach", "Photo", priority=True),
        Binding("escape", "clear_or_close", "Clear", priority=True, show=False),
    ]

    def __init__(self):
        super().__init__()
        self.messages = load_history()
        self.mode_i = 0
        self.images = []
        self.busy = False
        self.queue = []
        self.help_on = False
        self.palette_rows = []
        self.palette_i = 0
        self.pulse = False
        self.reply = None

    def compose(self) -> ComposeResult:
        yield Static("", id="status")
        yield VerticalScroll(id="log")
        yield Static("", id="dock")
        yield Static("", id="chips")
        yield Static("─", id="rule")
        yield Composer("", id="composer", soft_wrap=True, show_line_numbers=False)
        yield Static("", id="chrome")

    def on_mount(self) -> None:
        log = self.query_one("#log", VerticalScroll)
        prior = [m for m in self.messages if m.get("role") in ("user", "assistant")]
        if prior:
            for m in prior:
                who = "user" if m["role"] == "user" else "tarx"
                log.mount(Turn(who, m.get("content") or ""))
        else:
            mark = LOGO if self.size.height >= 40 else "TARX"
            log.mount(Static(escape(mark), id="empty"))
            log.mount(Static("FREE TO THINK  ·  v1.1.0  ·  Designed in Austin TX.", id="tagline"))
        self.set_interval(1.0, self.tick)
        self.tick()
        self.paint_chrome()
        self.query_one("#composer", Composer).focus()

    @property
    def mode(self) -> str:
        return MODES[self.mode_i]

    @property
    def palette_open(self) -> bool:
        return bool(self.palette_rows)

    def tick(self) -> None:
        self.pulse = not self.pulse
        p = read_presence()
        services = p.get("services") or {}
        stress = p.get("stress") or []
        runtime = p.get("runtime") or "unknown"
        armed = p.get("mode") or "unknown"
        presence = "Always On" if armed == "armed" else armed
        path = "Supercomputer" if runtime == "up" else runtime

        def dot(name):
            up = services.get(name) == "up"
            color = "#00e5ff" if up and self.pulse else ("#1a6f86" if up else "#ffb000")
            return f"[{color}]●[/]"

        stress_bit = "[#ffb000]stress[/]" if stress else "[#00e5ff]clear[/]"
        clock = datetime.now().strftime("%H:%M")
        line1 = "[cyan]TARX[/]  [dim]FREE TO THINK · v1.1.0 · Designed in Austin TX[/]"
        line2 = (
            f"[cyan]{path}[/]  ·  {presence}  ·  session live"
            f"          inference {dot('model')}  mesh {dot('gateway')}  cognitive {dot('cognitive')}"
            f"   {stress_bit}   {clock}"
        )
        self.query_one("#status", Static).update(line1 + "\n" + line2)
        rule = self.query_one("#rule", Static)
        rule.update("─" * max(20, self.size.width))

    def paint_chrome(self) -> None:
        photo = f"  ·  ▣ {len(self.images)}" if self.images else ""
        think = "  ·  thinking" if self.busy else ""
        queued = f"  ·  {len(self.queue)} queued" if self.queue else ""
        keys = "shift+tab mode · ctrl+x shortcuts · / commands · ctrl+v photo · enter sends"
        if self.help_on:
            keys = "shift+enter newline · esc clears · /exit /presence /glyph /clear /mode"
        self.query_one("#chrome", Static).update(
            f"[cyan]TARX 1.1 · local · {self.mode}[/]{photo}{think}{queued}    [dim]{keys}[/]"
        )
        chips = self.query_one("#chips", Static)
        if self.images:
            chips.update("  " + "  ".join("▣ photo" for _ in self.images[:4]))
            chips.add_class("on")
        else:
            chips.remove_class("on")
            chips.update("")

    def paint_palette(self) -> None:
        dock = self.query_one("#dock", Static)
        if not self.palette_rows:
            dock.remove_class("open")
            dock.update("")
            return
        lines = []
        for i, (name, help_text) in enumerate(self.palette_rows):
            if i == self.palette_i:
                lines.append(f"[black on cyan] {name:<12} {help_text} [/]")
            else:
                lines.append(f"[cyan]{name:<12}[/] [dim]{help_text}[/]")
        dock.update("\n".join(lines))
        dock.add_class("open")

    def on_text_area_changed(self, event: TextArea.Changed) -> None:
        text = event.text_area.text
        if text.startswith("/"):
            self.palette_rows = fuzzy(text.splitlines()[0] if text else "")
            self.palette_i = min(self.palette_i, max(0, len(self.palette_rows) - 1))
        else:
            self.palette_rows = []
        self.paint_palette()

    def move_palette(self, step: int) -> None:
        if not self.palette_rows:
            return
        self.palette_i = (self.palette_i + step) % len(self.palette_rows)
        self.paint_palette()

    def action_cycle_mode(self) -> None:
        self.mode_i = (self.mode_i + 1) % len(MODES)
        self.paint_chrome()

    def action_toggle_help(self) -> None:
        self.help_on = not self.help_on
        self.paint_chrome()

    def action_attach(self) -> None:
        path = clipboard_image()
        if not path:
            self.note("No photo on the clipboard.")
            return
        if len(self.images) >= 4:
            self.note("Four photos is the limit for one turn.")
            return
        self.images.append(path)
        self.paint_chrome()

    def action_clear_or_close(self) -> None:
        if self.palette_rows:
            self.palette_rows = []
            self.paint_palette()
            return
        box = self.query_one("#composer", Composer)
        if box.text:
            box.clear()

    def note(self, text: str) -> None:
        self.query_one("#log", VerticalScroll).mount(Turn("sys", text))
        self.query_one("#log", VerticalScroll).scroll_end(animate=False)

    def clear_empty(self) -> None:
        log = self.query_one("#log", VerticalScroll)
        for ident in ("#empty", "#tagline"):
            try:
                log.query_one(ident).remove()
            except Exception:
                pass

    def run_command(self, name: str) -> None:
        self.query_one("#composer", Composer).clear()
        self.palette_rows = []
        self.paint_palette()
        if name == "/exit":
            self.exit()
        elif name == "/clear":
            self.query_one("#log", VerticalScroll).remove_children()
            self.query_one("#log", VerticalScroll).mount(
                Static("FREE TO THINK  ·  screen cleared. Memory is still on disk.", id="tagline")
            )
        elif name == "/mode":
            self.action_cycle_mode()
            self.note(f"Mode is {self.mode}.")
        elif name == "/help":
            self.help_on = True
            self.paint_chrome()
            self.note("shift+tab cycles mode. ctrl+v attaches a photo. /presence and /glyph read the live runtime.")
        elif name == "/presence":
            p = read_presence()
            stress = p.get("stress") or ["none"]
            self.note(
                f"runtime {p.get('runtime', 'unknown')} · mode {p.get('mode', 'unknown')}\n"
                + "\n".join(stress)
            )
        elif name == "/glyph":
            script = os.path.expanduser("~/.tarx/bin/tarx-glyph.sh")
            try:
                out = subprocess.check_output([script], stderr=subprocess.STDOUT, timeout=8).decode()
            except Exception as exc:
                out = str(exc)
            self.note(out.strip()[:1200] or "glyph returned nothing")

    def submit_from_keys(self) -> None:
        box = self.query_one("#composer", Composer)
        text = box.text
        first = text.strip().splitlines()[0] if text.strip() else ""
        if self.palette_rows and first.startswith("/"):
            name = self.palette_rows[self.palette_i][0]
            if first == name or first == self.palette_rows[0][0]:
                self.run_command(name if first == name or len(self.palette_rows) == 1 else self.palette_rows[self.palette_i][0])
                return
            if len(self.palette_rows) == 1:
                self.run_command(self.palette_rows[0][0])
                return
        if text.strip() in ("exit", "quit", ":q") and not self.images:
            self.exit()
            return
        if not text.strip() and not self.images:
            return
        payload = (text, list(self.images), self.mode)
        box.clear()
        self.images.clear()
        self.palette_rows = []
        self.paint_palette()
        self.paint_chrome()
        if self.busy:
            self.queue.append(payload)
            self.paint_chrome()
            return
        self.begin(*payload)

    def begin(self, text: str, images: list, mode: str) -> None:
        if not KEY:
            self.note("Supercomputer door needs its key.")
            return
        self.clear_empty()
        label = text.strip()
        if images:
            label = (label + "\n" if label else "") + f"▣ {len(images)} photo" + ("s" if len(images) != 1 else "")
        log = self.query_one("#log", VerticalScroll)
        log.mount(Turn("user", label or "▣ photo"))
        self.reply = Turn("tarx", "door · tarx/t-supercomputer")
        self.reply.cursor = True
        log.mount(self.reply)
        log.scroll_end(animate=False)
        self.messages.append({"role": "user", "content": user_content(text, images, mode)})
        self.busy = True
        self.paint_chrome()
        self._stream()

    @work(thread=True, exclusive=False)
    def _stream(self) -> None:
        reply = self.reply

        def on_delta(text: str) -> None:
            self.call_from_thread(reply.set_body, text, True)

        ans, err = stream_reply(self.messages, on_delta)

        def done() -> None:
            if err and not ans:
                reply.set_body("The door did not take that turn. " + err, False)
            elif not ans:
                reply.set_body("No response. The door may be cold. Try again.", False)
            else:
                reply.set_body(ans, False)
                self.messages.append({"role": "assistant", "content": ans})
            for i in range(len(self.messages) - 1, -1, -1):
                if self.messages[i].get("role") == "user":
                    self.messages[i] = {"role": "user", "content": label or "[photo]"}
                    break
            save_history(self.messages)
            self.busy = False
            self.reply = None
            self.query_one("#log", VerticalScroll).scroll_end(animate=False)
            nxt = self.queue.pop(0) if self.queue else None
            self.paint_chrome()
            if nxt:
                self.begin(*nxt)

        self.call_from_thread(done)


def main():
    if not KEY:
        raise SystemExit("Supercomputer door needs its key.")
    TarxChat().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
