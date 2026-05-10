// Minimal WebM (EBML) SimpleBlock extractor.
//
// Edge TTS's WEBM_24KHZ_16BIT_MONO_OPUS format wraps Opus packets in a
// Matroska/WebM container. xiaozhi-esp32 firmware expects raw Opus packets
// (one per V3 binary frame), not the WebM container. This module walks the
// container and yields the bare Opus payload from each SimpleBlock.
//
// Two surfaces:
//   - extractOpusFromWebm(buf): one-shot, walks a complete blob.
//   - WebmStreamParser: stateful, streaming. Feed bytes via push(); it yields
//     each Opus packet as soon as the SimpleBlock holding it is fully
//     received. Lets the caller pipeline TTS audio to the device while the
//     rest of the WebM is still being downloaded.
//
// Assumptions matching Edge TTS's actual output:
//   - Single audio track (track number 1)
//   - No lacing (each SimpleBlock holds one Opus packet)
//   - Segment / Cluster may have unknown size (live-stream style); we just
//     advance past their headers and parse children inline.
//
// EBML refresher:
//   Each element = ID (VINT, marker preserved) + size (VINT, marker stripped) + data
//   Container elements we transparently enter:
//     0x18538067 Segment, 0x1F43B675 Cluster
//   Element we extract:
//     0xA3 SimpleBlock — body = track (VINT) + timecode (2B BE int16) + flags (1B) + frame
//   Everything else is skipped by its declared size.

interface Vint {
  value: number;
  len: number;
}

// Sentinel returned when the buffer does not yet hold a complete vint. The
// streaming parser uses this to distinguish "wait for more bytes" from
// "structurally invalid" without throwing.
const VINT_INCOMPLETE: Vint = { value: 0, len: 0 };

function readVint(buf: Uint8Array, offset: number, stripMarker: boolean): Vint {
  if (offset >= buf.length) return VINT_INCOMPLETE;
  const first = buf[offset]!;
  if (first === 0) throw new Error(`invalid vint @${offset}`);
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    len++;
    mask >>= 1;
    if (len > 8) throw new Error(`vint too long @${offset}`);
  }
  let value = stripMarker ? first & (mask - 1) : first;
  for (let i = 1; i < len; i++) {
    if (offset + i >= buf.length) return VINT_INCOMPLETE;
    value = value * 256 + buf[offset + i]!;
  }
  return { value, len };
}

function* walk(buf: Uint8Array, start: number, end: number): IterableIterator<Uint8Array> {
  let offset = start;
  while (offset < end) {
    let id: Vint;
    let size: Vint;
    try {
      id = readVint(buf, offset, false);
      if (id.len === 0) break;
      size = readVint(buf, offset + id.len, true);
    } catch {
      break;
    }
    const dataStart = offset + id.len + size.len;
    const dataEnd = Math.min(dataStart + size.value, end);

    if (id.value === 0x18538067 /* Segment */ || id.value === 0x1F43B675 /* Cluster */) {
      yield* walk(buf, dataStart, dataEnd);
    } else if (id.value === 0xa3 /* SimpleBlock */) {
      // body: track (VINT, marker stripped) + timecode (2B) + flags (1B) + frame
      try {
        const track = readVint(buf, dataStart, true);
        const frameStart = dataStart + track.len + 2 /*timecode*/ + 1 /*flags*/;
        if (frameStart < dataEnd) {
          // Slice rather than subarray — caller may hold across stream lifetime.
          yield buf.slice(frameStart, dataEnd);
        }
      } catch {
        // skip malformed block
      }
    }
    // Everything else: just skip its size.

    offset = dataEnd;
  }
}

/**
 * Yields each Opus packet (raw, no container) found in a complete WebM blob.
 *
 * For Edge TTS WebM-Opus output the packets are typically 20ms each; xiaozhi
 * firmware decodes any valid Opus packet duration so we don't need to
 * regroup to 60ms.
 */
export function* extractOpusFromWebm(buf: Uint8Array): IterableIterator<Uint8Array> {
  yield* walk(buf, 0, buf.length);
}

// Container IDs we transparently descend into without waiting for them to
// finish. (For Edge TTS, Segment is typically the whole document and Cluster
// holds the audio frames.)
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLEBLOCK = 0xa3;

/**
 * Streaming counterpart to extractOpusFromWebm. Feed bytes as they arrive
 * via push(); each call returns Opus packets that are now fully decodable.
 *
 * Why this exists: Edge TTS sends a WebM-wrapped Opus stream. The original
 * one-shot extractor required the full blob before returning the first
 * packet, which forced us to wait for the entire TTS download to finish
 * (often 1-3 seconds for medium replies) before any audio could reach the
 * device. The streaming parser yields each SimpleBlock the moment its bytes
 * arrive, cutting first-byte-out latency to roughly the time it takes Edge
 * TTS to emit its EBML header + first Cluster + first SimpleBlock — usually
 * a few hundred ms.
 *
 * State held: an internal append buffer plus a parse offset. Once the parse
 * offset crosses a threshold the already-consumed prefix is sliced off so
 * memory does not grow unboundedly across long replies.
 */
export class WebmStreamParser {
  // Rolling buffer of unparsed bytes. Bytes before `offset` have been parsed
  // and may be GC-able; we periodically slice them off below.
  private buf: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private static readonly GC_THRESHOLD = 64 * 1024;

  /**
   * Append `chunk` to the internal buffer and return any Opus packets that
   * are now fully present. The caller is expected to consume the iterator
   * eagerly (e.g. via `for ... of`); each yielded packet is a fresh slice
   * safe to hold across calls.
   */
  *push(chunk: Uint8Array): IterableIterator<Uint8Array> {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buf.length - this.offset + chunk.length);
      merged.set(this.buf.subarray(this.offset), 0);
      merged.set(chunk, this.buf.length - this.offset);
      this.buf = merged;
      this.offset = 0;
    }
    yield* this.parseAvailable();
    if (this.offset >= WebmStreamParser.GC_THRESHOLD) {
      this.buf = this.buf.slice(this.offset);
      this.offset = 0;
    }
  }

  private *parseAvailable(): IterableIterator<Uint8Array> {
    while (this.offset < this.buf.length) {
      const elementStart = this.offset;
      let id: Vint;
      let size: Vint;
      try {
        id = readVint(this.buf, elementStart, false);
        if (id.len === 0) return;
        size = readVint(this.buf, elementStart + id.len, true);
        if (size.len === 0) return;
      } catch {
        // Structurally bad byte at this offset. Skip one byte and retry —
        // gives us a chance to resync if the upstream sent garbage. In
        // practice Edge TTS doesn't do this; the catch is defensive.
        this.offset++;
        continue;
      }

      const dataStart = elementStart + id.len + size.len;

      if (id.value === ID_SEGMENT || id.value === ID_CLUSTER) {
        // Transparent descent — advance past the header and parse the
        // children inline. We don't need to wait for the container to
        // finish, and Edge TTS often reports it as unknown-size anyway.
        this.offset = dataStart;
        continue;
      }

      const dataEnd = dataStart + size.value;
      if (dataEnd > this.buf.length) {
        // Need more bytes to cover this element.
        return;
      }

      if (id.value === ID_SIMPLEBLOCK) {
        try {
          const track = readVint(this.buf, dataStart, true);
          // track.len === 0 should never happen here because we already
          // verified dataEnd is in-buffer, but guard anyway.
          if (track.len > 0) {
            const frameStart = dataStart + track.len + 2 /*timecode*/ + 1 /*flags*/;
            if (frameStart < dataEnd) {
              yield this.buf.slice(frameStart, dataEnd);
            }
          }
        } catch {
          // Malformed block — skip the whole element by its declared size.
        }
      }

      this.offset = dataEnd;
    }
  }
}

/**
 * Convenience: consume an async byte source (e.g. msedge-tts audioStream)
 * and yield Opus packets as they become available. Reads are pipelined —
 * the first packet typically appears well before the source closes.
 */
export async function* parseOpusFromWebmStream(
  source: AsyncIterable<Uint8Array | Buffer>,
): AsyncIterable<Uint8Array> {
  const parser = new WebmStreamParser();
  for await (const c of source) {
    const chunk = c instanceof Uint8Array ? c : new Uint8Array(c);
    for (const opus of parser.push(chunk)) {
      yield opus;
    }
  }
}
