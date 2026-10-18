// Rebuild documentation examples using synthetic data only. No network or model calls.
// Run: node docs/assets/generate-demo.mjs
// Optional PNG frames: AZPR_DEMO_SHARP=/path/to/sharp node ... --frames
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assemblePlan, evaluatePlanPage } from '../../src/comments.mjs';
import { commentAttribution } from '../../src/attribution.mjs';
import { parsePullRequestUrl } from '../../src/azure.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const source = ['export function page(items, size, offset) {', '  const start = offset * size;', '  return items.slice(start, size);', '}'];
const finding = {
  id: 'Q-1', severity: 'medium', summary: 'Later pages are empty',
  location: 'head:/src/pagination.js:3',
  evidence: 'page([1, 2, 3, 4], 2, 1) returns [] instead of [3, 4].',
  counterevidence: 'The first page works because its start is zero.',
  suggestion: 'Use start + size as the exclusive end of the slice.',
};
const sections = [
  ['📝 Summary', 'The second and later pages return no items.'],
  ['🔎 Evidence', finding.evidence],
  ['💡 Suggested fix', finding.suggestion],
];
const attribution = commentAttribution({ stages: [{ model: 'example/model' }] }, 'en', 'example/model', { verification: 'none' });
const review = {
  id: 'synthetic-demo', profile: 'quick', verification: 'none', outputLanguage: 'en', attribution,
  target: parsePullRequestUrl('https://dev.azure.com/example-org/example-project/_git/example-repo/pullrequest/42'),
  snapshot: { head: '1'.repeat(40), base: '0'.repeat(40), files: ['/src/pagination.js'] },
  final: { dispositions: [{ id: finding.id, status: 'REPORTED', finding, inline: true }], newFindings: [] },
  toolText: [{ input: { commit: '1'.repeat(40), path: '/src/pagination.js' }, output: source.join('\n') }],
};
const title = `🟡 medium: ${finding.summary}`;
const body = [title, ...sections.map(([heading, text]) => `**${heading}**\n\n${text}`)].join('\n\n');
const page = evaluatePlanPage(JSON.stringify({
  status: 'READY', summary: 'Adds pagination for a list of items.', skipped: [],
  comments: [{ findingId: finding.id, severity: finding.severity, path: '/src/pagination.js', startLine: 3, endLine: 3, anchor: source[2], body }],
}), { review, assigned: [finding], sources: [{ path: '/src/pagination.js' }] });
assert.deepEqual(page.issues, []);
const plan = assemblePlan(review, [page.result]);
assert.equal(plan.comments.length, 1);
assert.match(plan.comments[0].content, /not independently verified/);
assert.match(plan.summary.content, /Q-1 — Later pages are empty/);
const withoutMarker = value => value.replace(/\n\n<!-- azpr-comment:[a-f0-9]+ -->$/, '');
await writeFile(join(directory, 'example-comments.md'), '# Illustrative example / synthetic PR\n\n' +
  'These comment bodies are assembled by the project renderer from a hand-written fixture, not a model review. `example/model` is a placeholder. No Azure thread was created. Hidden publication markers are omitted.\n\n' +
  '## Inline thread\n\n' + withoutMarker(plan.comments[0].content) + '\n\n## Summary thread\n\n' + withoutMarker(plan.summary.content) + '\n');

const colors = { ink: '#172b4d', muted: '#52637b', blue: '#005a9e', pale: '#edf5fd', line: '#dce5ef', bg: '#f2f6fb', white: '#ffffff', green: '#176b48', yellow: '#8a5900' };
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const text = (x, y, value, size = 20, fill = colors.ink, weight = 400, family = 'Arial, sans-serif') => `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}">${esc(value)}</text>`;
const rect = (x, y, w, h, fill = colors.white, radius = 12, stroke = 'none') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
const line = (x1, y1, x2) => `<path d="M${x1} ${y1}H${x2}" stroke="${colors.line}"/>`;
const svg = (height, title, description, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(description)}</desc>${body}</svg>\n`;
const label = (y = 47) => text(42, y, 'ILLUSTRATIVE EXAMPLE / SYNTHETIC PR', 14, colors.blue, 700);
const wrap = (value, limit) => {
  const rows = []; let row = '';
  for (const word of value.split(/\s+/)) {
    if (row && (row + ' ' + word).length > limit) { rows.push(row); row = word; }
    else row += (row ? ' ' : '') + word;
  }
  if (row) rows.push(row);
  return rows;
};
const paragraph = (value, x, y, limit, size = 20, fill = colors.ink, spacing = 28) => wrap(value, limit).map((row, i) => text(x, y + i * spacing, row, size, fill)).join('');
const plainDisclosure = attribution.replaceAll('`', '');
const renderedTitle = plan.comments[0].body.split('\n')[0].replace('🟡 ', '');
const summaryLines = plan.summary.content.split('\n');
const summaryCounts = summaryLines.find(row => row.startsWith('high:'));
const [, severityCell, summaryCell, locationCell] = summaryLines.find(row => row.startsWith('| 🟡')).split('|').map(cell => cell.trim());
const hero = svg(1088, 'Azure DevOps comment format: synthetic quick-review example',
  'Illustrative layout, not an Azure screenshot. One medium finding about pagination is shown as an inline comment and a summary index. Quick review is explicitly not independently verified. Exact accessible comment text is linked in the demo guide.',
  rect(0, 0, 1200, 1088, colors.bg, 0) + label() +
  text(42, 94, 'Review findings, where your team works.', 34, colors.ink, 700) +
  text(42, 128, 'Azure DevOps-style layout · Real comment renderer · Hand-written fixture', 19, colors.muted) +
  rect(40, 156, 1120, 552, colors.white, 14, colors.line) +
  rect(40, 156, 1120, 46, colors.blue, 12) + rect(40, 184, 1120, 18, colors.blue, 0) +
  text(64, 186, 'Example project  /  Pull request #42  /  Files', 19, colors.white, 700) +
  text(64, 236, 'src/pagination.js', 19, colors.ink, 700, 'Consolas, monospace') +
  rect(64, 254, 1072, 118, '#f6f8fa', 8) + rect(64, 312, 1072, 26, '#e7f4ec', 0) +
  source.map((row, i) => text(82, 279 + i * 26, `${i + 1}   ${row}`, 18, colors.ink, 400, 'Consolas, monospace')).join('') +
  `<circle cx="77" cy="409" r="8" fill="#b87900"/>` +
  text(96, 416, renderedTitle, 24, colors.ink, 700) +
  sections.map(([heading, detail], i) => text(64, 460 + i * 65, heading.slice(3).trim(), 17, colors.blue, 700) + text(64, 486 + i * 65, detail, 20)).join('') +
  line(64, 635, 1136, 635) + paragraph(plainDisclosure, 64, 659, 106, 16, colors.muted, 23) +
  rect(40, 730, 1120, 288, colors.white, 14, colors.line) +
  text(64, 770, 'PR Review Summary', 27, colors.ink, 700) +
  text(64, 804, page.result.summary, 20) +
  text(64, 838, summaryCounts, 18, colors.muted) +
  rect(64, 856, 1072, 37, colors.pale, 5) +
  text(80, 881, 'Severity', 17, colors.blue, 700) + text(232, 881, 'Summary', 17, colors.blue, 700) + text(776, 881, 'Location', 17, colors.blue, 700) +
  text(80, 923, severityCell.replace('🟡 ', ''), 19, colors.yellow, 700) + text(232, 923, summaryCell, 19) + text(776, 923, locationCell, 17, colors.ink, 400, 'Consolas, monospace') +
  paragraph(plainDisclosure, 64, 963, 106, 16, colors.muted, 23) +
  text(42, 1059, 'No live model call or Azure publication. Colors and spacing are illustrative; comment text is renderer-generated.', 16, colors.muted));
await writeFile(join(directory, 'review-example.svg'), hero);

const steps = [
  { name: 'Check setup', command: '/pr-check <azure-pr-url>', status: 'PR access and model readiness', color: colors.blue, lines: ['Check PR, source and discussion access,', 'plus plugin configuration and model readiness.'], detail: 'Resolve errors and inspect warnings before starting a review.', note: 'This command does not call a review model.' },
  { name: 'Run a quick review', command: '/pr-quick <azure-pr-url>', status: 'REPORTED · verification: none', color: colors.yellow, lines: ['One reviewer per shard covers function and risk.', 'The example finding: later pages are empty.'], detail: 'Inspect the report and any coverage gaps.', note: 'No independent verifier. A session can make several model requests.' },
  { name: 'Preview comments', command: '/pr-comment', status: 'Preview · no Azure write', color: colors.blue, lines: ['A model plans the inline comment and summary.', 'Review the proposed text before publishing.'], detail: 'The saved preview includes the quick-review disclosure.', note: 'Comment planning is additional model work.' },
  { name: 'Publish when ready', command: '/pr-comment --publish', status: 'Optional · explicit Azure write', color: colors.green, lines: ['The runtime rechecks the PR and publishes', 'the saved preview, skipping existing markers.'], detail: 'The receipt reports which items were published or skipped.', note: 'Shown as a workflow step only. Nothing was published for this demo.' },
];
function frame(step, index) {
  return svg(660, `Illustrative quick review: step ${index + 1}, ${step.name}`, 'Synthetic workflow illustration, not a live OpenCode recording. No timing or review-accuracy claim.',
    rect(0, 0, 1200, 660, colors.bg, 0) + label() + text(42, 99, 'From setup to a comment preview', 34, colors.ink, 700) +
    text(42, 133, 'A synthetic walkthrough. Your report and runtime notices will differ.', 19, colors.muted) +
    steps.map((item, n) => rect(42 + n * 284, 164, 268, 48, n === index ? colors.blue : '#e4ebf4', 9) + text(58 + n * 284, 195, `${n + 1}. ${item.name}`, 18, n === index ? colors.white : colors.muted, 700)).join('') +
    rect(42, 240, 1118, 343, colors.white, 14, colors.line) +
    text(68, 282, `STEP ${index + 1} / 4`, 15, colors.blue, 700) +
    rect(66, 305, 1070, 63, '#172b4d', 9) + text(88, 346, '> ' + step.command, 25, colors.white, 400, 'Consolas, monospace') +
    text(68, 410, step.status, 24, step.color, 700) +
    step.lines.map((value, n) => text(68, 453 + n * 33, value, 24)).join('') +
    text(68, 546, step.detail, 20, colors.muted) +
    text(42, 622, step.note, 18, colors.muted));
}
const frames = steps.map(frame);
const walkthrough = svg(1100, 'Four-step quick review walkthrough',
  'Synthetic example: run pr-check and pr-quick with an Azure pull request URL, preview with pr-comment, then optionally publish with pr-comment --publish. No model call or Azure publication was made for this illustration.',
  rect(0, 0, 1200, 1100, colors.bg, 0) + label() + text(42, 99, 'Your first review, step by step', 34, colors.ink, 700) +
  steps.map((step, index) => {
    const y = 142 + index * 228;
    return rect(42, y, 1118, 204, colors.white, 12, colors.line) +
      text(66, y + 36, `${index + 1}. ${step.name}`, 24, colors.ink, 700) +
      text(66, y + 76, step.command, 24, colors.blue, 700, 'Consolas, monospace') +
      text(66, y + 116, step.status, 20, step.color, 700) +
      text(66, y + 153, step.lines.join(' '), 20) + text(66, y + 184, step.note, 17, colors.muted);
  }).join('') + text(42, 1080, 'Illustrative example / synthetic PR. No live model call or Azure publication.', 17, colors.muted));
await writeFile(join(directory, 'walkthrough.svg'), walkthrough);
if (process.argv.includes('--frames')) {
  // Optional documentation tooling, never a plugin dependency. Uses an already installed Sharp package.
  const require = createRequire(import.meta.url);
  const sharp = require(process.env.AZPR_DEMO_SHARP || 'sharp');
  const frameDirectory = fileURLToPath(new URL('../../.local/project-launch-demo-assets/', import.meta.url));
  await mkdir(frameDirectory, { recursive: true });
  await sharp(Buffer.from(hero)).png().toFile(join(frameDirectory, 'review-example.png'));
  await sharp(Buffer.from(walkthrough)).png().toFile(join(frameDirectory, 'walkthrough.png'));
  for (let i = 0; i < frames.length; i++) await sharp(Buffer.from(frames[i])).png().toFile(join(frameDirectory, `step-${i + 1}.png`));
}
console.log('Generated synthetic comment text, review-example.svg and walkthrough.svg.');
