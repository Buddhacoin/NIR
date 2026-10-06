"""Hand a real listening OS socket to the Node readiness integration test.

This fixture intentionally uses only documented Python descriptor inheritance.
It does not construct NIR inputs or handle any secret material.
"""

import os
import socket
import subprocess
import sys


def main():
    node, test_file = sys.argv[1:]
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    descriptor = listener.fileno()
    environment = dict(os.environ)
    # Node marks test subprocesses; a fresh OS supervisor must not inherit that marker.
    environment.pop("NODE_TEST_CONTEXT", None)
    environment["NIR_TEST_INHERITED_FD"] = str(descriptor)
    environment["NIR_TEST_INHERITED_PORT"] = str(listener.getsockname()[1])
    child = subprocess.Popen(
        [node, "--test-name-pattern=OS-inherited listener activates", test_file],
        env=environment,
        pass_fds=(descriptor,),
    )
    listener.close()
    try:
        return child.wait(timeout=35)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        return 124


if __name__ == "__main__":
    raise SystemExit(main())
