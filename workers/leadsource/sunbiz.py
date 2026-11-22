"""
Venturelyx :: Florida Sunbiz SFTP access.

One connection per ingest run, one file per source — "no crawling," per
the Phase 1 brief. Host key is NOT auto-accepted here (no AutoAddPolicy);
it's pinned once (see scripts/leadsource_due.py's deploy note) and this
module refuses to connect if the server presents something different,
the same trust-on-first-use-then-verify discipline the host's own
~/.ssh/known_hosts already uses for this exact host.
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

import paramiko

log = logging.getLogger("vx.leadsource.sunbiz")

HOST = os.environ["SUNBIZ_SFTP_HOST"]
USER = os.environ["SUNBIZ_SFTP_USER"]
PASSWORD = os.environ["SUNBIZ_SFTP_PASS"]
KNOWN_HOSTS_PATH = os.environ.get("SUNBIZ_KNOWN_HOSTS", "/app/known_hosts")


# No "Public/" prefix — paramiko's SFTP session starts already inside the
# Public account's home directory (confirmed live: listdir('.') shows
# doc/ and WELCOME.TXT directly). curl's sftp:// URL in Phase 1 showed
# "Public/" as a subdirectory because curl's root ('/') maps to the
# server's filesystem root, not this session's home — a different
# reference point for the same files, not a different layout.
COR_DIR = "doc/cor"
FIC_DIR = "doc/fic"


def _connect() -> paramiko.SFTPClient:
    client = paramiko.SSHClient()
    client.load_host_keys(KNOWN_HOSTS_PATH)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(HOST, port=22, username=USER, password=PASSWORD, timeout=20, banner_timeout=20)
    return client.open_sftp(), client


def most_recent_workday(today: date) -> date:
    """Daily files post for weekdays only — Fri's file is 'most recent'
    on a Sat/Sun/Mon morning check, same as what Phase 1 found by hand."""
    d = today - timedelta(days=1)
    while d.weekday() >= 5:  # 5=Sat, 6=Sun
        d -= timedelta(days=1)
    return d


def download_daily_file(directory: str, suffix: str, on_date: date) -> bytes | None:
    """suffix: 'c' for corporate, 'f' for fictitious name. Returns None if
    that date's file doesn't exist yet (e.g. checked before it posted)."""
    filename = f"{on_date.strftime('%Y%m%d')}{suffix}.txt"
    sftp, client = _connect()
    try:
        path = f"{directory}/{filename}"
        try:
            with sftp.open(path, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            log.info("no file at %s yet", path)
            return None
        log.info("downloaded %s (%d bytes)", path, len(data))
        return data
    finally:
        sftp.close()
        client.close()
