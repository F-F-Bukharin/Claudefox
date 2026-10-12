#!/usr/bin/env python3
"""Fixed settings for the vendored watch engine. This copy reads no file, no variables and no keys."""
from __future__ import annotations

DEFAULT_DETAIL = 'efficient'
DETAILS = {'transcript', 'efficient', 'balanced', 'token-burner'}


class ConfigError(ValueError):
    """A safe diagnostic that never includes a configuration value."""


def get_config() -> dict:
    return {'detail': DEFAULT_DETAIL, 'sub_lang': 'auto'}


def frame_cap(detail: str) -> int | None:
    return {'efficient': 50, 'balanced': 100, 'token-burner': None, 'transcript': None}.get(detail, 100)
