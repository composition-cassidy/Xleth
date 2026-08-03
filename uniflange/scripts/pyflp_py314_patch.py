"""
Compatibility shim: pyflp 2.2.1's EventEnum base class has zero direct
members (only its subclasses -- ProjectID, PluginID, etc. -- have members).
Python <=3.13's enum.EnumMeta.__call__ fell through to cls.__new__() /
_missing_() for such a class. Python 3.14 tightened this: EnumMeta.__call__
now raises TypeError("... has no members; specify names=() ...") whenever
cls._member_map_ is empty, treating the call as an attempt at the functional
API instead of a value lookup.

pyflp's own parser calls the bare `EventEnum(value)` (see pyflp/__init__.py),
relying on the old behaviour to reach EventEnum._missing_, which is how it
discovers IDs belonging to subclasses / synthesizes pseudo-members. That
call now hard-fails on Python 3.14.

Import this module before `import pyflp` to restore the old lookup
behaviour for empty-member EventEnum (sub)classes, without touching pyflp
itself.
"""

import enum

import pyflp._events as _events

_EventEnumMeta = _events._EventEnumMeta
_orig_call = enum.EnumMeta.__call__


def _patched_call(cls, value, names=enum._not_given, *values, **kwargs):
    if not cls._member_map_ and names is enum._not_given and not values and not kwargs:
        # Python 3.14's Enum.__new__ raises before even trying _missing_ when
        # cls has no members of its own (see enum.py ~line 1169). pyflp's
        # EventEnum._missing_ is exactly the mechanism meant to handle this
        # case (delegating to subclasses / synthesizing pseudo-members), so
        # call it directly instead of going through Enum.__new__.
        result = cls._missing_(value)
        if result is not None:
            return result
        raise ValueError(f"{value!r} is not a valid {cls.__qualname__}")
    return _orig_call(cls, value, names, *values, **kwargs)


_EventEnumMeta.__call__ = _patched_call
