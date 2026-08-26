#!/usr/bin/env python
"""
Briefcase NLI ranker worker.

A resident subprocess that scores transcript sentences against stance
hypotheses with a zero-shot NLI model. It is a SUBPROCESS CONTRACT, not a
service: one model load, a JSON-lines protocol on stdin/stdout, and a clean
exit on EOF. Nothing here should grow features.

PROTOCOL (one JSON object per line, both directions)

  ready line, emitted once after the model loads:
      {"ready": true, "device": "mps", "model": "..."}

  request  (stdin):
      {"id": 1, "texts": ["...", "..."], "hypotheses": ["...", "..."]}

  response (stdout):
      {"id": 1, "scores": [[0.99, 0.02], [0.11, 0.87]]}
                 ^ one row per text, one column per hypothesis, IN THE ORDER
                   THE HYPOTHESES WERE SENT.

  failure (stdout):
      {"id": 1, "error": "..."}

  Anything the worker wants to say to a human goes to stderr, never stdout —
  stdout carries the protocol and nothing else.

MEASURED CHOICES (do not "clean these up")

  * Model MoritzLaurer/deberta-v3-base-zeroshot-v2.0 with the pipeline's
    DEFAULT hypothesis_template ("This example is {}.") and multi_label=True.
    That is the exact configuration the threshold 0.7 was calibrated against
    (proto_stage12.py); changing the template silently moves the threshold.
  * multi_label=True is required: the categories are not mutually exclusive
    and a softmax across them would make one category's score depend on the
    others present.
  * Scores are returned for EVERY hypothesis, not just the best one. The
    caller keeps all categories above threshold, which is what fixes
    mislabeled-question misses.
"""
import json
import os
import sys

MODEL = os.environ.get('BRIEFCASE_NLI_MODEL', 'MoritzLaurer/deberta-v3-base-zeroshot-v2.0')
# Batch size for one pipeline call. 64 is what the prototype measured on MPS
# (~1,900 sentences of a 60-minute video in ~40s).
BATCH = int(os.environ.get('BRIEFCASE_NLI_BATCH', '64'))
# Sentences longer than this are truncated before scoring. A transcript
# "sentence" this long is a run-on with no terminal punctuation, and the model
# window is 512 tokens regardless.
MAX_CHARS = 1200


def log(message):
    print(message, file=sys.stderr, flush=True)


def main():
    # Keep HF fully offline-friendly and quiet. The model is pre-downloaded into
    # HF_HOME next to this file by the installer; a missing model is a hard
    # failure the parent reports as "unavailable", never a silent download in
    # the middle of somebody's analysis.
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    # HF_HOME lives NEXT TO THIS FILE unless the parent set it. The model is
    # pre-downloaded there by the installer, so an analysis never waits on a
    # 400MB download and never depends on the user's global ~/.cache.
    os.environ.setdefault('HF_HOME', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hf'))

    from transformers import pipeline
    import torch

    # Accelerator by platform, in the order each platform can actually offer one.
    # macOS has no CUDA and Metal is the only accelerator there; Windows and
    # Linux have no Metal and CUDA is the only one. -1 is the CPU fallback on
    # every platform, and it is a fallback, not a failure: the pipeline is
    # correct on CPU, just slower. The value is passed to the pipeline as-is,
    # so it stays in torch's own vocabulary ('mps', 0 = cuda:0, -1 = cpu), and
    # that same value is what the ready line reports to the parent.
    if sys.platform == 'darwin':
        device = 'mps' if torch.backends.mps.is_available() else -1
    elif torch.cuda.is_available():
        device = 0
    else:
        device = -1
    clf = pipeline('zero-shot-classification', model=MODEL, device=device)

    print(json.dumps({'ready': True, 'device': str(device), 'model': MODEL}), flush=True)
    log(f'briefcase-nli: loaded {MODEL} on {device}')

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get('id')
            texts = [str(t)[:MAX_CHARS] for t in req.get('texts') or []]
            hypotheses = [str(h) for h in req.get('hypotheses') or []]
            if not texts or not hypotheses:
                print(json.dumps({'id': req_id, 'scores': []}), flush=True)
                continue

            # The pipeline keys results by label, so duplicate hypotheses would
            # collapse into one column. Score the unique set and fan back out.
            unique = list(dict.fromkeys(hypotheses))

            rows = []
            for i in range(0, len(texts), BATCH):
                chunk = texts[i:i + BATCH]
                res = clf(chunk, unique, multi_label=True, batch_size=BATCH)
                if isinstance(res, dict):
                    res = [res]
                for r in res:
                    by_label = dict(zip(r['labels'], r['scores']))
                    rows.append([float(by_label.get(h, 0.0)) for h in hypotheses])

            print(json.dumps({'id': req_id, 'scores': rows}), flush=True)
        except Exception as exc:  # noqa: BLE001 — the protocol reports, never crashes
            print(json.dumps({'id': req_id, 'error': f'{type(exc).__name__}: {exc}'}), flush=True)
            log(f'briefcase-nli: request {req_id} failed: {exc}')

    # stdin EOF: the parent is done with us.
    log('briefcase-nli: stdin closed, exiting')


if __name__ == '__main__':
    main()
