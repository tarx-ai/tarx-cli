import os, stat, subprocess, tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
tarx = root / "tarx"
home = Path(tempfile.mkdtemp(prefix="tarx-guest-"))
env = os.environ.copy()
env["HOME"] = str(home)
env.pop("TARX_CHAT_KEY", None)
env["TARX_AUTH_NO_BROWSER"] = "1"

def run(args):
    return subprocess.run([str(tarx), *args], env=env, capture_output=True, text=True)

guest = run(["chat", "hello from the guest test"])
assert guest.returncode == 3, guest.returncode
text = guest.stdout + guest.stderr
assert "not connected" in text
assert "/signin" in text
pending = home / ".tarx" / "state" / "pending-turn"
assert pending.read_text().strip() == "hello from the guest test"
assert stat.S_IMODE(pending.stat().st_mode) == 0o600

unknown = run(["not-a-command"])
assert unknown.returncode == 1
assert "Unknown command" in (unknown.stdout + unknown.stderr)
assert pending.read_text().strip() == "hello from the guest test"

print("guest-chat-ok", guest.returncode)
