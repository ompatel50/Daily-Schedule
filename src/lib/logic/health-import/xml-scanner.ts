/**
 * An incremental, bounded XML *scanner* for Apple Health exports.
 *
 * Not a DOM parser and deliberately not a general one. `export.xml` is a flat
 * list of millions of `<Record …/>` elements; the only structure that matters
 * is "an element started", "an element ended", and its attributes. So this
 * emits exactly those three things as text arrives, in constant memory, and
 * the caller folds each event into an accumulator. A multi-gigabyte export
 * never exists in memory as a string, a DOM, or an array of samples.
 *
 * ## Why hand-written
 *
 * The two off-the-shelf shapes are both wrong here: a DOM parser materialises
 * the whole document, and a general SAX parser drags in entity, namespace and
 * DTD machinery — which is precisely the machinery that makes XML parsers
 * dangerous. This scanner has no entity table beyond the five predefined
 * ones, cannot be told to fetch anything, and treats a DTD as a region to skip
 * with a hard cap, so the classic attacks have nothing to attack:
 *
 *  * **XXE / external entities** — `<!ENTITY … SYSTEM "file:///etc/passwd">`.
 *    The scanner never resolves entities: an unknown `&foo;` stays the literal
 *    text `&foo;`, and a DOCTYPE that *declares* an entity is rejected
 *    outright (`declaredEntity`), so a file trying it fails loudly instead of
 *    quietly reading a server file.
 *  * **Billion laughs / quadratic blowup** — nested entity expansion. Nothing
 *    expands, so the attack has no amplification to work with.
 *  * **Unbounded buffering** — a crafted file that opens a tag and never
 *    closes it, or one enormous attribute, would otherwise grow the pending
 *    buffer without limit. `MAX_TAG_BYTES` caps a single element's text and
 *    `MAX_DOCTYPE_BYTES` caps the prologue; exceeding either is a parse error.
 *  * **Depth exhaustion** — `MAX_DEPTH` bounds nesting, so a file of ten
 *    million open tags cannot grow the element stack indefinitely.
 *
 * Everything here is pure and synchronous: bytes in, events out. It performs
 * no I/O and no network access, and it never logs the text it is given.
 */

export interface XmlStartEvent {
  name: string;
  attributes: Record<string, string>;
  /** True for `<Foo/>`; no matching `onEnd` will follow. */
  selfClosing: boolean;
  depth: number;
}

export interface XmlHandlers {
  onStart?: (event: XmlStartEvent) => void;
  onEnd?: (name: string, depth: number) => void;
  /** Character data inside an element, already entity-decoded. */
  onText?: (text: string, parent: string | null) => void;
}

/** One element's serialised text may not exceed this. */
export const MAX_TAG_BYTES = 256 * 1024;
/** The prologue (`<?xml …?>`, comments, DOCTYPE) may not exceed this. */
export const MAX_DOCTYPE_BYTES = 64 * 1024;
export const MAX_DEPTH = 64;
/** Attributes per element — Apple writes ~12; a file with thousands is not one. */
export const MAX_ATTRIBUTES = 256;

export class XmlScanError extends Error {}

/** Only the five predefined entities, plus numeric character references. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the entity references XML defines, and nothing else. An unknown
 * reference is returned verbatim rather than resolved — this parser has no
 * entity table to resolve it against, which is the point.
 */
export function decodeXmlText(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{0,9});/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return codePoint(code) ?? match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return codePoint(code) ?? match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function codePoint(code: number): string | null {
  // Reject surrogates and out-of-range values rather than producing lone
  // surrogates that would later break JSON serialisation.
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

type Mode = "text" | "tag";

/**
 * Feed text in with `write()` (any number of times, split anywhere — a tag may
 * straddle two calls) and finish with `end()`.
 */
export class XmlScanner {
  private pending = "";
  private mode: Mode = "text";
  private depth = 0;
  private readonly stack: string[] = [];
  private finished = false;

  constructor(private readonly handlers: XmlHandlers) {}

  write(chunk: string): void {
    if (this.finished) throw new XmlScanError("Data arrived after the document ended.");
    this.pending += chunk;
    this.drain();
  }

  end(): void {
    this.drain();
    // Trailing text outside any element is whitespace in a well-formed file;
    // an unterminated tag is not, and must not be silently accepted.
    if (this.mode === "tag") {
      throw new XmlScanError("The XML ends inside a tag — the file is truncated or damaged.");
    }
    this.flushText(this.pending);
    this.pending = "";
    this.finished = true;
  }

  private drain(): void {
    for (;;) {
      if (this.mode === "text") {
        const at = this.pending.indexOf("<");
        if (at === -1) {
          // Keep the tail: an entity reference may straddle the chunk boundary.
          const keep = Math.max(0, this.pending.length - 16);
          this.flushText(this.pending.slice(0, keep));
          this.pending = this.pending.slice(keep);
          return;
        }
        this.flushText(this.pending.slice(0, at));
        this.pending = this.pending.slice(at);
        this.mode = "tag";
        continue;
      }

      // mode === "tag": the buffer starts at "<".
      const consumed = this.consumeTag();
      if (consumed === null) {
        this.guardPendingSize();
        return;
      }
      this.pending = this.pending.slice(consumed);
      this.mode = "text";
    }
  }

  private guardPendingSize(): void {
    const isPrologue = this.pending.startsWith("<!") || this.pending.startsWith("<?");
    const limit = isPrologue ? MAX_DOCTYPE_BYTES : MAX_TAG_BYTES;
    if (this.pending.length > limit) {
      throw new XmlScanError(
        isPrologue
          ? "The XML prologue is implausibly large — refusing to read it."
          : "A single XML element is implausibly large — refusing to read it.",
      );
    }
  }

  /**
   * Try to consume one complete markup construct from the head of `pending`.
   * Returns how many characters it used, or null when more input is needed.
   */
  private consumeTag(): number | null {
    const buffer = this.pending;

    // <!-- comment -->
    if (buffer.startsWith("<!--")) {
      const close = buffer.indexOf("-->", 4);
      return close === -1 ? null : close + 3;
    }

    // <![CDATA[ … ]]>
    if (buffer.startsWith("<![CDATA[")) {
      const close = buffer.indexOf("]]>", 9);
      if (close === -1) return null;
      this.emitText(buffer.slice(9, close));
      return close + 3;
    }

    // <?xml … ?> / processing instruction
    if (buffer.startsWith("<?")) {
      const close = buffer.indexOf("?>", 2);
      return close === -1 ? null : close + 2;
    }

    // <!DOCTYPE … > — possibly with an internal subset in [ … ].
    if (buffer.startsWith("<!")) {
      return this.consumeDoctype(buffer);
    }

    // </Name>
    if (buffer.startsWith("</")) {
      const close = buffer.indexOf(">", 2);
      if (close === -1) return null;
      const name = buffer.slice(2, close).trim();
      this.closeElement(name);
      return close + 1;
    }

    // <Name attr="value" …> or <Name …/>
    const close = findTagEnd(buffer);
    if (close === -1) return null;
    this.openElement(buffer.slice(1, close));
    return close + 1;
  }

  /**
   * Consume a `<!DOCTYPE …>` declaration.
   *
   * A real Apple export *does* carry an internal subset — several kilobytes of
   * `<!ELEMENT>` and `<!ATTLIST>` declarations describing the record grammar —
   * so refusing every subset outright would refuse every genuine export. What
   * is refused is the part that is actually dangerous:
   *
   *  * an **external DTD** (`SYSTEM` / `PUBLIC`), which asks the parser to go
   *    and fetch something. This one never fetches anything, and a file that
   *    depends on a fetch is a file whose meaning this parser cannot honour.
   *  * an **entity declaration** anywhere in the subset. Entities are the
   *    whole of the XXE and billion-laughs family, and since nothing here
   *    expands them, silently ignoring a declaration would mean reading a
   *    document differently from what it says. Both are hard failures.
   *
   * Everything else in the subset is skipped without being interpreted.
   */
  private consumeDoctype(buffer: string): number | null {
    const end = findDoctypeEnd(buffer);
    if (end === -1) {
      if (buffer.length > MAX_DOCTYPE_BYTES) {
        throw new XmlScanError("The XML prologue is implausibly large — refusing to read it.");
      }
      return null;
    }
    const declaration = buffer.slice(0, end + 1);
    if (/<!ENTITY\b/i.test(declaration)) {
      throw new XmlScanError(
        "This XML declares an entity. This importer never resolves entity declarations, " +
          "so the file was not read — nothing was imported.",
      );
    }
    // Only the header, before any internal subset, can name an external DTD.
    const header = declaration.slice(0, declaration.indexOf("[") === -1 ? undefined : declaration.indexOf("["));
    if (/\b(SYSTEM|PUBLIC)\b/.test(header)) {
      throw new XmlScanError(
        "This XML refers to an external DTD. This importer never fetches anything, " +
          "so the file was not read — nothing was imported.",
      );
    }
    return end + 1;
  }

  private openElement(body: string): void {
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const name = readName(inner);
    if (!name) throw new XmlScanError("Malformed XML: an element has no name.");

    if (!selfClosing) {
      if (this.depth >= MAX_DEPTH) {
        throw new XmlScanError("The XML nests too deeply — refusing to read it.");
      }
      this.stack.push(name);
      this.depth += 1;
    }

    this.handlers.onStart?.({
      name,
      attributes: parseAttributes(inner, name.length),
      selfClosing,
      depth: selfClosing ? this.depth + 1 : this.depth,
    });
  }

  private closeElement(name: string): void {
    if (this.stack.length === 0) {
      throw new XmlScanError(`Malformed XML: </${name}> closes an element that was never opened.`);
    }
    const open = this.stack.pop() as string;
    this.depth -= 1;
    if (open !== name) {
      throw new XmlScanError(`Malformed XML: <${open}> is closed by </${name}>.`);
    }
    this.handlers.onEnd?.(name, this.depth + 1);
  }

  private flushText(raw: string): void {
    if (raw.length === 0) return;
    this.emitText(raw);
  }

  private emitText(raw: string): void {
    if (!this.handlers.onText) return;
    // Whitespace between elements is the overwhelming majority of an export's
    // character data and means nothing — skipping it here keeps the callback
    // off the hot path entirely.
    if (raw.trim().length === 0) return;
    this.handlers.onText(decodeXmlText(raw), this.stack[this.stack.length - 1] ?? null);
  }
}

/**
 * Index of the `>` that ends an open tag, skipping any inside quoted attribute
 * values. Returns -1 when the tag is not complete yet.
 */
function findTagEnd(buffer: string): number {
  let quote: string | null = null;
  for (let index = 1; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

/**
 * Index of the `>` that ends a `<!DOCTYPE …>`, honouring quoted strings, an
 * internal `[ … ]` subset and comments inside it. Returns -1 when the
 * declaration is not complete yet. Nothing inside is interpreted — this only
 * finds where it stops.
 */
function findDoctypeEnd(buffer: string): number {
  let quote: string | null = null;
  let inSubset = false;
  for (let index = 2; index < buffer.length; index += 1) {
    if (quote) {
      if (buffer[index] === quote) quote = null;
      continue;
    }
    if (buffer.startsWith("<!--", index)) {
      const close = buffer.indexOf("-->", index + 4);
      if (close === -1) return -1;
      index = close + 2;
      continue;
    }
    const char = buffer[index];
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") inSubset = true;
    else if (char === "]") inSubset = false;
    else if (char === ">" && !inSubset) return index;
  }
  return -1;
}

function readName(inner: string): string {
  const match = /^\s*([A-Za-z_][\w:.-]*)/.exec(inner);
  return match ? match[1] : "";
}

const ATTRIBUTE_PATTERN = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Attributes from one open tag's inner text, entity-decoded. */
export function parseAttributes(inner: string, from = 0): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = from;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = ATTRIBUTE_PATTERN.exec(inner)) !== null) {
    if (++count > MAX_ATTRIBUTES) {
      throw new XmlScanError("An XML element has an implausible number of attributes.");
    }
    attributes[match[1]] = decodeXmlText(match[3] ?? match[4] ?? "");
  }
  return attributes;
}
