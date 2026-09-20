"""Tiny coroutine runner plugin: any ``test_*`` that returns a coroutine runs.

``pytest-asyncio`` is not installed in the verification environment, so async
tests are executed here with ``asyncio.run`` instead.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    func = pyfuncitem.obj
    if inspect.iscoroutinefunction(func):
        kwargs = {name: pyfuncitem.funcargs[name] for name in pyfuncitem._fixtureinfo.argnames}
        asyncio.run(func(**kwargs))
        return True
    return None
