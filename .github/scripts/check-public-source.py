"""Reject private project paths in public files or reachable Git history."""
import subprocess

private_roots = (".context", "marketing", "supabase/migrations")
tracked = subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
history = subprocess.check_output([
    "git", "log", "--all", "--format=", "--name-only", "--", *private_roots,
]).decode().splitlines()
blocked = sorted({
    path for path in tracked + history
    if any(path == root or path.startswith(root + "/") for root in private_roots)
})
if blocked:
    print("Private project paths must not appear in the public repository or its history:")
    for path in blocked[:20]:
        print(f"  {path}")
    print(f"Found {len(blocked)} private paths. Keep this material in Audora-private.")
    raise SystemExit(1)
print("Public source privacy check passed for tracked files and reachable history.")
