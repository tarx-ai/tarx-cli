#!/usr/bin/env python3
"""TARX chat, drawn by prompt_toolkit so resize, wrap, and paste stay intact."""

import json
import os
import shutil
import subprocess
import threading
import urllib.request

from prompt_toolkit.application import Application
from prompt_toolkit.filters import Condition
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout.containers import ConditionalContainer, HSplit, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.layout.layout import Layout
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import TextArea

URL = os.environ.get("TARX_CHAT_URL", "http://127.0.0.1:11450")
KEY = os.environ.get("TARX_CHAT_KEY", "")
PROMPT = os.environ.get("TARX_CHAT_PROMPT", "")
HIST = os.environ.get("TARX_CHAT_HIST", "")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff"}

STYLE = Style.from_dict({
    "mark": "#5fd7ff",
    "dim": "#8b93a7",
    "you-label": "#8b93a7",
    "you": "",
    "tarx-label": "#6cb6ff bold",
    "tarx": "",
    "rule": "#6cb6ff",
    "hint": "#8b93a7",
    "chip": "#6cb6ff",
})

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
""".strip("\n").split("\n")


def term_size():
    size = shutil.get_terminal_size((80, 24))
    return size.columns, size.lines


def show_mark():
    _, rows = term_size()
    return rows >= 42


def wrap_words(text, width):
    width = max(16, width)
    out = []
    for para in (text or "").split("\n"):
        if para == "":
            out.append("")
            continue
        line = ""
        for word in para.split(" "):
            if not line:
                line = word
            elif len(line) + 1 + len(word) <= width:
                line += " " + word
            else:
                out.append(line)
                line = word
        out.append(line)
    return out or [""]


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
        if isinstance(c, list):
            texts = [p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text"]
            n = sum(1 for p in c if isinstance(p, dict) and p.get("type") == "image_url")
            text = "\n".join(t for t in texts if t).strip()
            if n:
                text = (text + "\n" if text else "") + f"[photo x{n}]"
            c = text or "[photo]"
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


def file_image(path):
    path = path.strip().strip("'\"")
    path = path.replace("\\ ", " ")
    if not path or "\n" in path or not os.path.isfile(path):
        return None
    if os.path.splitext(path)[1].lower() not in IMG_EXT:
        return None
    dest = f"/tmp/tarx-file-{os.getpid()}.png"
    try:
        subprocess.check_call(
            ["sips", "-s", "format", "png", "-Z", "1280", path, "--out", dest],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    return dest


def b64_png(path):
    import base64
    return base64.b64encode(open(path, "rb").read()).decode()


def user_content(text, images):
    text = text or ""
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
        p = line[5:].strip()
        if p == "[DONE]":
            break
        try:
            delta = json.loads(p).get("choices", [{}])[0].get("delta", {}).get("content") or ""
        except Exception:
            continue
        if delta:
            full.append(delta)
            on_delta("".join(full))
    return "".join(full), ""


def main():
    if not KEY:
        raise SystemExit("Supercomputer door needs its key.")

    messages = load_history()
    turns = []
    for m in messages:
        if m.get("role") not in ("user", "assistant"):
            continue
        c = m.get("content")
        turns.append((m["role"], c if isinstance(c, str) else "[photo]"))

    images = []
    status = {"text": ""}
    busy = {"on": False}
    body_window = {"w": None}

    def fragments():
        cols, _ = term_size()
        width = max(20, cols - 8)
        out = []
        if not turns:
            out.append(("class:dim", "  Message TARX. A paste is one turn.\n"))
            return out
        for role, text in turns:
            label, lstyle, bstyle = ("you ", "class:you-label", "class:you") if role == "user" else ("tarx", "class:tarx-label", "class:tarx")
            rows = wrap_words(text, width)
            for i, row in enumerate(rows):
                prefix = label if i == 0 else " " * len(label)
                out.append((lstyle, prefix + "  "))
                out.append((bstyle, row + "\n"))
            out.append(("", "\n"))
        return out

    def follow():
        w = body_window["w"]
        info = getattr(w, "render_info", None) if w else None
        if info and info.content_height > info.window_height:
            w.vertical_scroll = info.content_height - info.window_height

    log = Window(
        content=FormattedTextControl(fragments),
        wrap_lines=False,
        always_hide_cursor=True,
    )
    body_window["w"] = log

    def composer_height():
        n = composer.buffer.text.count("\n") + 1
        return min(8, max(1, n))

    def line_prefix(lineno, wrap_count):
        return [("class:rule", "│ ")]

    composer = TextArea(
        multiline=True,
        wrap_lines=True,
        height=composer_height,
        prompt="",
        get_line_prefix=line_prefix,
        style="",
        focusable=True,
        complete_while_typing=False,
    )

    def chip_text():
        return [("class:chip", "  " + "  ".join("▣ photo" for _ in images[:4]))]

    def hint_text():
        base = status["text"] or "paste a photo · ctrl-v attaches the clipboard · enter sends · exit leaves"
        return [("class:hint", "  " + base)]

    def header_text():
        if not show_mark():
            return [("class:mark", " TARX"), ("class:dim", "   FREE TO THINK  ·  v1.1.0  ·  Designed in Austin TX.")]
        out = []
        for line in LOGO:
            out.append(("class:mark", line + "\n"))
        out.append(("class:dim", "              FREE TO THINK  ·  v1.1.0  ·  Designed in Austin TX.\n"))
        return out

    def header_height():
        return len(LOGO) + 1 if show_mark() else 1

    root = HSplit([
        Window(FormattedTextControl(header_text), height=header_height, dont_extend_height=True),
        log,
        Window(char="─", style="class:rule", height=1),
        ConditionalContainer(Window(FormattedTextControl(chip_text), height=1), filter=Condition(lambda: bool(images))),
        composer,
        Window(FormattedTextControl(hint_text), height=1, dont_extend_height=True),
    ])

    app_box = {"app": None}

    def paint():
        app = app_box["app"]
        if app is not None:
            follow()
            app.invalidate()

    def attach(path, note):
        if not path:
            status["text"] = "No photo on the clipboard."
            paint()
            return
        if len(images) >= 4:
            status["text"] = "Four photos is the limit for one turn."
            paint()
            return
        images.append(path)
        status["text"] = note
        paint()

    def finish_turn(label, ans, err):
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                messages[i] = {"role": "user", "content": label or "[photo]"}
                break
        if err and not ans:
            turns[-1] = ("assistant", "The door did not take that turn. " + err)
        elif not ans:
            turns[-1] = ("assistant", "No response. The door may be cold. Try again.")
        else:
            turns[-1] = ("assistant", ans)
            messages.append({"role": "assistant", "content": ans})
        save_history(messages)
        busy["on"] = False
        status["text"] = ""
        paint()

    def submit():
        if busy["on"]:
            return
        text = composer.buffer.text
        if text.strip() in ("exit", "quit", ":q") and not images:
            app_box["app"].exit()
            return
        if not text.strip() and not images:
            return
        imgs = list(images)
        label = text.strip()
        if imgs:
            label = (label + "\n" if label else "") + f"▣ {len(imgs)} photo" + ("s" if len(imgs) != 1 else "")
        turns.append(("user", label or "▣ photo"))
        turns.append(("assistant", ""))
        messages.append({"role": "user", "content": user_content(text, imgs)})
        composer.buffer.text = ""
        images.clear()
        busy["on"] = True
        status["text"] = "thinking"
        paint()

        def work():
            def on_delta(so_far):
                turns[-1] = ("assistant", so_far)
                status["text"] = ""

                def ui():
                    paint()
                app = app_box["app"]
                if app is not None:
                    app.loop.call_soon_threadsafe(ui)

            ans, err = stream_reply(messages, on_delta)
            app = app_box["app"]
            if app is not None:
                app.loop.call_soon_threadsafe(lambda: finish_turn(label, ans, err))

        threading.Thread(target=work, daemon=True).start()

    kb = KeyBindings()

    @kb.add("enter", eager=True)
    def _enter(event):
        submit()

    @kb.add("c-j", eager=True)
    def _cj(event):
        submit()

    @kb.add("c-c", eager=True)
    def _cc(event):
        event.app.exit()

    @kb.add("c-d", eager=True)
    def _cd(event):
        if not composer.buffer.text and not images:
            event.app.exit()

    @kb.add("c-v", eager=True)
    def _cv(event):
        img = clipboard_image()
        if img:
            attach(img, "Photo attached. Add a line, or press enter.")
            return
        try:
            t = subprocess.check_output(["pbpaste"], timeout=2).decode()
        except Exception:
            t = ""
        if t:
            composer.buffer.insert_text(t)
        else:
            status["text"] = "Clipboard has no photo."
        paint()

    @kb.add("escape", "enter", eager=True)
    def _break(event):
        composer.buffer.newline()

    app = Application(
        layout=Layout(root, focused_element=composer),
        key_bindings=kb,
        full_screen=True,
        style=STYLE,
        mouse_support=True,
    )
    app_box["app"] = app

    # A pasted image path becomes a chip instead of text.
    original_insert = composer.buffer.insert_text

    def insert_text(data, overwrite=False, move_cursor=True, fire_event=True):
        img = file_image(data)
        if img and data.strip() == data.strip().splitlines()[0]:
            attach(img, "Photo attached. Add a line, or press enter.")
            return
        return original_insert(data, overwrite=overwrite, move_cursor=move_cursor, fire_event=fire_event)

    composer.buffer.insert_text = insert_text
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
