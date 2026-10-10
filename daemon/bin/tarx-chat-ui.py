#!/usr/bin/env python3
"""TARX chat. Transcript above, composer pinned to the bottom. A pasted photo attaches."""

import json
import os
import shutil
import subprocess
import sys
import termios
import tty
import urllib.request

URL = os.environ.get("TARX_CHAT_URL", "http://127.0.0.1:11450")
KEY = os.environ.get("TARX_CHAT_KEY", "")
PROMPT = os.environ.get("TARX_CHAT_PROMPT", "")
HIST = os.environ.get("TARX_CHAT_HIST", "")
BLUE = "\033[38;5;75m"
DIM = "\033[2m"
BOLD = "\033[1m"
RST = "\033[0m"
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff"}


def cols_rows():
    s = shutil.get_terminal_size((80, 24))
    return s.columns, s.lines


def clip(s, n):
    s = s.replace("\t", " ")
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)] + "…"


def wrap(text, width):
    width = max(8, width)
    out = []
    for para in (text or "").split("\n"):
        if para == "":
            out.append("")
            continue
        while len(para) > width:
            cut = para.rfind(" ", 0, width)
            if cut < 8:
                cut = width
            out.append(para[:cut])
            para = para[cut:].lstrip()
        out.append(para)
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
    if not path or not os.path.isfile(path):
        return None
    if os.path.splitext(path)[1].lower() not in IMG_EXT:
        return None
    dest = f"/tmp/tarx-clip-{os.getpid()}-{len(path)}.png"
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
    parts = []
    if text.strip():
        parts.append({"type": "text", "text": text})
    else:
        parts.append({"type": "text", "text": "Look at the attached photo."})
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
            d = json.loads(p)
            delta = d.get("choices", [{}])[0].get("delta", {}).get("content") or ""
        except Exception:
            continue
        if delta:
            full.append(delta)
            on_delta("".join(full))
    return "".join(full), ""


class UI:
    def __init__(self):
        self.turns = []  # (who, text)
        self.buf = ""
        self.cur = 0
        self.images = []
        self.status = ""
        self.fd = sys.stdin.fileno()
        self.old = None

    def enter(self):
        self.old = termios.tcgetattr(self.fd)
        tty.setraw(self.fd)
        sys.stdout.write("\033[?1049h\033[?2004h\033[?25l")
        sys.stdout.flush()

    def leave(self):
        sys.stdout.write("\033[?2004l\033[?25h\033[?1049l")
        sys.stdout.flush()
        if self.old:
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)

    def draw(self):
        w, h = cols_rows()
        composer_h = 4 if self.images else 3
        top = max(1, h - composer_h)
        lines = []
        for who, text in self.turns:
            mark = "you" if who == "you" else "tarx"
            color = "" if who == "you" else BLUE
            for i, row in enumerate(wrap(text, w - 4)):
                prefix = mark if i == 0 else " " * len(mark)
                lines.append(f"{color}{prefix}{RST}  {row}" if who == "tarx" else f"{DIM}{prefix}{RST}  {row}")
        view = lines[-(top - 2):] if top > 2 else lines
        out = ["\033[H"]
        title = clip(" TARX", 20)
        hint = clip("Supercomputer", max(0, w - 24))
        out.append(f"\033[K{BOLD}{title}{RST}  {DIM}{hint}{RST}\n")
        body_rows = top - 1
        pad = body_rows - len(view)
        for row in view:
            out.append("\033[K" + clip(row, w) + "\n")
        for _ in range(max(0, pad)):
            out.append("\033[K\n")
        # composer, pinned
        out.append(f"\033[K{BLUE}{'─' * max(1, w)}{RST}\n")
        if self.images:
            chip = "  ".join("▣ photo" for _ in self.images[:4])
            out.append(f"\033[K{BLUE}│{RST} {chip}\n")
        shown = self.buf
        caret = self.cur
        # show tail if the line is wider than the screen
        room = max(4, w - 4)
        start = 0
        if caret >= room:
            start = caret - room + 1
        vis = shown[start:start + room]
        gap = room - len(vis)
        out.append(f"\033[K{BLUE}│{RST} {vis}{' ' * gap}\n")
        foot = self.status or "paste a photo · ctrl-v attaches the clipboard · enter sends · exit leaves"
        out.append(f"\033[K{DIM}{clip('  ' + foot, w)}{RST}")
        sys.stdout.write("".join(out))
        # place cursor in the composer
        cy = h - (2 if self.images else 1)
        cx = 3 + (caret - start)
        sys.stdout.write(f"\033[{cy};{cx}H\033[?25h")
        sys.stdout.flush()

    def attach(self, path):
        if not path:
            self.status = "No photo on the clipboard."
            return
        if len(self.images) >= 4:
            self.status = "Four photos is the limit for one turn."
            return
        self.images.append(path)
        self.status = "Photo attached. Add a line, or press enter."

    def read_byte(self):
        return sys.stdin.buffer.read(1)

    def read_paste(self):
        data = bytearray()
        # bracketed paste ends with ESC [ 201 ~
        end = b"\033[201~"
        while True:
            b = self.read_byte()
            if not b:
                break
            data += b
            if data.endswith(end):
                data = data[:-len(end)]
                break
            if len(data) > 200_000:
                break
        return data.decode("utf-8", "replace")

    def handle_paste(self, text):
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        stripped = text.strip()
        img = file_image(stripped) if "\n" not in stripped else None
        if img:
            self.attach(img)
            return
        if not stripped:
            self.attach(clipboard_image())
            return
        self.buf = self.buf[:self.cur] + text + self.buf[self.cur:]
        self.cur += len(text)
        self.status = ""

    def submit(self, messages):
        text = self.buf
        images = list(self.images)
        if not text.strip() and not images:
            return
        label = text.strip()
        if images:
            label = (label + "\n" if label else "") + f"▣ {len(images)} photo" + ("s" if len(images) != 1 else "")
        self.turns.append(("you", label or "▣ photo"))
        content = user_content(text, images)
        messages.append({"role": "user", "content": content})
        self.buf = ""
        self.cur = 0
        self.images = []
        self.status = "thinking"
        self.turns.append(("tarx", ""))
        self.draw()

        def on_delta(so_far):
            self.turns[-1] = ("tarx", so_far)
            self.status = ""
            self.draw()

        ans, err = stream_reply(messages, on_delta)
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                messages[i] = {"role": "user", "content": label or "[photo]"}
                break
        if err and not ans:
            self.turns[-1] = ("tarx", "The door did not take that turn. " + err)
        elif not ans:
            self.turns[-1] = ("tarx", "No response. The door may be cold. Try again.")
        else:
            messages.append({"role": "assistant", "content": ans})
        self.status = ""
        save_history(messages)
        self.draw()

    def loop(self):
        messages = load_history()
        prior = [m for m in messages if m.get("role") in ("user", "assistant")]
        for m in prior[-8:]:
            who = "you" if m["role"] == "user" else "tarx"
            c = m.get("content")
            if not isinstance(c, str):
                c = "[photo]"
            self.turns.append((who, c))
        self.draw()
        while True:
            b = self.read_byte()
            if not b:
                break
            if b == b"\x03":
                break
            if b == b"\x16":  # ctrl-v
                img = clipboard_image()
                if img:
                    self.attach(img)
                else:
                    try:
                        t = subprocess.check_output(["pbpaste"], timeout=2).decode()
                    except Exception:
                        t = ""
                    if t:
                        self.handle_paste(t)
                    else:
                        self.status = "Clipboard has no photo."
                self.draw()
                continue
            if b == b"\x7f" or b == b"\x08":
                if self.cur > 0:
                    self.buf = self.buf[:self.cur - 1] + self.buf[self.cur:]
                    self.cur -= 1
                elif self.images:
                    self.images.pop()
                self.draw()
                continue
            if b in (b"\r", b"\n"):
                if self.buf.strip() in ("exit", "quit", ":q") and not self.images:
                    break
                self.submit(messages)
                continue
            if b == b"\x1b":
                nxt = self.read_byte()
                if nxt == b"[":
                    seq = bytearray()
                    while True:
                        c = self.read_byte()
                        seq += c
                        if c and (0x40 <= c[0] <= 0x7e):
                            break
                        if len(seq) > 8:
                            break
                    s = seq.decode("ascii", "replace")
                    if s.startswith("200~"):
                        self.handle_paste(self.read_paste())
                    elif s.startswith("D") and self.cur > 0:
                        self.cur -= 1
                    elif s.startswith("C") and self.cur < len(self.buf):
                        self.cur += 1
                    elif s.startswith("H"):
                        self.cur = 0
                    elif s.startswith("F"):
                        self.cur = len(self.buf)
                    elif s.startswith("3~") and self.cur < len(self.buf):
                        self.buf = self.buf[:self.cur] + self.buf[self.cur + 1:]
                self.draw()
                continue
            if b[0] < 32:
                continue
            # utf-8
            need = 1
            if b[0] & 0xE0 == 0xC0:
                need = 2
            elif b[0] & 0xF0 == 0xE0:
                need = 3
            elif b[0] & 0xF8 == 0xF0:
                need = 4
            raw = b + sys.stdin.buffer.read(need - 1)
            ch = raw.decode("utf-8", "replace")
            self.buf = self.buf[:self.cur] + ch + self.buf[self.cur:]
            self.cur += len(ch)
            self.status = ""
            self.draw()


def main():
    if not KEY:
        sys.stderr.write("Supercomputer door needs its key.\n")
        return 1
    ui = UI()
    try:
        ui.enter()
        ui.loop()
    finally:
        ui.leave()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
