import ast
from pathlib import Path

source = (Path(__file__).resolve().parents[1] / "tarx").read_text()
start = source.index("def pending_decision(")
end = source.index("\ndef ", start + 5)
namespace = {}
exec(source[start:end], namespace)
decide = namespace["pending_decision"]
held = {"text": "hello", "request_id": "req-1", "state": "held"}
unsure = {"text": "hello", "request_id": "req-1", "state": "unconfirmed"}
assert decide(held, "send") == "send"
assert decide(held, "retry") == "wait"
assert decide(held, "hello again") == "wait"
assert decide(unsure, "send") == "wait"
assert decide(unsure, "retry") == "retry"
assert decide(unsure, "drop") == "drop"
ast.parse(source[start:end])
print("pending-decision-ok")
