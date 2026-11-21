# Local changes to the vendored FST files

`LICENSE`, `README.md`, `fst/aeffect.h` and `fst/aeffectx.h` are exactly as in FST v0.115.0.
`fst/fst.h` has ONE kind of local change (GPL-3.0-or-later allows modification; it is recorded here): each of
its four `#warning` directives (original lines 242, 330, 474, 558: "document origin of eff*SetProgram",
"origin of kSpeakerM", "document origin samplesToNextClock", "document origin of CCONST") is wrapped so MSVC does
not see it:

```diff
+#if !defined(_MSC_VER) /* XLETH local patch (PATCHES.md) */
 #warning <text unchanged>
+#endif
```

Reason: `#warning` is not a valid MSVC directive (error C1021), and XLETH builds with MSVC. The warnings are
FST developer notes ("document origin of ..."). No constant, struct or opcode was added or changed.

SHA-256 of `fst/fst.h` as downloaded: `3ef8e9f4207b4f867cfd186b22fd1c18151c2d6ef5b00b1afb39ebe318e25ca4`.

Not a local change but worth knowing: FST 0.115.0 defines `FST_DEPRECATE_UNKNOWN(x)` only for GCC/clang, so the
MSVC build needs `FST_DONT_DEPRECATE_UNKNOWN` (FST's own switch). It is defined in the compat shim
`third_party/fst-compat/pluginterfaces/vst2.x/aeffect{,x}.h`, not in FST.
