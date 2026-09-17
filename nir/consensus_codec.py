"""Normative NIR consensus byte encoding shared by independent implementations."""

from __future__ import annotations

from hashlib import sha3_256
import re
import struct
import unicodedata


ENCODING_VERSION = 1
_PREFIX = b"NIR-CONSENSUS"
_DOMAIN = re.compile(r"^[A-Z0-9_-]{1,40}$")
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_DEPTH = 64
_MAX_CONTAINER_ENTRIES = 100_000
_MAX_STRING_BYTES = 16 * 1024 * 1024
_MAX_ENCODED_BYTES = 64 * 1024 * 1024


class ConsensusEncodingError(ValueError):
    """Raised when a value is outside the normative consensus data model."""


def _string_bytes(value: str, field: str) -> bytes:
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise ConsensusEncodingError(
            f"{field} contains an unpaired Unicode surrogate"
        ) from error
    if len(encoded) > _MAX_STRING_BYTES:
        raise ConsensusEncodingError(f"{field} is too large")
    return encoded


def _u32(value: int) -> bytes:
    return struct.pack(">I", value)


def _append(output: bytearray, *parts: bytes) -> None:
    for part in parts:
        if len(output) + len(part) > _MAX_ENCODED_BYTES:
            raise ConsensusEncodingError("consensus value is too large")
        output.extend(part)


def _encode(
    value: object, output: bytearray, active: set[int], depth: int, field: str
) -> None:
    if depth > _MAX_DEPTH:
        raise ConsensusEncodingError("consensus value nesting is too deep")
    if value is None:
        _append(output, b"\x00")
        return
    if value is False:
        _append(output, b"\x01")
        return
    if value is True:
        _append(output, b"\x02")
        return
    if type(value) is int:
        if value < -_MAX_SAFE_INTEGER or value > _MAX_SAFE_INTEGER:
            raise ConsensusEncodingError(f"{field} must be an unambiguous safe integer")
        _append(output, b"\x03", struct.pack(">q", value))
        return
    if type(value) is str:
        encoded = _string_bytes(value, field)
        _append(output, b"\x04", _u32(len(encoded)), encoded)
        return
    if type(value) not in (list, dict):
        raise ConsensusEncodingError(f"{field} contains an unsupported value type")
    identity = id(value)
    if identity in active:
        raise ConsensusEncodingError("consensus value contains a cycle")
    active.add(identity)
    try:
        if type(value) is list:
            if len(value) > _MAX_CONTAINER_ENTRIES:
                raise ConsensusEncodingError(f"{field} is too large")
            _append(output, b"\x05", _u32(len(value)))
            for index, item in enumerate(value):
                _encode(item, output, active, depth + 1, f"{field}[{index}]")
            return
        if len(value) > _MAX_CONTAINER_ENTRIES:
            raise ConsensusEncodingError(f"{field} has too many fields")
        entries: list[tuple[bytes, str, object]] = []
        key_bytes_total = 0
        for key, item in value.items():
            if type(key) is not str:
                raise ConsensusEncodingError(f"{field} contains a non-string key")
            key_bytes = _string_bytes(key, f"{field} key")
            key_bytes_total += len(key_bytes)
            if key_bytes_total > _MAX_ENCODED_BYTES:
                raise ConsensusEncodingError("consensus value is too large")
            if unicodedata.normalize("NFC", key) != key:
                raise ConsensusEncodingError(f"{field} contains an ambiguous non-NFC key")
            entries.append((key_bytes, key, item))
        entries.sort(key=lambda entry: entry[0])
        _append(output, b"\x06", _u32(len(entries)))
        for key_bytes, key, item in entries:
            _append(output, b"\x04", _u32(len(key_bytes)), key_bytes)
            _encode(item, output, active, depth + 1, f"{field}.{key}")
    finally:
        active.remove(identity)


def consensus_value_bytes(value: object) -> bytes:
    encoded = bytearray()
    _encode(value, encoded, set(), 0, "consensus value")
    return bytes(encoded)


def consensus_envelope_bytes(domain: str, value: object) -> bytes:
    if type(domain) is not str or _DOMAIN.fullmatch(domain) is None:
        raise ConsensusEncodingError("invalid cryptographic domain")
    domain_bytes = domain.encode("ascii")
    return (
        _PREFIX + b"\x00" + struct.pack(">H", ENCODING_VERSION) +
        bytes((len(domain_bytes),)) + domain_bytes + consensus_value_bytes(value)
    )


def consensus_hash(domain: str, value: object) -> str:
    return sha3_256(consensus_envelope_bytes(domain, value)).hexdigest()
