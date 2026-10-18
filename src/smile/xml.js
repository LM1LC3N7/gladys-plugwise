// -----------------------------------------------------------------------------
// A minimal XML reader for the answers of a Plugwise Smile. Pure, no
// dependency, written for hostile input:
// - no DTD at all: `<!DOCTYPE`, `<!ENTITY` and every other `<!` declaration
//   (comments and CDATA aside) are refused, so no external entity (XXE) and no
//   entity expansion ("billion laughs") can exist;
// - only the five predefined entities and numeric character references are
//   decoded; any other `&name;` is kept as written, never expanded. A bare `&`
//   (the Smile sends some, python-plugwise escapes them) is kept as `&`;
// - bounded: input length (the HTTP layer caps the bytes first), depth,
//   number of elements, attributes per element, name length;
// - linear: one pass with indexOf and sticky regexps, no backtracking pattern;
// - no prototype pollution: attributes live in a Map, children in arrays,
//   names are only ever compared, never used as object keys.
// -----------------------------------------------------------------------------

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

export const XML_LIMITS = Object.freeze({
  /** Characters of the whole document. */
  MAX_CHARS: 4 * 1024 * 1024,
  /** Nesting depth (a domain_objects answer is about 10 levels deep). */
  MAX_DEPTH: 64,
  /** Elements in the document (an Adam with many devices: a few tens of thousands). */
  MAX_ELEMENTS: 200_000,
  /** Attributes of one element. */
  MAX_ATTRIBUTES: 32,
  /** Characters of an element or attribute name. */
  MAX_NAME: 128,
});

const NAME = /[A-Za-z_][-A-Za-z0-9_.:]*/y;
const SPACE = /[ \t\r\n]*/y;
const PREDEFINED = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** Decode the predefined entities and character references; keep anything else as written. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      const valid =
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED.get(ref) ?? whole;
  });
}

class Element {
  constructor(name, attributes) {
    this.name = name;
    this.attributes = attributes;
    this.children = [];
    this.parts = [];
  }

  /** The text directly inside the element (entities decoded), trimmed. */
  get text() {
    return this.parts.join('').trim();
  }
}

function readName(source, at) {
  NAME.lastIndex = at;
  const match = NAME.exec(source);
  if (!match) throw new XmlError(`Name expected at ${at}`);
  if (match[0].length > XML_LIMITS.MAX_NAME) throw new XmlError('Name too long');
  return match[0];
}

function skipSpace(source, at) {
  SPACE.lastIndex = at;
  SPACE.exec(source);
  return SPACE.lastIndex;
}

/**
 * Parse a document; returns its root element.
 * @param {string | Buffer} input
 */
export function parseXml(input) {
  const source = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  if (source.length > XML_LIMITS.MAX_CHARS) throw new XmlError('Document too large');
  const stack = [];
  let root = null;
  let count = 0;
  let at = 0;

  const addText = (text) => {
    if (text === '') return;
    const current = stack.at(-1);
    if (!current) {
      if (text.trim() !== '') throw new XmlError('Text outside the root element');
      return;
    }
    current.parts.push(text);
  };

  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open === -1) {
      addText(decodeEntities(source.slice(at)));
      break;
    }
    if (open > at) addText(decodeEntities(source.slice(at, open)));

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end === -1) throw new XmlError('Unclosed comment');
      at = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end === -1) throw new XmlError('Unclosed CDATA');
      if (!stack.length) throw new XmlError('CDATA outside the root element');
      stack.at(-1).parts.push(source.slice(open + 9, end));
      at = end + 3;
      continue;
    }
    if (source.startsWith('<!', open)) {
      // DOCTYPE, ENTITY, ELEMENT...: never read, the whole answer is refused.
      throw new XmlError('Declarations (DTD) are refused');
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end === -1) throw new XmlError('Unclosed processing instruction');
      at = end + 2;
      continue;
    }
    if (source[open + 1] === '/') {
      const name = readName(source, open + 2);
      const close = skipSpace(source, open + 2 + name.length);
      if (source[close] !== '>') throw new XmlError('Malformed end tag');
      const current = stack.pop();
      if (!current || current.name !== name) throw new XmlError('Mismatched end tag');
      at = close + 1;
      continue;
    }

    // A start tag.
    const name = readName(source, open + 1);
    let cursor = open + 1 + name.length;
    const attributes = new Map();
    let selfClosing = false;
    for (;;) {
      const next = skipSpace(source, cursor);
      const char = source[next];
      if (char === '>') {
        cursor = next + 1;
        break;
      }
      if (char === '/' && source[next + 1] === '>') {
        selfClosing = true;
        cursor = next + 2;
        break;
      }
      if (next === cursor) throw new XmlError('Space expected before an attribute');
      const attribute = readName(source, next);
      let pos = skipSpace(source, next + attribute.length);
      if (source[pos] !== '=') throw new XmlError('Attribute without value');
      pos = skipSpace(source, pos + 1);
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") throw new XmlError('Unquoted attribute');
      const end = source.indexOf(quote, pos + 1);
      if (end === -1) throw new XmlError('Unclosed attribute');
      const raw = source.slice(pos + 1, end);
      if (raw.includes('<')) throw new XmlError('"<" in an attribute');
      if (attributes.has(attribute)) throw new XmlError('Duplicate attribute');
      if (attributes.size >= XML_LIMITS.MAX_ATTRIBUTES) throw new XmlError('Too many attributes');
      attributes.set(attribute, decodeEntities(raw));
      cursor = end + 1;
    }
    count += 1;
    if (count > XML_LIMITS.MAX_ELEMENTS) throw new XmlError('Too many elements');
    const element = new Element(name, attributes);
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(element);
    } else {
      if (root) throw new XmlError('More than one root element');
      root = element;
    }
    if (!selfClosing) {
      if (stack.length >= XML_LIMITS.MAX_DEPTH) throw new XmlError('Too deep');
      stack.push(element);
    }
    at = cursor;
  }
  if (stack.length) throw new XmlError('Unclosed element');
  if (!root) throw new XmlError('No root element');
  return root;
}

// --- Queries (no XPath: plain walks over the tree) ---------------------------------

/** The first direct child named `name`. */
export const child = (element, name) => element?.children.find((c) => c.name === name);

/** Every direct child named `name`. */
export const children = (element, name) =>
  element ? element.children.filter((c) => c.name === name) : [];

/** The first element at `a/b/c` below `element` (each step a direct child). */
export function path(element, steps) {
  let current = element;
  for (const step of steps.split('/')) {
    current = child(current, step);
    if (!current) return undefined;
  }
  return current;
}

/** Every element at `a/b/c` below `element`. */
export function paths(element, steps) {
  let current = element ? [element] : [];
  for (const step of steps.split('/')) {
    current = current.flatMap((e) => children(e, step));
  }
  return current;
}

/** The trimmed text of the first element at `steps`, or undefined when absent or empty. */
export function textAt(element, steps) {
  const found = path(element, steps);
  const text = found?.text;
  return text === undefined || text === '' ? undefined : text;
}

/** An attribute, or undefined. */
export const attr = (element, name) => element?.attributes.get(name);

/** Escape a text for an XML body we send (names of locations, modes). */
export const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
