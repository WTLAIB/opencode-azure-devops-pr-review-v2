import { ROLES } from './config.mjs';
import { TESTED_HOST_VERSION } from './host.mjs';
// Deterministic attribution from invoked reviewer stages, not model-authored claims.
const vocabulary = {
  en: { title: 'AI review provenance', disclaimer: 'AI-generated review, not human approval. Posting through a user account does not imply that person verified these conclusions.', method: 'Independent initial reviews, followed by source-based verification, duplicate merging, and rejection of unsupported findings; not majority voting.', roles: ['Source check', 'Functional review', 'Risk review', 'Verification', 'Duplicate check', 'Quick review'], stage: 'Stage', model: 'Selected provider/model ID', sessions: 'Sessions', count: 'Initial findings', dispositions: 'Finding dispositions', finding: 'Finding', result: 'Result', merged: 'Merged into', extra: 'New verifier findings', note: 'IDs identify the models selected in OpenCode, not independently verified provider backend identities. Host auxiliary models and the original chat model are not part of this ledger.', comment: 'AI-generated review; not human review or approval. Models:',
    quickMethod: 'Quick review: one reviewer per shard covered functional and risk focus and checked its own findings against the source it read; no independent verification or duplicate merging. The runtime checked only the form and source of the findings.',
    lead: 'AI-generated review; not human review or approval. ', quick: 'Review method: quick review, not independently verified', coverage: 'coverage incomplete', models: 'Models:', separator: '; ', end: '. ' },
  tw: { title: 'AI 審查來源', disclaimer: '本報告由 AI 產生，不代表人工核准。使用個人帳號發佈，不表示該使用者已驗證這些結論。', method: '各模型獨立初審，再由驗證模型回查原始碼、交叉驗證、合併重複問題並排除缺乏證據的結論；不是多數決。', roles: ['來源檢查', '功能初審', '風險初審', '驗證', '重複檢查', '快速審查'], stage: '階段', model: '實際選用的 provider/model ID', sessions: '工作階段數', count: '初審問題數', dispositions: '問題處置', finding: '問題', result: '結果', merged: '合併至', extra: '驗證新增問題', note: '此處記錄 OpenCode 實際選用的模型 ID，不是對供應商後端模型身分的獨立驗證；不包含主對話及宿主的輔助模型。', comment: 'AI 審查，非人工審查或核准。模型：',
    quickMethod: '快速審查：每個分片由一位審查者同時檢查功能與風險，並依自己讀到的原始碼回查發現；沒有獨立驗證，也沒有合併重複問題。runtime 只檢查發現的形式與來源。',
    lead: 'AI 審查，非人工審查或核准。', quick: '審查方式：快速審查，未經獨立驗證', coverage: '覆蓋不完整', models: '模型：', separator: '；', end: '。' },
  cn: { title: 'AI 审查来源', disclaimer: '本报告由 AI 产生，不代表人工批准。使用个人账号发布，不表示该用户已验证这些结论。', method: '各模型独立初审，再由验证模型回查源码、交叉验证、合并重复问题并排除缺乏证据的结论；不是多数决。', roles: ['来源检查', '功能初审', '风险初审', '验证', '重复检查', '快速审查'], stage: '阶段', model: '实际选用的 provider/model ID', sessions: '会话数', count: '初审问题数', dispositions: '问题处置', finding: '问题', result: '结果', merged: '合并至', extra: '验证新增问题', note: '此处记录 OpenCode 实际选用的模型 ID，不是对供应商后端模型身份的独立验证；不包含主对话及宿主的辅助模型。', comment: 'AI 审查，非人工审查或批准。模型：',
    quickMethod: '快速审查：每个分片由一位审查者同时检查功能与风险，并依自己读到的源码回查发现；没有独立验证，也没有合并重复问题。runtime 只检查发现的形式与来源。',
    lead: 'AI 审查，非人工审查或批准。', quick: '审查方式：快速审查，未经独立验证', coverage: '覆盖不完整', models: '模型：', separator: '；', end: '。' },
};
// Fixed coverage reasons for the summary disclosure; reviewer text never goes there.
const coverageWords = {
  en: { files: n => `${n} changed file(s) not reviewed`, atLeast: n => `at least ${n} changed file(s) not reviewed`, 'partial-file-list': 'Azure DevOps returned a partial change list', 'reviewer-gaps': 'the reviewer reported unfinished checks', 'shard-failed': 'a review session failed', join: '; ' },
  tw: { files: n => `${n} 個變更檔未審查`, atLeast: n => `至少 ${n} 個變更檔未審查`, 'partial-file-list': 'Azure DevOps 只回傳部分變更清單', 'reviewer-gaps': '審查者回報有未完成的檢查', 'shard-failed': '有審查工作階段失敗', join: '、' },
  cn: { files: n => `${n} 个变更文件未审查`, atLeast: n => `至少 ${n} 个变更文件未审查`, 'partial-file-list': 'Azure DevOps 只返回部分变更清单', 'reviewer-gaps': '审查者报告有未完成的检查', 'shard-failed': '有审查会话失败', join: '、' },
};
function words(language) {
  if (!/^zh(?:-|$)/i.test(language)) return vocabulary.en;
  return new Intl.Locale(language).maximize().script === 'Hant' ? vocabulary.tw : vocabulary.cn;
}
const pick = (language, en, tw, cn) => words(language) === vocabulary.tw ? tw : words(language) === vocabulary.cn ? cn : en;

/**
 * The PR comments section of a COMPLETE review. `after` ({ mode, source }) is
 * the comment step that follows this review automatically (afterReview or the
 * command's flag); the manual commands stay valid either way.
 */
export function renderCommentActions(id, language, after) {
  const source = after ? `\`${after.source}\`` : '';
  const automatic = after?.mode === 'preview' ? pick(language,
    `**Automatic preview** (${source}): AZPR now plans a comment preview as a separate command with its own receipt; nothing is posted. A review without findings to comment on gets no preview.`,
    `**自動預覽**（${source}）：AZPR 接著以另一道指令規劃留言預覽，並另送收據；不會發布。沒有可留言的發現時不會預覽。`,
    `**自动预览**（${source}）：AZPR 接着以另一条命令规划留言预览，并另送回执；不会发布。没有可留言的发现时不会预览。`)
    : after?.mode === 'publish' ? pick(language,
      `**Automatic publication** (${source}): AZPR now plans the comments and posts them as the PAT owner, as a separate command with its own receipt. A comment with an @mention, an image, embedded content, hidden text or a script link waits in the preview for a person while the others are posted, and nothing new is posted when every finding is already discussed on the PR. A review without findings to comment on gets no comments.`,
      `**自動發布**（${source}）：AZPR 接著以另一道指令規劃留言，並以 PAT 擁有者的身分發布，另送收據。含 @提及、圖片、嵌入內容、隱藏文字或指令碼連結的留言會留在預覽等人確認，其他照常發布；每個發現在 PR 上都已有討論時，不會再發布。沒有可留言的發現時不會留言。`,
      `**自动发布**（${source}）：AZPR 接着以另一条命令规划留言，并以 PAT 拥有者的身份发布，另送回执。含 @提及、图片、嵌入内容、隐藏文字或脚本链接的留言会留在预览等人确认，其他照常发布；每个发现在 PR 上都已有讨论时，不会再发布。没有可留言的发现时不会留言。`)
      : after ? pick(language, `Automatic comments are off for this review (${source}).`, `這份審查不自動留言（${source}）。`, `这份审查不自动留言（${source}）。`) : '';
  const [heading, publish, preview, omit, retention] = pick(language,
    ['PR comments', 'Prepare and publish comments', 'Preview comments only', 'You can omit the ID: `/pr-comment --publish` selects the latest completed review in the original conversation, or this review in its report session.', 'Reviews and previews are saved privately (latest 20) and survive an OpenCode restart. Publishing skips comments that already exist on the PR, so it is safe to run again.'],
    ['PR 留言', '直接準備並發布留言', '只看留言預覽', '也可省略 ID：`/pr-comment --publish` 會選原對話最近完成的 review；在本報告對話中會選本份報告。', 'Review 與預覽私下保存（最近 20 份），重啟 OpenCode 後仍可使用。發布時會跳過 PR 上已存在的留言，可以安全地重跑。'],
    ['PR 留言', '直接准备并发布留言', '只看留言预览', '也可省略 ID：`/pr-comment --publish` 会选原对话最近完成的 review；在本报告对话中会选本份报告。', 'Review 与预览私下保存（最近 20 份），重启 OpenCode 后仍可使用。发布时会跳过 PR 上已存在的留言，可以安全地重跑。']);
  return `## ${heading}\n\n${automatic ? `${automatic}\n\n` : ''}${publish}:\n\n\`\`\`text\n/pr-comment ${id} --publish\n\`\`\`\n\n${preview}: \`/pr-comment ${id}\`\n\n${omit}\n\n${retention}`;
}

/** Models per role, aggregated over shards and retries. */
export function reviewProvenance(run) {
  const rows = new Map();
  for (const stage of run.stages) {
    const order = ROLES[stage.role]?.order;
    if (order === undefined || stage.status === 'FAILED') continue;
    const key = `${stage.role}\n${stage.model}`;
    const row = rows.get(key) ?? { role: stage.role, model: stage.model, sessions: 0, findings: 0 };
    row.sessions++;
    row.findings += stage.result?.findings?.length ?? 0;
    rows.set(key, row);
  }
  return { mode: run.profile, stages: [...rows.values()].sort((a, b) => ROLES[a.role].order - ROLES[b.role].order) };
}

export function provenanceReport(provenance, final, language) {
  const w = words(language);
  const quick = provenance.mode === 'quick';
  const rows = provenance.stages.map(s => `| ${w.roles[ROLES[s.role]?.order]} | \`${s.model}\` | ${s.sessions} | ${ROLES[s.role]?.format === 'initial' ? s.findings : '—'} |`).join('\n');
  const dispositions = final.dispositions.map(d => `| ${d.id} | ${d.status} | ${d.mergedInto ?? '—'} |`).join('\n');
  return `## ${w.title} (${provenance.mode})\n\n${w.disclaimer}\n\n${quick ? w.quickMethod : w.method}\n\n| ${w.stage} | ${w.model} | ${w.sessions} | ${w.count} |\n| --- | --- | --- | --- |\n${rows}\n\n${w.note}\n\n### ${w.dispositions}\n\n| ${w.finding} | ${w.result} | ${w.merged} |\n| --- | --- | --- |\n${dispositions || '| — | — | — |'}${quick ? '' : `\n\n${w.extra}: ${(final.newFindings ?? []).map(f => f.id).join(', ') || '0'}`}`;
}

/** Fixed-phrase description of incomplete coverage; '' when coverage is complete or unknown. */
export function coverageNote(coverage, language) {
  if (!coverage || coverage.complete) return '';
  const c = coverageWords[pick(language, 'en', 'tw', 'cn')];
  const parts = [];
  // The number is certain only for a complete change list; otherwise it is a lower bound.
  if (coverage.unreviewedFiles > 0) parts.push(coverage.filesComplete ? c.files(coverage.unreviewedFiles) : c.atLeast(coverage.unreviewedFiles));
  for (const reason of coverage.reasons ?? []) if (reason !== 'shard-failed' || !(coverage.unreviewedFiles > 0)) parts.push(c[reason] ?? reason);
  return parts.join(c.join);
}

/**
 * The disclosure line of AZPR's comments. Verified reviews keep the original
 * line; a quick review names its method and, for the summary, incomplete
 * coverage. The models are those of the review stages and comment planning.
 */
export function commentAttribution(provenance, language, commentModel, { verification = 'independent', coverage } = {}) {
  if (!provenance) return '';
  const w = words(language);
  const models = [...new Set([...provenance.stages.map(s => s.model), commentModel])].map(model => `\`${model}\``).join(', ');
  if (verification !== 'none') return `${w.comment} ${models}`;
  const gap = coverageNote(coverage, language);
  const brackets = pick(language, ['(', ')'], ['（', '）'], ['（', '）']);
  return `${w.lead}${w.quick}${gap ? `${w.separator}${w.coverage}${pick(language, ' ', '', '')}${brackets[0]}${gap}${brackets[1]}` : ''}${w.end}${w.models} ${models}`;
}

// Presentation uses validated fields; it neither translates nor invents claims.
const reportVocabulary = {
  en: { scope: 'Scope and versions', overview: 'Checks and limitations', findings: 'Confirmed findings', decisions: 'Finding decisions', evidence: 'Evidence and impact', counter: 'Counterevidence', suggestion: 'Correction and verification', location: 'Location', moved: 'initial location', none: 'None reported.', draft: 'Incomplete review draft', warning: 'AI-generated, unconfirmed initial observations. Verification did not complete. This is not an approved review or input for PR comments.', failure: 'Failure', candidates: 'Unconfirmed initial observations', gaps: 'Coverage gaps', coverage: 'Coverage', partial: 'Verification did not produce a structured result. These claims are provisional and cannot be used for PR comments.', stale: 'The PR source changed during the review. Run a new review before commenting.' },
  tw: { scope: '範圍與版本', overview: '查證與限制', findings: '已確認問題', decisions: '問題裁決理由', evidence: '證據與影響', counter: '反證檢查', suggestion: '修正與驗證建議', location: '位置', moved: '初審位置', none: '未列出。', draft: '未完成審查草稿', warning: 'AI 產生的初審觀察，尚未完成驗證，不能視為已確認結論或用於 PR 留言。', failure: '失敗原因', candidates: '尚未確認的初審觀察', gaps: '覆蓋缺口', coverage: '覆蓋範圍', partial: '驗證沒有產生結構化結果，下列結論僅供檢視，不能用於 PR 留言。', stale: 'PR 原始碼在審查期間已變更，請重新審查後再留言。' },
  cn: { scope: '范围与版本', overview: '查证与限制', findings: '已确认问题', decisions: '问题裁决理由', evidence: '证据与影响', counter: '反证检查', suggestion: '修正与验证建议', location: '位置', moved: '初审位置', none: '未列出。', draft: '未完成审查草稿', warning: 'AI 产生的初审观察，尚未完成验证，不能视为已确认结论或用于 PR 留言。', failure: '失败原因', candidates: '尚未确认的初审观察', gaps: '覆盖缺口', coverage: '覆盖范围', partial: '验证没有产生结构化结果，下列结论仅供查看，不能用于 PR 留言。', stale: 'PR 源码在审查期间已变更，请重新审查后再留言。' },
};
const reportWords = language => reportVocabulary[pick(language, 'en', 'tw', 'cn')];

function displayLocation(value) {
  try {
    const p = JSON.parse(value);
    if (p && ['head', 'base'].includes(p.side) && typeof p.path === 'string' && p.path.startsWith('/') &&
        Number.isSafeInteger(p.lineStart) && p.lineStart > 0 && Number.isSafeInteger(p.lineEnd) && p.lineEnd >= p.lineStart) {
      return `${p.side}:${p.path}:${p.lineStart}${p.lineEnd === p.lineStart ? '' : '-' + p.lineEnd}`;
    }
  } catch { /* Ordinary string locations stay literal. */ }
  return value;
}

/** A compact index of existing claims, not another model-authored assessment. */
export function renderReviewSummary(findings, language, introduction = '', { verification = 'independent', groups = [] } = {}) {
  const w = reportWords(language);
  const severityIcons = { high: '🔴', medium: '🟡', low: '🔵' };
  const cell = value => String(value ?? '—').replace(/[\r\n]+/g, ' ').replace(/[&<>|`*_[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
  // Findings that one comment combined share a row (the first one's text), and the counts follow the rows.
  const groupOf = new Map(groups.flatMap(ids => ids.map(id => [id, ids])));
  const entries = [], emitted = new Set();
  for (const finding of findings) {
    const ids = groupOf.get(finding.id);
    if (ids && emitted.has(ids)) continue;
    if (ids) emitted.add(ids);
    entries.push({ ...(ids ? findings.find(other => other.id === ids[0]) ?? finding : finding), ids: ids ?? [finding.id] });
  }
  findings = entries;
  const counts = ['high', 'medium', 'low'].map(level => `${level}: ${findings.filter(f => f.severity === level).length}`).join(' · ');
  // A quick review confirms nothing, so it does not speak of confirmed defects.
  const empty = verification === 'none'
    ? pick(language, 'No defects reported; this does not establish that the code is bug-free.', '未回報缺陷；這不保證程式沒有問題。', '未报告缺陷；这不保证程序没有问题。')
    : pick(language, 'No confirmed defects found; this does not establish that the code is bug-free.', '未發現可確認缺陷；這不保證程式沒有問題。', '未发现可确认缺陷；这不保证程序没有问题。');
  const rows = [...findings].sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity)).map(f => `| ${severityIcons[f.severity] ?? ''} ${cell(f.severity)} | ${f.ids.map(cell).join(', ')} — ${cell(f.summary)} | ${cell(displayLocation(f.location))} |`).join('\n');
  return `## PR Review Summary\n\n${introduction ? `${introduction}\n\n` : ''}${counts}\n\n${rows ? `| Severity | Summary | ${w.location} |\n| --- | --- | --- |\n${rows}` : empty}`;
}

const findingFields = ['id', 'summary', 'severity', 'location', 'movedFrom', 'evidence', 'counterevidence', 'suggestion', 'origin', 'shardId', 'originalId'];
function extraOutput(value, known) {
  const entries = Object.entries(value ?? {}).filter(([key, content]) => !known.includes(key) && content !== '' && content !== null && content !== undefined);
  if (!entries.length) return '';
  const text = JSON.stringify(Object.fromEntries(entries), null, 2);
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `\n\n${fence}json\n${text}\n${fence}`;
}
function renderFinding(finding = {}, w) {
  finding ??= {};
  return `### ${finding.id || '—'} — ${finding.summary || w.none} (${finding.severity || '—'})\n\n**${w.location}:** ${displayLocation(finding.location) || '—'}${finding.movedFrom ? ` (${w.moved}: ${displayLocation(finding.movedFrom)})` : ''}\n\n**${w.evidence}**\n\n${finding.evidence || w.none}\n\n**${w.counter}**\n\n${finding.counterevidence || w.none}\n\n**${w.suggestion}**\n\n${finding.suggestion || w.none}${extraOutput(finding, findingFields)}`;
}

function renderSnapshot(final) {
  const s = final.snapshot;
  if (!s) return 'Snapshot not established.';
  const fresh = final.freshness ?? {};
  const files = s.files.length > 60 ? `${s.files.slice(0, 60).join(', ')}, … (${s.files.length} total)` : s.files.join(', ');
  return `${s.organization}/${s.project}/${s.repository} · PR #${s.prId} · ${s.title ? `"${s.title}" · ` : ''}${s.status}\n\n` +
    `- head (source): \`${s.head}\`\n- base (target): \`${s.base}\`\n` +
    `- final recheck: ${fresh.error ? `failed (${fresh.error})` : `head \`${fresh.head ?? '—'}\`, base \`${fresh.base ?? '—'}\`, status ${fresh.status ?? '—'}`}\n` +
    `- changed files (${s.filesComplete ? 'complete list' : 'partial list from Azure'}): ${files || '—'}` +
    (final.discoveredFiles?.length ? `\n- paths reported by reviewers outside Azure's list: ${final.discoveredFiles.join(', ')}` : '');
}

function renderCoverage(final, w) {
  if (!final.coverage) return '';
  const rows = Object.entries(final.coverage).map(([role, c]) =>
    `- ${role}: ${c.covered}/${c.assigned} assigned file(s) reported as reviewed${c.failedFiles.length ? `; ${c.failedFiles.length} file(s) in failed shards` : ''}${c.gaps.length ? `; gaps: ${c.gaps.slice(0, 10).join(' | ')}${c.gaps.length > 10 ? ' …' : ''}` : ''}`).join('\n');
  return `\n\n**${w.coverage}**\n\n${rows}`;
}

const quickReportVocabulary = {
  en: { banner: 'Quick review: one reviewer per shard; the findings are not independently verified.', coverage: 'Coverage', complete: 'complete', incomplete: 'incomplete',
    findings: 'Reported findings (quick review, not independently verified)', partial: 'No quick review session produced a usable result. These claims are provisional and cannot be used for PR comments.',
    reported: 'passed the runtime\'s format and source checks; not independently verified.', needsInfo: 'Findings that need more information (not eligible for comments)' },
  tw: { banner: '快速審查：每個分片由一位審查者審查，發現未經獨立驗證。', coverage: '覆蓋', complete: '完整', incomplete: '不完整',
    findings: '回報的問題（快速審查，未經獨立驗證）', partial: '沒有任何快速審查工作階段產生可用結果，下列結論僅供檢視，不能用於 PR 留言。',
    reported: '通過 runtime 的形式與來源檢查，未經獨立驗證。', needsInfo: '需要更多資訊的發現（不能用於留言）' },
  cn: { banner: '快速审查：每个分片由一位审查者审查，发现未经独立验证。', coverage: '覆盖', complete: '完整', incomplete: '不完整',
    findings: '报告的问题（快速审查，未经独立验证）', partial: '没有任何快速审查会话产生可用结果，下列结论仅供查看，不能用于 PR 留言。',
    reported: '通过 runtime 的形式与来源检查，未经独立验证。', needsInfo: '需要更多信息的发现（不能用于留言）' },
};

/** Status, coverage and verification of a quick review, stated separately at the top. */
function renderQuickReport(final, language) {
  const w = reportWords(language), q = quickReportVocabulary[pick(language, 'en', 'tw', 'cn')];
  const reported = final.dispositions.filter(d => d.status === 'REPORTED').map(d => ({ ...d.finding, id: d.id }));
  const pendingInfo = final.dispositions.filter(d => d.status === 'NEEDS_INFO' && d.partialFinding).map(d => ({ ...d.partialFinding, id: d.id }));
  const gap = coverageNote(final.coverageSummary, language);
  const coverageLine = `**${q.coverage}:** ${final.coverageSummary?.complete ? q.complete : `${q.incomplete}${gap ? ` (${gap})` : ''}`}`;
  const banner = `${final.status === 'STALE' ? `**STALE: ${w.stale}**\n\n` : final.status !== 'COMPLETE' ? `**${final.status}: ${q.partial}**\n\n` : ''}**${q.banner}**\n\n${coverageLine}\n\n`;
  const limitations = (final.reviewWarnings ?? []).map(message => `- ${message}`).join('\n');
  const reportedIds = reported.map(f => f.id);
  const decisions = [...(reportedIds.length ? [`- **${reportedIds.join(', ')} — REPORTED:** ${q.reported}`] : []),
    ...final.dispositions.filter(d => d.status !== 'REPORTED').map(d => `- **${d.id || '—'} — ${d.status}${d.mergedInto ? ' → ' + d.mergedInto : ''}:** ${d.reason || w.none}`)].join('\n');
  const reference = [...(final.initialObservations ?? []).map(f => renderFinding(f, w)), ...(final.unstructuredInitials ?? [])].join('\n\n');
  const referenceTitle = pick(language, 'Initial observations (reference only, not final conclusions)', '初審觀察（參考資料，非最終結論）', '初审观察（参考资料，非最终结论）');
  return `${banner}${final.status === 'COMPLETE' ? renderReviewSummary(reported, language, '', { verification: 'none' }) + '\n\n' : ''}## ${w.overview}\n\n${final.report || w.none}${limitations ? '\n\n' + limitations : ''}${renderCoverage(final, w)}\n\n## ${q.findings}\n\n${reported.map(f => renderFinding(f, w)).join('\n\n') || w.none}${pendingInfo.length && final.status === 'COMPLETE' ? `\n\n## ${q.needsInfo}\n\n${pendingInfo.map(f => renderFinding(f, w)).join('\n\n')}` : ''}\n\n## ${w.scope}\n\n${renderSnapshot(final)}\n\n## ${w.decisions}\n\n${decisions || w.none}${reference ? '\n\n## ' + referenceTitle + '\n\n' + reference : ''}`;
}

export function renderFinalReport(final, language) {
  if (final.verification === 'none') return renderQuickReport(final, language);
  const w = reportWords(language);
  const findingTitle = final.status === 'COMPLETE' ? w.findings : pick(language, 'Model-reported findings (verification limited)', '模型提出的問題（驗證有限）', '模型提出的问题（验证有限）');
  const findings = [...final.dispositions.filter(d => d.status === 'CONFIRMED').map(d => d.verifiedFinding), ...(final.newFindings ?? [])];
  const decisions = final.dispositions.map(d => `- **${d.id || '—'} — ${d.status}${d.mergedInto ? ' → ' + d.mergedInto : ''}:** ${d.reason || w.none}`).join('\n');
  const limitations = (final.reviewWarnings ?? []).map(message => `- ${message}`).join('\n');
  const unreviewedIds = new Set(final.dispositions.filter(d => d.status === 'UNREVIEWED').map(d => d.id));
  const pending = [...(final.initialObservations?.length ? final.initialObservations : (final.findings ?? []).filter(f => unreviewedIds.has(f.id))).map(f => renderFinding(f, w)), ...(final.unstructuredInitials ?? [])].join('\n\n');
  const referenceTitle = pick(language, 'Initial observations (reference only, not final conclusions)', '初審觀察（參考資料，非最終結論）', '初审观察（参考资料，非最终结论）');
  const banner = final.status === 'STALE' ? `**STALE: ${w.stale}**\n\n` : final.status !== 'COMPLETE' ? `**${final.status}: ${w.partial}**\n\n` : '';
  return `${banner}${final.status === 'COMPLETE' ? renderReviewSummary(findings, language) + '\n\n' : ''}## ${w.overview}\n\n${final.report || w.none}${limitations ? '\n\n' + limitations : ''}${renderCoverage(final, w)}\n\n## ${findingTitle}\n\n${findings.map(f => renderFinding(f, w)).join('\n\n') || w.none}\n\n## ${w.scope}\n\n${renderSnapshot(final)}\n\n## ${w.decisions}\n\n${decisions || w.none}${pending ? '\n\n## ' + referenceTitle + '\n\n' + pending : ''}`;
}

/** Completed initial responses are retained when verification never finished. */
export function renderIncompleteDraft(stages, failure, language, { quick = false } = {}) {
  const initials = stages.filter(s => ROLES[s.role]?.format === 'initial' && s.result);
  if (!initials.length) return '';
  const w = quick ? { ...reportWords(language), warning: pick(language, 'AI-generated, unconfirmed quick review observations. The quick review did not complete. This is not an approved review or input for PR comments.', 'AI 產生的快速審查觀察，審查沒有完成，不能視為已確認結論或用於 PR 留言。', 'AI 产生的快速审查观察，审查没有完成，不能视为已确认结论或用于 PR 留言。') } : reportWords(language);
  const ledger = stages.map(s => `- ${s.role}${s.label ? ` (${s.label})` : ''}: ${s.status}; session=${s.sessionID}; model=${s.model}`).join('\n');
  const observations = initials.map(s => `### ${s.role}${s.label ? ` — ${s.label}` : ''}\n\n${s.result.report || w.none}\n\n**${w.gaps}:** ${s.result.coverage?.gaps?.join('; ') || w.none}\n\n${s.result.findings.map(f => renderFinding(f, w)).join('\n\n') || w.none}`).join('\n\n');
  return `## ${w.draft}\n\n**${w.warning}**\n\n**${w.failure}:** ${failure}\n\n${ledger}\n\n## ${w.candidates}\n\n${observations}`;
}

/** Deterministic /pr-check report; no model was involved. */
export function renderCheckReport(snapshot, checks, readiness) {
  const rows = checks.map(c => `| ${c.name} | ${!c.ok ? 'FAILED' : c.warning ? 'WARNING' : 'ok'} | ${String(c.detail ?? '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').slice(0, 300)} |`).join('\n');
  const models = readiness?.checkedModelSlots?.length ? `\n\nModels checked: ${readiness.checkedModelSlots.join(', ')} (profile ${readiness.profile}).${readiness.deep ? ` Also checked for /pr-deep: ${readiness.deep.checkedModelSlots.join(', ')} (profile deep).` : ''}${readiness.quick ? ` Also checked for /pr-quick: ${readiness.quick.checkedModelSlots.join(', ')} (profile quick).` : ''}` : '';
  return `## Source readiness\n\n${snapshot ? `${snapshot.organization}/${snapshot.project}/${snapshot.repository} · PR #${snapshot.prId} · ${snapshot.status}${snapshot.title ? ` · "${snapshot.title}"` : ''}\n\n- head: \`${snapshot.head}\`\n- base: \`${snapshot.base}\`${snapshot.baseKind === 'target' ? ' (target branch tip; no merge base reported)' : ' (merge base)'}\n- changed files: ${snapshot.files.length} (${snapshot.filesComplete ? 'complete list' : 'partial list; reviewers will look for the rest'})\n\n` : ''}| Check | Result | Detail |\n| --- | --- | --- |\n${rows}${models}\n\nREADY means AZPR can read this PR through the Azure DevOps REST API with the configured PAT; it is not a review or an approval.`;
}

/** Publication ledger rows for receipts. */
export function renderPublication(review, result) {
  const rows = [...(review.publication ?? new Map()).values()].map(entry =>
    `- ${entry.kind === 'summary' ? 'PR summary' : `${(entry.findingIds ?? [entry.findingId]).join(', ')} (${entry.path}:${entry.startLine})`}: ${entry.state}${entry.threadId ? `; thread=${entry.threadId}` : ''}${entry.error ? `; error=${entry.error}` : ''}${entry.contentMismatch ? '; returned text differs' : ''}${entry.earlierText ? '; the PR keeps its earlier text' : ''}`).join('\n');
  const counts = result?.counts ? Object.entries(result.counts).map(([state, count]) => `${state}=${count}`).join(', ') : '';
  return `Publication${counts ? ` (${counts})` : ''}${result?.readBack && result.readBack !== 'complete' ? `; read-back ${result.readBack}` : ''}:\n${rows || '- Nothing recorded.'}\n\nPOSTED/VERIFIED entries were created by AZPR and VERIFIED ones were read back from Azure DevOps. ALREADY_PRESENT entries existed before this run. DELETED entries were created by AZPR and later deleted on the PR; AZPR does not post them again. FAILED entries are safe to retry with /pr-comment ${review.id} --publish; existing comments are skipped by their markers. UNVERIFIED entries were created but not found when read back; a re-run checks them again and never posts them twice. UNCERTAIN entries may still appear from an earlier attempt and are retried only after their marker check settles.`;
}

function renderStageReceipt(stage) {
  const fields = [`${stage.role}${stage.label ? ` [${stage.label}]` : ''}: ${stage.status}`, `session=${stage.sessionID}`, `model=${stage.model}`];
  const counters = [
    ['attempt', stage.attempt > 1 ? stage.attempt : 0],
    ['repair-turns', stage.repairs?.length],
    ['stream-continuations', stage.hostContinuations],
    ['continuation-restarts', stage.continuationRestarts],
    ['blocked-native-tools', stage.blockedNativeToolCalls],
    ['observed-tool-errors', stage.toolFailures],
    ['tool-timeouts', stage.toolTimeouts],
    ['truncated-tool-results', stage.toolObservations?.truncated],
    ['review-limitations', stage.reviewWarnings?.length],
  ];
  for (const [label, count] of counters) if (count) fields.push(`${label}=${count}`);
  if (stage.followUp) fields.push(`follow-up=${stage.followUp.outcome}${stage.followUp.failureClass ? `:${stage.followUp.failureClass}` : ''}`);
  if (stage.failureClass) fields.push(`failure=${stage.failureClass}`);
  if (stage.error) fields.push(`error=${stage.error}`);
  return '- ' + fields.join('; ');
}

export function renderReceipt(run, report, status, error, settings) {
  const rows = run.stages.map(renderStageReceipt).join('\n');
  // A quick review states coverage and verification next to its status.
  const quick = run.mode === 'quick' ? `${run.quickSummary ? `; coverage ${run.quickSummary.coverage?.complete ? 'complete' : 'incomplete'}` : ''}; verification none (quick review)` : '';
  let body = `[AZPR ${run.id}] ${status}${quick}\n${error ? `Reason (${run.phase ?? 'workflow'}): ${error}\n` : ''}${rows}${rows ? '\n' : ''}`;
  if (run.stages.some(s => s.repairs?.length)) body += '\nRepair notice: some answers did not meet the output contract and the same session was asked to correct them. Remaining problems were downgraded per item (UNREVIEWED, NEEDS_INFO or skipped comments) instead of discarding the review.\n';
  if (run.stages.some(s => s.attempt > 1)) body += '\nRetry notice: a stage failed for a transient reason and ran again in a new session.\n';
  if (run.stages.some(s => s.followUp)) body += '\nFollow-up notice: a session answered PARTIAL and named unfinished work, so the same session was asked once to continue (follow-up=completed, still-partial, unusable or failed). A follow-up that failed or gave no usable answer kept the answer it followed.\n';
  if (run.draft) body += run.mode === 'quick'
    ? '\nIncomplete draft notice: the quick review did not complete; its observations are unconfirmed and not input for PR comments.\n'
    : '\nIncomplete draft notice: initial observations are unconfirmed because verification did not complete; they are not input for PR comments.\n';
  body += renderDiagnosticNotices(run);
  if (run.compatibility && !run.compatibility.tested && run.compatibility.version !== 'unknown') body += `\nHost notice: OpenCode ${run.compatibility.version} differs from the tested ${TESTED_HOST_VERSION}; capabilities were detected at runtime.\n`;
  body += run.mode === 'check'
    ? '\nStatus: READY means AZPR can read the PR through the Azure DevOps REST API; it does not review or approve the PR.\n'
    : run.mode === 'comment'
      ? ''
      : run.mode === 'quick'
        ? '\nStatus: COMPLETE means at least one quick review session produced a usable result and no source-commit change was detected. Quick findings are not independently verified: the runtime checked only their form and source, and findings that failed those checks are NEEDS_INFO. Coverage says whether every changed file was reviewed. STALE means the PR source commit changed during the review. PARTIAL means no session produced a usable result. None of these approves the PR.\n'
        : '\nStatus: COMPLETE means verification produced structured decisions and no source-commit change was detected; findings without a usable decision are listed as UNREVIEWED. STALE means the PR source commit changed during the review. PARTIAL keeps unverified results. None of these approves the PR.\n';
  if (run.mode === 'quick' && status === 'COMPLETE' && run.quickSummary && (run.quickSummary.high > 0 || !run.quickSummary.coverage?.complete)) {
    const hint = [run.quickSummary.high > 0 ? `${run.quickSummary.high} high-severity finding(s)` : '', !run.quickSummary.coverage?.complete ? 'incomplete coverage' : ''].filter(Boolean).join(' and ');
    // Automatic publication follows the user's explicit choice; the hint stays advisory.
    body += run.afterReview?.mode === 'publish'
      ? `\nVerification hint: ${hint}. These findings are not independently verified; the automatic publication posts them with that disclosure (and the summary with the coverage). For an independent check first, set afterReview.quick to preview or use /pr-review.\n`
      : `\nVerification hint: ${hint}. Before publishing, consider /pr-review for an independently verified review.\n`;
  }
  if (run.userContext) body += '\nSupplementary context applies to this command only.\n';
  if (report) {
    const last = run.reportStage;
    if (last?.reportQueued) body += `\nReport delivery: report queued to session=${last.sessionID}.\n`;
    else if (run.stages.length) body += '\nReport delivery: the report could not be queued to a review session; it is enclosed below.\n';
    if (settings.returnReport === 'full' || run.draft || ['PARTIAL', 'INCOMPLETE', 'STALE'].includes(status) || !last?.reportQueued) {
      body += `\nReport data:\n<azpr_report_data>\n${report.replaceAll('</azpr_report_data>', '&lt;/azpr_report_data&gt;')}\n</azpr_report_data>\n`;
    }
  }
  if (['review', 'deep', 'quick'].includes(run.mode) && status === 'COMPLETE' && settings.returnReport !== 'full') body += '\n' + renderCommentActions(run.id, settings.outputLanguage, run.afterReview) + '\n';
  body += `\nThis command has ended and all reviewer grants have been revoked. outputLanguage=${settings.outputLanguage}.`;
  return body;
}

export function renderDiagnosticNotices(run) {
  const notices = [];
  const sum = key => run.stages.reduce((n, s) => n + (s[key] ?? 0), 0);
  const blocked = sum('blockedNativeToolCalls'), failures = sum('toolFailures'), timeouts = sum('toolTimeouts');
  if (blocked) notices.push(`\nTool notice: ${blocked} attempt(s) to use a tool this role may not use were blocked before execution.\n`);
  if (failures) notices.push(`\nTool error notice: ${failures} tool call(s) failed. A completed review does not erase these; inspect the original tool results.\n`);
  if (timeouts) notices.push(`\nTool timeout notice: ${timeouts} Azure DevOps read(s) exceeded the per-call timeout after retries and were abandoned.\n`);
  const idle = run.stages.filter(stage => stage.failureClass === 'idle');
  if (idle.length) notices.push(`\nInactivity notice: the stage inactivity watchdog stopped ${idle.length} stage(s) (failure=idle) after ${idle[0].idleStop?.idleSeconds ?? 'workflow.stageIdleSeconds'} s without activity: ${idle.map(stage => `${stage.role}${stage.label ? ` [${stage.label}]` : ''} after ${stage.idleStop?.lastActivity ?? 'an unknown activity'}`).join('; ')}. The model stream, a tool or OpenCode stopped responding; a stopped stage runs again in a new session while workflow.stageRetries allows.\n`);
  if (run.abortUnconfirmed) notices.push('\nCancellation warning: OpenCode did not confirm session settlement. Requests already sent may still be running or billed.\n');
  if (run.debug?.directory) notices.push(`\nPrivate debug directory: ${run.debug.directory}\n`);
  for (const warning of run.debug?.warnings ?? []) notices.push(`Debug warning: ${warning}\n`);
  return notices.join('');
}
