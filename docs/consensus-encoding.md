# Normative consensus encoding

Every NIR object that is signed or hashed uses one language-neutral byte format.
Object insertion order, runtime JSON behavior, locale settings and prototype
behavior are not consensus inputs.

The current format identifier is `nir-consensus-bytes-v1`. Its envelope is:

```text
"NIR-CONSENSUS" || 0x00 || uint16_be(1) || uint8(domain_length)
|| domain_ascii || encoded_value
```

The domain is one to 40 characters from `A-Z`, `0-9`, `_` and `-`. It is inside
the signed or hashed bytes, so a valid signature or digest for one purpose
cannot be reused for another purpose.

## Value grammar

All lengths are unsigned 32-bit big-endian integers. Integer payloads are
signed 64-bit two's-complement big-endian values, restricted further to the
exact interoperable range `-9007199254740991..9007199254740991`.

| Tag | Value | Following bytes |
| --- | --- | --- |
| `00` | null | none |
| `01` | false | none |
| `02` | true | none |
| `03` | integer | eight-byte signed integer |
| `04` | string | byte length, then strict UTF-8 |
| `05` | array | element count, then encoded elements |
| `06` | map | entry count, then encoded key and value pairs |

Map keys are strings encoded with tag `04`. Entries are sorted by the unsigned
lexicographic order of their UTF-8 key bytes. Keys must already be in Unicode
NFC form. The encoder never silently changes a key.

String values are not normalized. Distinct Unicode scalar sequences remain
distinct byte strings, including precomposed and decomposed forms. Unpaired
surrogates are rejected rather than being replaced during UTF-8 conversion.

The following values fail closed:

- `undefined`, functions, symbols, arbitrary-precision integers and all
  non-integer numeric values;
- `NaN`, infinities, negative zero and integers outside the exact range;
- sparse arrays, array properties, symbol keys and cyclic values;
- accessors, proxies, class instances and exotic prototypes;
- hidden non-enumerable map fields and non-NFC map keys;
- nesting deeper than 64, more than 100,000 entries, strings above 16 MiB or
  an encoded value above 64 MiB.

Frozen ordinary maps and arrays remain valid because immutability does not alter
their data model.

## Strict JSON boundary

JSON is a transport and storage representation, not the signed representation.
Consensus-facing HTTP and durable chain stores parse it with a strict parser
before validation. The parser rejects duplicate keys, non-NFC keys, fractional
or exponent number spellings, negative zero, unsafe integers, invalid Unicode
and trailing syntax. This prevents two implementations from interpreting one
JSON document differently before producing consensus bytes.

Fixed envelopes still have explicit schemas. Blocks and every native
transaction type reject missing or extra fields before execution. Other
protocol objects retain their local schema validators; the byte codec does not
turn an unknown field into an ignored field.

## Version changes and activation

Encoding version 1 is the normative encoding for active protocol versions 24
and 25. A later encoding is not a local configuration choice. It requires:

1. a published implementation and new language-neutral vectors;
2. a sequential protocol version containing the exact new encoding rules;
3. a quorum-finalized on-chain schedule;
4. the minimum activation delay;
5. activation at the exact scheduled height.

The block header commits its protocol version. An old node rejects an unknown
activation instead of guessing which bytes were signed. An encoding upgrade
changes only validation of the activation block and later data; it does not
rehash earlier blocks or alter balances, issuance, burned value or vesting.

The repository introduced version 1 before a production ledger existed, so
legacy development stores created by the earlier non-normative serializer are
not imported as authoritative history. They must be reinitialized rather than
silently reinterpreted.

## Conformance vectors

[`tests/vectors/consensus-codec-v1.json`](../tests/vectors/consensus-codec-v1.json)
contains value bytes, complete domain-separated envelopes and SHA3-256 digests.
Independent JavaScript and Python implementations execute the same vectors.
Negative and property tests cover order permutation, type separation, hostile
runtime objects, duplicate JSON keys, number edge cases and Unicode ambiguity.
