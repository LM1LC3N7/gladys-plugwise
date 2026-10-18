// -----------------------------------------------------------------------------
// The XML reader (src/smile/xml.js): what a Smile sends is read, what an
// attacker could send is refused or kept inert.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  XML_LIMITS,
  XmlError,
  attr,
  child,
  children,
  decodeEntities,
  escapeXml,
  parseXml,
  path,
  paths,
  textAt,
} from '../src/smile/xml.js';

test('elements, attributes in both quotes, text, self-closing tags, comments, declaration', () => {
  const root = parseXml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment -->\n<domain_objects>\n\t<location id='abc' kind="x">\n\t\t<name>Living room</name>\n\t\t<logs/>\n\t</location>\n</domain_objects>\n`,
  );
  assert.equal(root.name, 'domain_objects');
  const location = child(root, 'location');
  assert.equal(attr(location, 'id'), 'abc');
  assert.equal(attr(location, 'kind'), 'x');
  assert.equal(textAt(location, 'name'), 'Living room');
  assert.equal(child(location, 'logs').children.length, 0);
  assert.equal(textAt(location, 'missing'), undefined);
  assert.equal(path(root, 'location/name').text, 'Living room');
  assert.equal(paths(root, 'location/name').length, 1);
  assert.equal(children(undefined, 'x').length, 0);
});

test('the five entities and character references are decoded; nothing else is', () => {
  const root = parseXml(
    '<a t="&lt;&amp;&quot;&apos;&gt;">x &amp; y &#233;&#xE9; &nbsp; &foo; &bad & bare</a>',
  );
  assert.equal(attr(root, 't'), `<&"'>`);
  assert.equal(root.text, 'x & y éé &nbsp; &foo; &bad & bare');
  assert.equal(decodeEntities('&#0;&#xD800;'), '&#0;&#xD800;', 'invalid code points kept');
  assert.equal(parseXml('<a><![CDATA[<not> &amp; parsed]]></a>').text, '<not> &amp; parsed');
});

test('no DTD: external entities (XXE) and entity expansion are refused', () => {
  const attacks = [
    '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
    '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>',
    '<a><!ENTITY x "y"></a>',
    '<a><!ELEMENT a ANY></a>',
  ];
  for (const xml of attacks) {
    assert.throws(() => parseXml(xml), XmlError, xml);
  }
  // An entity reference without its DTD stays inert text.
  assert.equal(parseXml('<foo>&xxe;</foo>').text, '&xxe;');
});

test('malformed documents are refused', () => {
  for (const xml of [
    '',
    'text',
    '<a>',
    '<a></b>',
    '<a></a><b></b>',
    '<a b=c></a>',
    '<a b></a>',
    '<a b="1" b="2"></a>',
    '<a b="<"></a>',
    '<a b="1"c="2"></a>',
    '<a><!-- open</a>',
    '<a><![CDATA[open</a>',
    '<a>x</a>trailing',
    '<1a></1a>',
  ]) {
    assert.throws(() => parseXml(xml), XmlError, JSON.stringify(xml));
  }
});

test('bounded: depth, elements, attributes, names, size', () => {
  const deep = '<a>'.repeat(XML_LIMITS.MAX_DEPTH + 1) + '</a>'.repeat(XML_LIMITS.MAX_DEPTH + 1);
  assert.throws(() => parseXml(deep), /Too deep/);
  const ok = '<a>'.repeat(XML_LIMITS.MAX_DEPTH) + '</a>'.repeat(XML_LIMITS.MAX_DEPTH);
  assert.equal(parseXml(ok).name, 'a');
  assert.throws(
    () => parseXml(`<r>${'<b/>'.repeat(XML_LIMITS.MAX_ELEMENTS)}</r>`),
    /Too many elements/,
  );
  const attributes = Array.from({ length: XML_LIMITS.MAX_ATTRIBUTES + 1 }, (_, i) => `a${i}="1"`);
  assert.throws(() => parseXml(`<r ${attributes.join(' ')}/>`), /Too many attributes/);
  assert.throws(() => parseXml(`<${'n'.repeat(XML_LIMITS.MAX_NAME + 1)}/>`), /Name too long/);
  assert.throws(() => parseXml(' '.repeat(XML_LIMITS.MAX_CHARS + 1)), /too large/);
});

test('no prototype pollution: names are data, never keys', () => {
  const root = parseXml(
    '<__proto__ constructor="x" __proto__="y"><prototype polluted="1"/></__proto__>',
  );
  assert.equal(root.name, '__proto__');
  assert.equal(attr(root, '__proto__'), 'y');
  assert.equal(attr(root, 'constructor'), 'x');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.constructor, Object);
  assert.equal(attr(root, 'toString'), undefined);
});

test('linear: a large hostile document is read or refused quickly', () => {
  const started = performance.now();
  const many = `<r>${'<a x="1">t</a>'.repeat(150_000)}</r>`;
  assert.equal(parseXml(many).children.length, 150_000);
  // Unclosed quotes and tags: refused at once, without backtracking.
  assert.throws(() => parseXml(`<r a="${'x'.repeat(3_000_000)}`));
  assert.throws(() => parseXml(`<r>${'&amp'.repeat(500_000)}`));
  assert.ok(performance.now() - started < 5000, 'took too long');
});

test('what we send is escaped', () => {
  assert.equal(escapeXml(`a<b>&"c'`), 'a&lt;b&gt;&amp;&quot;c&apos;');
  assert.equal(parseXml(`<n>${escapeXml('Salon & <cuisine>')}</n>`).text, 'Salon & <cuisine>');
});

test('a Buffer is read as UTF-8', () => {
  assert.equal(parseXml(Buffer.from('<a>Séjour</a>', 'utf8')).text, 'Séjour');
});
