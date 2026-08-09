import JSZip from 'jszip';
import {
  collectXLSXSharedStrings,
  collectXLSXCellTextsFromXml,
  extractXLSXText,
  writeXLSXTranslations
} from './xlsx.js';

// Cells whose value lives in xl/sharedStrings.xml only store an index there.
// Extraction, QA residual checks, and write-back must all resolve the index
// against the shared strings table, never treat it as the cell text itself.
const SHARED_STRINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Revenue Report</t></si>
  <si><t xml:space="preserve">Total &amp; Subtotal</t></si>
  <si><r><t>Fiscal </t></r><r><t>Year</t></r></si>
</sst>`;

const SHEET_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2"><v>42</v></c>
    </row>
  </sheetData>
</worksheet>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></workbook>`;

async function buildFixture(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', WORKBOOK_XML);
  zip.file('xl/sharedStrings.xml', SHARED_STRINGS_XML);
  zip.file('xl/worksheets/sheet1.xml', SHEET_XML);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// --- shared string parsing ---------------------------------------------------
const sharedStrings = collectXLSXSharedStrings(SHARED_STRINGS_XML);
if (sharedStrings.length !== 3) {
  throw new Error(`Expected 3 shared strings, got ${sharedStrings.length}`);
}
if (sharedStrings[0] !== 'Revenue Report' || sharedStrings[1] !== 'Total & Subtotal' || sharedStrings[2] !== 'Fiscal Year') {
  throw new Error(`Shared strings not decoded correctly: ${JSON.stringify(sharedStrings)}`);
}

// --- QA residual scan must see resolved text, not indexes --------------------
const qaTexts = collectXLSXCellTextsFromXml(SHEET_XML, sharedStrings);
if (!qaTexts.includes('Revenue Report') || !qaTexts.includes('Total & Subtotal')) {
  throw new Error(`QA cell scan missed shared-string text: ${JSON.stringify(qaTexts)}`);
}
if (qaTexts.some(text => /^\d+$/.test(text))) {
  throw new Error(`QA cell scan leaked raw indexes or numbers: ${JSON.stringify(qaTexts)}`);
}

// --- extraction round trip ----------------------------------------------------
const fixture = await buildFixture();
const stats = await extractXLSXText(fixture);
const extracted = stats.paragraphs.map(item => item.originalText);
if (extracted.length !== 3) {
  throw new Error(`Expected 3 exposed cells, got ${extracted.length}: ${JSON.stringify(extracted)}`);
}
if (!extracted.includes('Revenue Report') || !extracted.includes('Fiscal Year') || !extracted.includes('Total & Subtotal')) {
  throw new Error(`Extraction did not resolve shared strings: ${JSON.stringify(extracted)}`);
}

// --- write-back round trip ----------------------------------------------------
const translated = await writeXLSXTranslations(fixture, {
  'xl/worksheets/sheet1.xml': {
    0: '营收报表',
    1: '财年',
    2: '合计与小计'
  }
});
const afterStats = await extractXLSXText(translated);
const afterTexts = afterStats.paragraphs.map(item => item.originalText);
if (!afterTexts.includes('营收报表') || !afterTexts.includes('财年') || !afterTexts.includes('合计与小计')) {
  throw new Error(`Write-back lost translated cells: ${JSON.stringify(afterTexts)}`);
}
if (afterTexts.includes('Revenue Report') || afterTexts.includes('Total & Subtotal')) {
  throw new Error(`Write-back left source text behind: ${JSON.stringify(afterTexts)}`);
}

console.log('xlsx round-trip tests passed');
