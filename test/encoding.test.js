// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™"). And a
// secret field is never said "encrypted": Gladys keeps it in clear in its
// database.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Â, Ã, Å: the first byte of a two-byte UTF-8 sequence read as Latin-1 (none
// of them is used in these English and French texts); â€: the curly quotes,
// dashes and ellipsis read as Windows-1252.
const MOJIBAKE = /[ÂÃÅ]|â€/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
];
// "Not encrypted" is allowed (it says the truth); any other form is not.
const ENCRYPTED = /(?<!non |pas |not |never )(?:chiffré|encrypted)/i;

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, never "encrypted"`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const lines = text.split('\n');
    const line = lines.findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
    const secret = lines.findIndex((l) => ENCRYPTED.test(l));
    assert.equal(secret, -1, `"encrypted" on line ${secret + 1}`);
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.match('Å“uvre', MOJIBAKE, 'œ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
  assert.match('le jeton est chiffré', ENCRYPTED);
  assert.match('stored encrypted', ENCRYPTED);
  assert.doesNotMatch('never encrypted', ENCRYPTED);
  assert.doesNotMatch('il n’est pas chiffré', ENCRYPTED);
});
