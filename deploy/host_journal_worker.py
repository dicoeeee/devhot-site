"""Internal systemd-cat target: descriptor validation is mandatory before any mutation."""

import sys

from host import main
from host_journal import JOURNAL_IO_ERROR, accept_worker

if __name__ == "__main__":
    try:
        admitted = accept_worker(int(sys.argv[1]))
    except (IndexError, ValueError):
        admitted = False
    sys.exit(main(sys.argv[2:], require_journal=True) if admitted else JOURNAL_IO_ERROR)
