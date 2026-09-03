"""The packaged-smoke backend port override must not change the normal port."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from runtime_platform import get_backend_port  # noqa: E402


def test_backend_port_defaults_to_the_existing_port():
    assert get_backend_port({}) == 8000


def test_backend_port_accepts_the_smoke_test_override():
    assert get_backend_port({"AUDORA_BACKEND_PORT": "37123"}) == 37123
