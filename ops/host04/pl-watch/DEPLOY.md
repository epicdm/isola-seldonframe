# pl-watch (host04) - deploy recipe

`pl-watch.py` is the root-owned monitor run by the systemd `pl-watch.timer` on host04 (every 2 minutes), installed at
`/usr/local/lib/pl-watch/pl-watch.py`. This directory is the committed source of what runs there.

- v3.5 (sha256 prefix `97d4d1ca9c5f77b9`) is the live file copied verbatim on 2026-10-19, committed so the change below has a base.
- v3.6 (sha256 prefix `4d2359ef96edb205`) replaces check 6 (the $10 / 14-day spend stop the owner removed on 2026-10-14) with:
  - the kill switch (`public_turn_spend_gates.enabled`) readable and ON;
  - a WARNING when settled model spend over the rolling last 24 h reaches `PLW_SPEND_WARN_USD` (default 5). It is alert-only: the script never stops or changes service;
  - a separate MONITORING FAILURE class (no DB container, query error, not exactly one gate row, reservations unsettled for more than 15 min). A failed read is never "spend OK".
- Controls (use with `--dry-run`, which sends nothing):
  - `PLW_CTRL=spend` forces the threshold to 0, so the warning fires;
  - `PLW_CTRL=kill,stale` forces the kill-switch and ledger-not-current results;
  - `PLW_SPEND_DB=no_such_db` must give MONITORING FAILURE.

## Apply (owner go required)
Run on host04. Copy the file in, check it, keep a backup, and change nothing else. The timer picks the new file up on its next 2-minute run.

    sudo install -m 750 -o root -g root pl-watch.py /usr/local/lib/pl-watch/pl-watch.py.v3.6
    sha256sum /usr/local/lib/pl-watch/pl-watch.py.v3.6 | cut -c1-16      # expect 4d2359ef96edb205
    sudo cp -p /usr/local/lib/pl-watch/pl-watch.py /usr/local/lib/pl-watch/pl-watch.py.v3.5-before-spend-warning-20261019
    sudo python3 /usr/local/lib/pl-watch/pl-watch.py.v3.6 --dry-run | grep -iE 'spend|kill switch|MONITORING|dry-run:'
    sudo mv /usr/local/lib/pl-watch/pl-watch.py.v3.6 /usr/local/lib/pl-watch/pl-watch.py
    # verify after the next timer run:
    sudo tail -n 60 /var/log/pl-watch.log | grep -iE 'spend|kill switch|MONITORING'

## Rollback

    sudo cp -p /usr/local/lib/pl-watch/pl-watch.py.v3.5-before-spend-warning-20261019 /usr/local/lib/pl-watch/pl-watch.py
    sudo sha256sum /usr/local/lib/pl-watch/pl-watch.py | cut -c1-16     # expect 97d4d1ca9c5f77b9
