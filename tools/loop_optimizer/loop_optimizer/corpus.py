"""``dataset.json`` reading and writing.

Schema, as produced by ``ui/electron-main/loopLabExport.js``::

    { sample_id, file, class, instrument_name, behavior_family, source,
      root_note, sample_rate, channels, num_samples,
      gold_loop: { start, end, xfade },      # FILE-domain samples
      measured_features }

``gold_loop`` is in the FILE sample domain. The engine holds loop points in the
48 kHz engine domain; ``convertGold`` in loopLabExport.js multiplies by
``fileRate / engineRate`` on export. Anything that indexes the ingested buffer
must convert back first — :class:`GoldLoop.to_engine` is the only sanctioned
way to do it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DATASET_FILENAME = "dataset.json"


@dataclass(frozen=True)
class GoldLoop:
    """A human-authored loop, in FILE-domain samples."""

    start: int
    end: int
    xfade: int

    def to_engine(self, file_rate: float, engine_rate: float) -> "GoldLoop":
        """Convert to engine-domain samples — the inverse of ``convertGold``.

        Rounds, matching the export path's ``Math.round``, so a round trip is
        stable to within the rounding the export already imposed.
        """
        r = engine_rate / float(file_rate)
        return GoldLoop(
            start=int(round(self.start * r)),
            end=int(round(self.end * r)),
            xfade=int(round(self.xfade * r)),
        )


@dataclass
class CorpusEntry:
    """One dataset row plus the resolved path to its audio."""

    sample_id: str
    path: Path
    sample_class: str
    behavior_family: str
    root_note: int | None
    declared_sample_rate: int
    declared_channels: int
    declared_num_samples: int
    gold: GoldLoop | None
    raw: dict[str, Any]


def load_dataset(corpus_dir: str | Path) -> tuple[list[CorpusEntry], list[dict[str, Any]], Path]:
    """Load ``dataset.json``. Returns (entries, raw rows, dataset path).

    ``corpus_dir`` may be the directory holding ``dataset.json`` or the file
    itself. Audio paths in the dataset are relative to the dataset's directory.
    """
    root = Path(corpus_dir)
    dataset_path = root if root.is_file() else root / DATASET_FILENAME
    if not dataset_path.exists():
        raise FileNotFoundError(f"no {DATASET_FILENAME} at {dataset_path}")
    base = dataset_path.parent

    rows = json.loads(dataset_path.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise ValueError(f"{dataset_path} should hold a list of samples")

    entries: list[CorpusEntry] = []
    for row in rows:
        gold_raw = row.get("gold_loop") or None
        gold = (
            GoldLoop(
                start=int(gold_raw.get("start", 0)),
                end=int(gold_raw.get("end", 0)),
                xfade=int(gold_raw.get("xfade", 0)),
            )
            if gold_raw
            else None
        )
        entries.append(
            CorpusEntry(
                sample_id=str(row.get("sample_id", "")),
                path=(base / str(row.get("file", ""))).resolve(),
                sample_class=str(row.get("class", "")),
                behavior_family=str(row.get("behavior_family", "")),
                root_note=row.get("root_note"),
                declared_sample_rate=int(row.get("sample_rate", 0) or 0),
                declared_channels=int(row.get("channels", 0) or 0),
                declared_num_samples=int(row.get("num_samples", 0) or 0),
                gold=gold,
                raw=row,
            )
        )
    return entries, rows, dataset_path


def write_dataset_with_features(
    rows: list[dict[str, Any]],
    features_by_id: dict[str, dict],
    out_path: str | Path,
) -> Path:
    """Write a COPY of the dataset with ``measured_features`` filled in.

    A copy, never in place: the corpus is hand-labelled ground truth and this
    tool has no business editing it. The caller chooses the destination.
    """
    out = Path(out_path)
    updated = []
    for row in rows:
        new_row = dict(row)
        sid = str(row.get("sample_id", ""))
        if sid in features_by_id:
            new_row["measured_features"] = features_by_id[sid]
        updated.append(new_row)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(updated, indent=2) + "\n", encoding="utf-8")
    return out
