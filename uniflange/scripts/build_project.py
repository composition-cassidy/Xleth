"""
Build a UniFlange-round-3 render project by splicing two Image-Line factory
"Render tests" templates at the raw-event level:

  - Fruity Flangus.flp (v11.1.1, legacy no-slot-index mixer format) supplies
    the mixer: Insert(iid=0) already has Fruity Flangus loaded, Channel
    routed to it (RoutedTo=1), Master otherwise clean. We keep this whole
    region byte-for-byte untouched except the plugin's own 32-byte param
    blob (PluginID.Data).
  - Sampler.flp (v20.0.3) supplies a real, FL-authored Sampler channel
    (ChannelID.Type=0 + ChannelID.SamplePath + all the companion ChannelID.*
    properties a sampler channel needs). We splice this whole channel
    region in, replacing Fruity Flangus.flp's "3x Osc" instrument channel,
    then repoint ChannelID.SamplePath at our own probe wav.

pyflp has no model for Fruity Flangus specifically (falls back to raw
UnknownDataEvent bytes) and its property API can't insert brand-new events
into a model that doesn't already have them, so this operates directly on
the flat, file-ordered event list (bypassing pyflp's higher-level
Insert/Channel model wrappers, using them only for read-side inspection).
"""
from __future__ import annotations

import copy
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import pyflp_py314_patch  # noqa: F401,E402

import pyflp  # noqa: E402
from pyflp._events import EventTree, IndexedEvent  # noqa: E402
from pyflp.channel import ChannelID  # noqa: E402
from pyflp.pattern import PatternID  # noqa: E402
from pyflp.plugin import PluginID  # noqa: E402
from pyflp.project import Project  # noqa: E402

RENDER_TESTS = pathlib.Path(
    r"C:\Program Files\Image-Line\FL Studio 2026\Data\System\Render tests"
)
FLANGUS_TEMPLATE = RENDER_TESTS / "Fruity Flangus.flp"
SAMPLER_TEMPLATE = RENDER_TESTS / "Sampler.flp"

GAP_THRESHOLD = 20  # r-value jump that marks "end of this model's first cluster"


def _first_cluster_rset(events_lst) -> set[int]:
    """The contiguous-ish leading run of r-values in a model's event subtree.

    pyflp's Project.channels selector matches *any* PluginID.* event
    anywhere in the file (mixer slots included), so a channel's own
    subtree is a dirty superset. The channel's real data is the first
    tight cluster; anything after a big r-value jump belongs elsewhere
    (e.g. a mixer insert's plugin, or the trailing RackID.WindowHeight
    outlier) and must NOT be touched.
    """
    rs = sorted(ie.r for ie in events_lst)
    if not rs:
        return set()
    cluster = [rs[0]]
    for prev, cur in zip(rs, rs[1:]):
        if cur - prev > GAP_THRESHOLD:
            break
        cluster.append(cur)
    return set(cluster)


def _load(path):
    return pyflp.parse(str(path))


def build(
    output_flp: str,
    sample_wav_path: str,
    param_bytes: bytes,
    note_length_ticks: int = 768,
    note_key: int = 60,
) -> None:
    base = _load(FLANGUS_TEMPLATE)
    donor = _load(SAMPLER_TEMPLATE)

    assert len(param_bytes) == 32, f"expected 32-byte param blob, got {len(param_bytes)}"

    base_channel_rset = _first_cluster_rset(base.channels.events.lst)
    donor_channel_rset = _first_cluster_rset(donor.channels.events.lst)

    base_events = list(base.events)  # flat, file order; list index == original .r
    donor_events = list(donor.events)

    donor_channel_events = [copy.deepcopy(donor_events[r]) for r in sorted(donor_channel_rset)]

    sample_path_set = False
    for ev in donor_channel_events:
        if ev.id == ChannelID.SamplePath:
            ev.value = sample_wav_path
            sample_path_set = True
    assert sample_path_set, "donor channel had no ChannelID.SamplePath event to repoint"

    last_channel_r = max(base_channel_rset)
    new_events = []
    for i, ev in enumerate(base_events):
        if i in base_channel_rset:
            if i == last_channel_r:
                new_events.extend(donor_channel_events)
            continue
        new_events.append(ev)

    # --- pattern: extend the single note's length so playback covers the
    # whole probe file regardless of the project's tempo/ppq.
    note_event = None
    data_event = None
    for ev in new_events:
        if ev.id == PatternID.Notes:
            note_event = ev
        elif ev.id == PluginID.Data:
            data_event = ev
    assert note_event is not None, "no PatternID.Notes event found"
    assert len(note_event.value) == 1, f"expected exactly 1 note, found {len(note_event.value)}"
    note_event.value[0]["length"] = note_length_ticks
    note_event.value[0]["key"] = note_key
    note_event.value[0]["position"] = 0

    # --- Flangus's own param blob (the only PluginID.Data event left, once
    # the 3xOsc channel's own Data event was dropped above).
    assert data_event is not None, "no PluginID.Data event left (Flangus slot)"
    data_event.value = bytearray(param_bytes)

    new_tree = EventTree(init=(IndexedEvent(r, e) for r, e in enumerate(new_events)))
    new_project = Project(
        new_tree,
        channel_count=1,
        format=base.format,
        ppq=base.ppq,
    )
    pyflp.save(new_project, output_flp)


if __name__ == "__main__":
    import struct

    out = sys.argv[1]
    wav = sys.argv[2]
    order, depth, speed, delay, spread, cross, dry, wet = (int(x) for x in sys.argv[3:11])
    blob = struct.pack("<8i", order, depth, speed, delay, spread, cross, dry, wet)
    build(out, wav, blob)
    print("wrote", out)
