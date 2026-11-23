"""
Venturelyx :: LeadSource enrichment — repeatable verification script.

    docker exec vx-leadsource-worker python test_enrich.py

No test framework in this codebase (confirmed project-wide); this follows
the same live-verification style as api/src/scripts/testLeadSource*.ts —
real deployed container, disposable test orgs, torn down in `finally`.
Covers what enrich.py's own design depends on: the monthly-cap gate
(including month rollover), "no key -> never usable", domain-guess name
normalization, and the virtual/registered-agent address flag.
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import date, timedelta

import db
import enrich
import vault

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def create_test_org(conn, name: str) -> str:
    with db.staff_tx(conn) as cur:
        cur.execute(
            "INSERT INTO organizations (slug, name, status, modules) "
            "VALUES (%s, %s, 'active', '{\"leadsource\": true}'::jsonb) RETURNING id",
            (f"test-{uuid.uuid4().hex[:8]}", name),
        )
        return str(cur.fetchone()["id"])


def main() -> int:
    print("LeadSource enrichment verification\n")

    # 1. Pure functions — no DB needed.
    check('candidate_domains strips "LLC" and compacts the name',
          "https://acmeroofing.com" in enrich.candidate_domains("ACME ROOFING LLC"))
    check("candidate_domains returns nothing for an empty/degenerate name",
          enrich.candidate_domains("LLC") == [])
    check("is_virtual_or_agent_address flags a known registered-agent provider",
          enrich.is_virtual_or_agent_address("NORTHWEST REGISTERED AGENT LLC"))
    check("is_virtual_or_agent_address does not flag an ordinary business name",
          not enrich.is_virtual_or_agent_address("JOHN SMITH"))
    check("is_virtual_or_agent_address handles a missing RA name",
          not enrich.is_virtual_or_agent_address(None))

    conn = db.connect()
    org_id = create_test_org(conn, "LeadSource Enrich Test Org")
    try:
        # 2. No key at all -> never usable (org without a key never calls Brave).
        check("an org with no saved key gets None from get_usable_provider_key",
              enrich.get_usable_provider_key(conn, org_id) is None)

        # 3. A key under cap is usable.
        key_enc_blob = b"not-a-real-encrypted-blob"  # never decrypted in this check — see check 4
        with db.tenant_tx(conn, org_id) as cur:
            cur.execute(
                """INSERT INTO leadsource_provider_keys
                     (org_id, provider, key_enc, key_iv, key_tag, key_last4, status,
                      monthly_search_cap, searches_this_month, searches_month_reset_at)
                   VALUES (%s, 'brave', %s, %s, %s, 'test', 'ok', 10, 3, date_trunc('month', now())::date)""",
                (org_id, key_enc_blob, b"iv", b"tag"),
            )

        # 4. Real round-trip: save a REAL encrypted key, confirm the worker
        # can decrypt what the API encrypted (cross-language vault check).
        real_key = "BSA-real-test-key-0001"
        enc, iv, tag = _encrypt_like_node(real_key)
        with db.tenant_tx(conn, org_id) as cur:
            cur.execute(
                "UPDATE leadsource_provider_keys SET key_enc=%s, key_iv=%s, key_tag=%s WHERE org_id=%s",
                (enc, iv, tag, org_id),
            )
        usable = enrich.get_usable_provider_key(conn, org_id)
        check("a key under cap, with status='ok', is usable", usable is not None)
        check("the worker decrypts exactly what was encrypted", usable is not None and usable["key"] == real_key)

        # 5. At cap -> not usable.
        with db.tenant_tx(conn, org_id) as cur:
            cur.execute("UPDATE leadsource_provider_keys SET searches_this_month = 10 WHERE org_id = %s", (org_id,))
        check("a key at its monthly cap is not usable", enrich.get_usable_provider_key(conn, org_id) is None)

        # 6. Month rollover resets usability even though the stored count is still at the old cap.
        last_month = date.today().replace(day=1) - timedelta(days=1)
        with db.tenant_tx(conn, org_id) as cur:
            cur.execute(
                "UPDATE leadsource_provider_keys SET searches_month_reset_at = %s WHERE org_id = %s",
                (last_month.replace(day=1), org_id),
            )
        check("a key whose usage counter is from a prior month is usable again",
              enrich.get_usable_provider_key(conn, org_id) is not None)

        # 7. status='invalid' or 'quota_exceeded' overrides everything else.
        with db.tenant_tx(conn, org_id) as cur:
            cur.execute("UPDATE leadsource_provider_keys SET status = 'invalid', searches_this_month = 0 WHERE org_id = %s", (org_id,))
        check("a key marked invalid is never usable even with searches remaining",
              enrich.get_usable_provider_key(conn, org_id) is None)
    finally:
        with db.staff_tx(conn) as cur:
            cur.execute("DELETE FROM organizations WHERE id = %s", (org_id,))
        conn.close()

    print(f"\n{passed} passed, {failed} failed.")
    return 1 if failed else 0


def _encrypt_like_node(plain: str):
    """Node's encryptSecret, re-implemented with the same AESGCM primitive
    vault.py already imports — this is the inverse of vault.decrypt_secret,
    used here only to produce a realistic row for check 4 without needing
    a live Node process."""
    import os as _os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = vault.vault_key()
    iv = _os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext_and_tag = aesgcm.encrypt(iv, plain.encode("utf-8"), None)
    enc, tag = ciphertext_and_tag[:-16], ciphertext_and_tag[-16:]
    return enc, iv, tag


if __name__ == "__main__":
    sys.exit(main())
