"""
Venturelyx :: credential vault (worker side).

Python mirror of api/src/lib/auth.ts's encryptSecret/decryptSecret. Same
scheme — AES-256-GCM, key from VAULT_KEY (64 hex chars = 32 bytes), 12-byte
IV, 16-byte auth tag stored separately (integrations.credential_iv /
credential_tag) — because the worker decrypts tokens the API encrypted; the
two implementations have to agree on every byte.
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def vault_key() -> bytes:
    hexkey = os.environ.get("VAULT_KEY", "")
    if len(hexkey) != 64:
        raise ValueError("VAULT_KEY must be 64 hex characters (32 bytes)")
    return bytes.fromhex(hexkey)


def decrypt_secret(enc: bytes, iv: bytes, tag: bytes) -> str:
    aesgcm = AESGCM(vault_key())
    # node:crypto stores the GCM tag separately; AESGCM expects ciphertext
    # and tag concatenated (tag last), the wire format its decrypt() expects.
    plaintext = aesgcm.decrypt(iv, bytes(enc) + bytes(tag), None)
    return plaintext.decode("utf-8")
