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
import subprocess
import time
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

# Confirmed in Phase 4: a full historical snapshot (active AND inactive
# entities, republished quarterly), NOT that quarter's new filings —
# capital "Cor" (unlike the daily COR_DIR above), ~1.67 GiB zipped.
QUARTERLY_DIR = "doc/quarterly/Cor"
QUARTERLY_FILENAME = "cordata.zip"
QUARTERLY_MAX_RESUME_ATTEMPTS = 30


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


def download_quarterly_file(dest_path: str, resume: bool = True, on_progress=None) -> int:
    """Resumable download of the quarterly full-snapshot zip to dest_path.
    Returns the final size in bytes.

    A single sftp.get() can fail partway through this specific file —
    observed live in Phase 4: a fresh connection dropped with "insufficient
    resources" after ~35MB. This reconnects and resumes from the last
    confirmed byte rather than restarting a multi-gigabyte transfer from
    zero, and gives up loudly (raises) rather than looping forever if the
    server keeps dropping the connection at the same offset.

    on_progress(got, total_size), if given, is called roughly once a
    minute during the transfer — the download alone can take ~49 minutes
    (confirmed live), which on its own exceeds job_queue's default
    30-minute stale-job threshold; the caller uses this to keep the job's
    heartbeat fresh so no worker's reaper reclaims a transfer that's
    still genuinely in progress (see db.touch_heartbeat's own header)."""
    path = f"{QUARTERLY_DIR}/{QUARTERLY_FILENAME}"
    sftp, client = _connect()
    try:
        total_size = sftp.stat(path).st_size
    finally:
        sftp.close()
        client.close()

    got = os.path.getsize(dest_path) if (resume and os.path.exists(dest_path)) else 0
    mode = "r+b" if got else "wb"
    attempts = 0
    last_progress_call = time.time()
    with open(dest_path, mode) as f:
        f.seek(got)
        while got < total_size:
            attempts += 1
            if attempts > QUARTERLY_MAX_RESUME_ATTEMPTS:
                raise RuntimeError(f"quarterly download stalled at {got}/{total_size} bytes after {attempts} attempts")
            sftp, client = _connect()
            try:
                remote = sftp.open(path, "rb")
                try:
                    remote.seek(got)
                    while got < total_size:
                        data = remote.read(1024 * 1024)
                        if not data:
                            break
                        f.write(data)
                        got += len(data)
                        if on_progress and time.time() - last_progress_call > 60:
                            on_progress(got, total_size)
                            last_progress_call = time.time()
                finally:
                    remote.close()
            except Exception as e:
                log.warning("quarterly download dropped at %d/%d bytes (attempt %d): %s", got, total_size, attempts, e)
                time.sleep(2)
            finally:
                sftp.close()
                client.close()
    log.info("quarterly file downloaded: %d bytes, %d connection attempt(s)", got, attempts)
    return got


def list_quarterly_members(zip_path: str) -> list[str]:
    """cordata0.txt, cordata1.txt, ... — not hardcoded to 10, since a
    future quarter could ship a different split. Uses the system `unzip`
    binary (see Dockerfile): the archive is Deflate64-compressed, which
    Python's stdlib zipfile does not support (confirmed in Phase 4 via a
    direct NotImplementedError)."""
    result = subprocess.run(["unzip", "-l", zip_path], capture_output=True, text=True, check=True)
    members = []
    for line in result.stdout.splitlines():
        parts = line.split()
        if parts and parts[-1].startswith("cordata") and parts[-1].endswith(".txt"):
            members.append(parts[-1])
    return members


def extract_quarterly_member(zip_path: str, member: str, dest_dir: str) -> str:
    """Extracts one ~1.87GB member to dest_dir — one at a time by design
    (quarterly.py deletes each extracted file right after parsing it), so
    at most one member's worth of disk is used regardless of how many the
    archive contains."""
    subprocess.run(["unzip", "-o", zip_path, member, "-d", dest_dir], check=True, capture_output=True)
    return os.path.join(dest_dir, member)
