import { ROLES, MAX_ARCHIVE_MEGABYTES, isModelReference } from './config.mjs';
// Deterministic attribution from invoked reviewer stages, not model-authored claims.
// `comment` is the disclosure line of comments on a verified review saved by 0.4.x and `quick` the method named
// for a quick review of 0.4.x: posted comments carry them, so they stay as they were. `reviewers` names the
// method of every review of this pipeline.
const vocabulary = {
  en: { title: 'AI review provenance', disclaimer: 'AI-generated review, not human approval. Posting through a user account does not imply that person verified these conclusions.',
    roles: { review: 'Review', dedupe: 'Duplicate check', rating: 'Severity rating' }, pass: n => ` (pass ${n})`, stage: 'Stage', model: 'Selected provider/model ID', sessions: 'Sessions', count: 'Findings reported', dispositions: 'Finding dispositions', finding: 'Finding', result: 'Result', merged: 'Merged into',
    note: 'IDs identify the models selected in OpenCode, not independently verified provider backend identities. Host auxiliary models and the original chat model are not part of this ledger.', comment: 'AI-generated review; not human review or approval. Models:',
    method: { one: 'One reviewer session per shard reviewed the changed files.', several: n => `${n} independent reviewer passes reviewed the changed files, each shard in a session of its own.`,
      failed: (count, of) => `${count} of the ${of} reviewer sessions failed or gave no usable review; the coverage says what that left unreviewed.`,
      checks: 'Each reviewer checked its own findings against the source it read, and the runtime checked the form and source of every finding.',
      dedupe: 'A duplicate check merged repeated reports of one defect.', dedupeNone: 'A duplicate check compared what different sessions reported in one file and merged nothing.',
      dedupeFailed: count => `The duplicate check of ${count} file(s) failed, so their findings may repeat each other.`,
      rated: 'A rating session without tools set the severities from the finding texts alone.', kept: count => `${count} finding(s) got no usable rating and keep their reviewer's level.`, unrated: 'The severities are the reviewers\' own.',
      end: 'No separate verification ran, and nothing was decided by voting.' },
    lead: 'AI-generated review; not human review or approval. ', quick: 'Review method: quick review, not independently verified', reviewers: 'Review method: findings checked by their reviewer against the source, no separate verification',
    coverage: 'coverage incomplete', models: 'Models:', separator: '; ', end: '. ' },
  tw: { title: 'AI 審查來源', disclaimer: '本報告由 AI 產生，不代表人工核准。使用個人帳號發佈，不表示該使用者已驗證這些結論。',
    roles: { review: '審查', dedupe: '重複檢查', rating: '嚴重度評定' }, pass: n => `（第 ${n} 次）`, stage: '階段', model: '實際選用的 provider/model ID', sessions: '工作階段數', count: '回報問題數', dispositions: '問題處置', finding: '問題', result: '結果', merged: '合併至',
    note: '此處記錄 OpenCode 實際選用的模型 ID，不是對供應商後端模型身分的獨立驗證；不包含主對話及宿主的輔助模型。', comment: 'AI 審查，非人工審查或核准。模型：',
    method: { one: '每個分片的變更檔由一個審查工作階段審查。', several: n => `變更檔由 ${n} 次獨立的審查各審一遍，每個分片各用一個工作階段。`,
      failed: (count, of) => `${of} 個審查工作階段中有 ${count} 個失敗或沒有可用的審查結果；因此沒審到的部分見覆蓋範圍。`,
      checks: '審查者依自己讀到的原始碼查證自己的發現，runtime 檢查每則發現的形式與來源。',
      dedupe: '重複檢查合併了同一個缺陷的重複回報。', dedupeNone: '重複檢查比對了不同工作階段在同一個檔案回報的發現，沒有合併任何一則。',
      dedupeFailed: count => `${count} 個檔案的重複檢查失敗，這些檔案的發現可能彼此重複。`,
      rated: '嚴重度由一個沒有工具的評定工作階段只依發現的文字評定。', kept: count => `${count} 則發現沒有可用的評定，沿用審查者給的等級。`, unrated: '嚴重度是審查者自己給的。',
      end: '沒有另外的驗證，也不是多數決。' },
    lead: 'AI 審查，非人工審查或核准。', quick: '審查方式：快速審查，未經獨立驗證', reviewers: '審查方式：發現由審查者依原始碼自行查證，沒有另外的驗證',
    coverage: '覆蓋不完整', models: '模型：', separator: '；', end: '。' },
  cn: { title: 'AI 审查来源', disclaimer: '本报告由 AI 产生，不代表人工批准。使用个人账号发布，不表示该用户已验证这些结论。',
    roles: { review: '审查', dedupe: '重复检查', rating: '严重度评定' }, pass: n => `（第 ${n} 次）`, stage: '阶段', model: '实际选用的 provider/model ID', sessions: '会话数', count: '报告问题数', dispositions: '问题处置', finding: '问题', result: '结果', merged: '合并至',
    note: '此处记录 OpenCode 实际选用的模型 ID，不是对供应商后端模型身份的独立验证；不包含主对话及宿主的辅助模型。', comment: 'AI 审查，非人工审查或批准。模型：',
    method: { one: '每个分片的变更文件由一个审查会话审查。', several: n => `变更文件由 ${n} 次独立的审查各审一遍，每个分片各用一个会话。`,
      failed: (count, of) => `${of} 个审查会话中有 ${count} 个失败或没有可用的审查结果；因此没审到的部分见覆盖范围。`,
      checks: '审查者依自己读到的源码查证自己的发现，runtime 检查每则发现的形式与来源。',
      dedupe: '重复检查合并了同一个缺陷的重复报告。', dedupeNone: '重复检查比对了不同会话在同一个文件报告的发现，没有合并任何一则。',
      dedupeFailed: count => `${count} 个文件的重复检查失败，这些文件的发现可能彼此重复。`,
      rated: '严重度由一个没有工具的评定会话只依发现的文字评定。', kept: count => `${count} 则发现没有可用的评定，沿用审查者给的等级。`, unrated: '严重度是审查者自己给的。',
      end: '没有另外的验证，也不是多数决。' },
    lead: 'AI 审查，非人工审查或批准。', quick: '审查方式：快速审查，未经独立验证', reviewers: '审查方式：发现由审查者依源码自行查证，没有另外的验证',
    coverage: '覆盖不完整', models: '模型：', separator: '；', end: '。' },
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
  // The short commands come first: a person should not have to find or type the review ID. The
  // ID form stays, since a short command copied from an old receipt acts on the current review.
  const [heading, preview, adjust, publish, current, retention] = pick(language,
    ['PR comments', 'Preview the comments (a model runs; nothing is posted)', 'Leave findings out or change a level, with the IDs of the report, then read the new preview', 'Post the saved preview as the PAT owner',
      `These commands need no review ID: they act on this conversation's current review, which is this one until another review completes or is used here. To act on this review later, add its ID, for example \`/pr-comment ${id} --publish\`; \`/pr-comment --list\` shows the saved reviews and \`/pr-comment --help\` every option.`,
      'Reviews and previews are saved privately (latest 20) and survive an OpenCode restart. Publishing skips comments that already exist on the PR, so it is safe to run again.'],
    ['PR 留言', '預覽留言（會用到模型，不會發布）', '排除發現或改嚴重度（用報告裡的 ID），再看新的預覽', '以 PAT 擁有者的身分發布已保存的預覽',
      `這些指令不需要 review ID：會作用在這個對話目前的 review，也就是這一份，直到這裡有另一份 review 完成或被使用。之後要指定這一份時加上 ID，例如 \`/pr-comment ${id} --publish\`；\`/pr-comment --list\` 列出保存的 review，\`/pr-comment --help\` 列出所有選項。`,
      'Review 與預覽私下保存（最近 20 份），重啟 OpenCode 後仍可使用。發布時會跳過 PR 上已存在的留言，可以安全地重跑。'],
    ['PR 留言', '预览留言（会用到模型，不会发布）', '排除发现或改严重度（用报告里的 ID），再看新的预览', '以 PAT 拥有者的身份发布已保存的预览',
      `这些命令不需要 review ID：会作用在这个对话当前的 review，也就是这一份，直到这里有另一份 review 完成或被使用。之后要指定这一份时加上 ID，例如 \`/pr-comment ${id} --publish\`；\`/pr-comment --list\` 列出保存的 review，\`/pr-comment --help\` 列出所有选项。`,
      'Review 与预览私下保存（最近 20 份），重启 OpenCode 后仍可使用。发布时会跳过 PR 上已存在的留言，可以安全地重跑。']);
  return `## ${heading}\n\n${automatic ? `${automatic}\n\n` : ''}- ${preview}: \`/pr-comment\`\n- ${adjust}: \`/pr-comment --exclude F-1,F-2\`, \`/pr-comment --severity F-3=low\`\n- ${publish}: \`/pr-comment --publish\`\n\n${current}\n\n${retention}`;
}

/**
 * Which review a comment command acted on, so a command without an ID is
 * checked at a glance: the PR by its number and repository, which come from
 * the URL the person typed. The PR's title is text from the PR and stays
 * inside the report's data block, never in a notice line.
 */
export function describeReview(review) {
  const snapshot = review?.snapshot ?? {};
  return `review ${review.id} (/pr-${review.profile}) of PR #${snapshot.prId ?? '?'}${snapshot.project && snapshot.repository ? ` in ${snapshot.project}/${snapshot.repository}` : ''}`;
}

/**
 * The name of a conversation whose first AZPR command names a PR, where nobody named it yet: the PR by its
 * number and repository, which come from the URL the person typed. The PR's own title is text from the PR
 * and is not used.
 */
export function conversationTitle(target) {
  return `AZPR: PR #${target.pullRequestId} (${String(target.repository).slice(0, 60)})`;
}

/** Models per role, aggregated over shards and retries: the passes in their order, then the duplicate check and the rating. */
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
  const position = role => (typeof ROLES[role].slot === 'number' ? ROLES[role].slot : 0);
  return { mode: run.profile, stages: [...rows.values()].sort((a, b) => ROLES[a.role].order - ROLES[b.role].order || position(a.role) - position(b.role)) };
}

/**
 * How a review of this pipeline produced its findings, in fixed sentences, from the method its record states:
 * what ran, and what of it failed. A sentence says only what the record holds: sessions that failed, a
 * duplicate check that merged, merged nothing or failed, a rating that set every level, some or none.
 */
export function methodText(method, language) {
  const m = words(language).method, passes = method?.passes ?? [], check = method?.duplicateCheck ?? {}, rating = method?.rating ?? {};
  const sessions = passes.reduce((sum, pass) => sum + (pass.sessions ?? 0), 0), failed = passes.reduce((sum, pass) => sum + (pass.failed ?? 0), 0);
  const checked = (check.groups ?? 0) - (check.failed ?? 0);
  const rated = rating.state && rating.state !== 'off' && rating.rated > 0;
  return [passes.length > 1 ? m.several(passes.length) : m.one, ...(failed ? [m.failed(failed, sessions)] : []), m.checks,
    ...(check.merged ? [m.dedupe] : checked > 0 ? [m.dedupeNone] : []), ...(check.failed ? [m.dedupeFailed(check.failed)] : []),
    rated ? m.rated : m.unrated, ...(rated && rating.kept ? [m.kept(rating.kept)] : []), m.end].join(pick(language, ' ', '', ''));
}

export function provenanceReport(provenance, final, language) {
  const w = words(language);
  // A pass is named by its number wherever the review had several, also when only one of them left a row.
  const several = (final.method?.passes?.length ?? 0) > 1 || provenance.stages.filter(s => ROLES[s.role]?.kind === 'review').length > 1;
  const name = role => `${w.roles[ROLES[role]?.kind] ?? role}${several && ROLES[role]?.kind === 'review' ? w.pass(ROLES[role].slot + 1) : ''}`;
  const rows = provenance.stages.map(s => `| ${name(s.role)} | \`${s.model}\` | ${s.sessions} | ${ROLES[s.role]?.format === 'initial' ? s.findings : '—'} |`).join('\n');
  const dispositions = final.dispositions.map(d => `| ${d.id} | ${d.status} | ${d.mergedInto ?? '—'} |`).join('\n');
  return `## ${w.title} (${provenance.mode})\n\n${w.disclaimer}\n\n${methodText(final.method, language)}\n\n| ${w.stage} | ${w.model} | ${w.sessions} | ${w.count} |\n| --- | --- | --- | --- |\n${rows}\n\n${w.note}\n\n### ${w.dispositions}\n\n| ${w.finding} | ${w.result} | ${w.merged} |\n| --- | --- | --- |\n${dispositions || '| — | — | — |'}`;
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
 * The disclosure line of AZPR's comments, by the method of their review
 * (`reviewMethod` in comments.mjs). A review of this pipeline names its method
 * and, for the summary, incomplete coverage; so does a quick review saved by
 * 0.4.x, in its own words; a verified review saved by 0.4.x keeps the line it
 * always had. The models are those of the review stages and comment planning.
 */
export function commentAttribution(provenance, language, commentModel, { method = 'reviewers', coverage } = {}) {
  if (!provenance) return '';
  const w = words(language);
  const models = [...new Set([...provenance.stages.map(s => s.model), commentModel])].map(model => `\`${model}\``).join(', ');
  if (method === 'verified') return `${w.comment} ${models}`;
  const gap = coverageNote(coverage, language);
  const brackets = pick(language, ['(', ')'], ['（', '）'], ['（', '）']);
  return `${w.lead}${method === 'quick' ? w.quick : w.reviewers}${gap ? `${w.separator}${w.coverage}${pick(language, ' ', '', '')}${brackets[0]}${gap}${brackets[1]}` : ''}${w.end}${w.models} ${models}`;
}

// Presentation uses validated fields; it neither translates nor invents claims.
const reportVocabulary = {
  en: { scope: 'Scope and versions', overview: 'Checks and limitations', decisions: 'Finding decisions', evidence: 'Evidence and impact', counter: 'Counterevidence', suggestion: 'Correction and verification', location: 'Location', none: 'None reported.', draft: 'Incomplete review draft',
    warning: 'AI-generated, unconfirmed review observations. The review did not complete. This is not an approved review or input for PR comments.', failure: 'Failure', candidates: 'Unconfirmed review observations', gaps: 'Coverage gaps', coverage: 'Coverage', stale: 'The PR source changed during the review. Run a new review before commenting.',
    banner: 'Findings were checked by their reviewer against the source; no separate verification ran.', complete: 'complete', incomplete: 'incomplete',
    once: (x, y) => `${x}/${y} changed file(s) reviewed`, every: (z, y, n) => `${z}/${y} in all ${n} passes`, findings: 'Reported findings',
    partial: 'No review session produced a usable result. These claims are provisional and cannot be used for PR comments.',
    reported: 'passed the runtime\'s format and source checks; no separate verification ran.', needsInfo: 'Findings that need more information (not eligible for comments)', reviewer: 'reviewer' },
  tw: { scope: '範圍與版本', overview: '查證與限制', decisions: '問題裁決理由', evidence: '證據與影響', counter: '反證檢查', suggestion: '修正與驗證建議', location: '位置', none: '未列出。', draft: '未完成審查草稿',
    warning: 'AI 產生的審查觀察，審查沒有完成，不能視為已確認結論或用於 PR 留言。', failure: '失敗原因', candidates: '尚未確認的審查觀察', gaps: '覆蓋缺口', coverage: '覆蓋範圍', stale: 'PR 原始碼在審查期間已變更，請重新審查後再留言。',
    banner: '發現由審查者依原始碼自行查證；沒有另外的驗證。', complete: '完整', incomplete: '不完整',
    once: (x, y) => `已審查 ${x}/${y} 個變更檔`, every: (z, y, n) => `${z}/${y} 個在全部 ${n} 次審查都審過`, findings: '回報的問題',
    partial: '沒有任何審查工作階段產生可用結果，下列結論僅供檢視，不能用於 PR 留言。',
    reported: '通過 runtime 的形式與來源檢查；沒有另外的驗證。', needsInfo: '需要更多資訊的發現（不能用於留言）', reviewer: '審查者' },
  cn: { scope: '范围与版本', overview: '查证与限制', decisions: '问题裁决理由', evidence: '证据与影响', counter: '反证检查', suggestion: '修正与验证建议', location: '位置', none: '未列出。', draft: '未完成审查草稿',
    warning: 'AI 产生的审查观察，审查没有完成，不能视为已确认结论或用于 PR 留言。', failure: '失败原因', candidates: '尚未确认的审查观察', gaps: '覆盖缺口', coverage: '覆盖范围', stale: 'PR 源码在审查期间已变更，请重新审查后再留言。',
    banner: '发现由审查者依源码自行查证；没有另外的验证。', complete: '完整', incomplete: '不完整',
    once: (x, y) => `已审查 ${x}/${y} 个变更文件`, every: (z, y, n) => `${z}/${y} 个在全部 ${n} 次审查都审过`, findings: '报告的问题',
    partial: '没有任何审查会话产生可用结果，下列结论仅供查看，不能用于 PR 留言。',
    reported: '通过 runtime 的形式与来源检查；没有另外的验证。', needsInfo: '需要更多信息的发现（不能用于留言）', reviewer: '审查者' },
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

/** The heading of the list of other places in each language it is written in; what reads the list back knows it by these lines. */
export const OTHER_PLACES_HEADINGS = Object.freeze(['**📍 Also at** (the same defect; fix these places with it):', '**📍 其他位置**（同一個問題，請一併修正）：', '**📍 其他位置**（同一个问题，请一并修正）：']);

/**
 * The other places of one defect that a comment covers, as the runtime adds
 * them under the comment's own text: one row per finding with its file and
 * lines, from the findings' own locations, never from text a model wrote.
 * A plain list: nothing here is collapsed or linked.
 * @param {{findingId: string, place: string}[]} places
 */
export function renderOtherPlaces(places, language) {
  const [english, traditional, simplified] = OTHER_PLACES_HEADINGS;
  const heading = pick(language, english, traditional, simplified);
  return `${heading}\n${places.map(({ findingId, place }) => placeRow(place, findingId, pick(language, ROW_BRACKETS[0], ROW_BRACKETS[1], ROW_BRACKETS[1]))).join('\n')}`;
}

// How a row puts its finding ID in brackets: in English, and in Chinese.
const ROW_BRACKETS = [[' (', ')'], ['（', '）']];

/** One row of that list: the place in a code span that holds any text (longer than the longest run of backticks inside it), then the finding ID. */
function placeRow(place, findingId, [open, close]) {
  const text = String(place).replace(/[\r\n\t]+/g, ' ');
  const run = Math.max(0, ...(text.match(/`+/g) ?? []).map(match => match.length));
  const fence = '`'.repeat(run + 1);
  return `- ${run ? `${fence} ${text} ${fence}` : `\`${text}\``}${open}${String(findingId).replace(/[^A-Za-z0-9_-]/g, '')}${close}`;
}

/**
 * Whether a place can be written into that list and read back as it is: its
 * text holds no control character, no line separator and neither end of an
 * HTML comment, which the posted text would have to change.
 */
export const listablePlace = place => typeof place === 'string' && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|<!--|-->/.test(place);

/**
 * The places a posted comment of AZPR's lists, read back from its text for a
 * later plan (`alsoAt` in the digest of a thread): the rows under the heading
 * `renderOtherPlaces` writes, where they end the comment's own text as
 * `assemblePlan` writes it. A row counts only when writing its place and its
 * finding ID again gives the very line (so a row is one a finding's place
 * could have produced: a path, its lines in order, an ID). After the rows
 * comes a blank line, then the attribution if there is one (a rule, the line
 * `commentAttribution` writes for a comment, and a blank line), then the two
 * markers of such a comment (`linesMarker`, then its own) with a blank line
 * between them.
 * [] for any other text: one that merely holds such a heading or such rows,
 * one whose row has another form, one that was continued after the list.
 * What is read here tells a planner what a thread says it covers, as the
 * start of the thread's text does; nothing is posted or skipped because of it.
 */
export function listedPlaces(content) {
  // Line by line as written: only the line ends a service may return differ from what the runtime wrote.
  const lines = String(content ?? '').split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  const heading = lines.findLastIndex(line => OTHER_PLACES_HEADINGS.includes(line));
  if (heading < 0) return [];
  // The rows are written in the heading's language: English brackets under the English heading, Chinese ones otherwise.
  const brackets = ROW_BRACKETS[OTHER_PLACES_HEADINGS.indexOf(lines[heading]) ? 1 : 0];
  const places = [];
  let next = heading + 1;
  for (; next < lines.length && lines[next].startsWith('- `'); next++) {
    // The row's parts, each read once: the opening code-span delimiter, the finding ID at the end, the place
    // between them. Writing the row again must give the very line, so nothing else passes.
    const line = lines[next], fence = /^`+/.exec(line.slice(2))[0], id = /[（(]([A-Za-z]+-\d+)[)）]$/.exec(line);
    const inner = id && line.slice(2 + fence.length, id.index).trimEnd();
    const place = inner && inner.endsWith(fence) ? inner.slice(0, -fence.length).trim() : '';
    const at = /^\/[^:]+:([1-9]\d*)(?:-([1-9]\d*))?$/.exec(place);
    // A place as a finding's is written (lines in order), in the row the runtime writes for it under this heading.
    if (!at || Number(at[2] ?? at[1]) < Number(at[1]) || !listablePlace(place) || placeRow(place, id[1], brackets) !== line) return [];
    places.push(place);
  }
  const rest = lines.slice(next);
  const marker = /^<!-- azpr-comment:[a-f0-9]{32} -->$/;
  // The end of a comment for several places: the marker of its lines, a blank line, its own marker.
  if (!places.length || rest.shift() !== '' || !marker.test(rest.pop() ?? '') || rest.pop() !== '' || !marker.test(rest.pop() ?? '')) return [];
  if (!rest.length) return places;
  // The attribution: a rule, the line the runtime writes for a comment, and a blank line.
  return rest.length === 3 && rest[0] === '---' && commentAttributionLine(rest[1]) && rest[2] === '' ? places : [];
}

/**
 * Whether a line is the attribution `commentAttribution` writes for an inline
 * comment, in any language: its fixed wording for a review of this pipeline,
 * or for a verified or a quick review of 0.4.x, then the models (references as settings take them), each in a code
 * span, and nothing else.
 */
function commentAttributionLine(line) {
  return Object.values(vocabulary).flatMap(words => [`${words.comment} `, ...[words.quick, words.reviewers].map(method => `${words.lead}${method}${words.end}${words.models} `)])
    .some(wording => line.startsWith(wording) && line.slice(wording.length).split(', ').every(span => /^`[^`]+`$/.test(span) && isModelReference(span.slice(1, -1))));
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
  // Only a verified review of 0.4.x speaks of confirmed defects: nothing else confirms anything.
  const empty = verification === 'none'
    ? pick(language, 'No defects reported; this does not establish that the code is bug-free.', '未回報缺陷；這不保證程式沒有問題。', '未报告缺陷；这不保证程序没有问题。')
    : pick(language, 'No confirmed defects found; this does not establish that the code is bug-free.', '未發現可確認缺陷；這不保證程式沒有問題。', '未发现可确认缺陷；这不保证程序没有问题。');
  const rows = [...findings].sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity)).map(f => `| ${severityIcons[f.severity] ?? ''} ${cell(f.severity)} | ${f.ids.map(cell).join(', ')} — ${cell(f.summary)} | ${cell(displayLocation(f.location))} |`).join('\n');
  return `## PR Review Summary\n\n${introduction ? `${introduction}\n\n` : ''}${counts}\n\n${rows ? `| Severity | Summary | ${w.location} |\n| --- | --- | --- |\n${rows}` : empty}`;
}

const findingFields = ['id', 'summary', 'severity', 'reviewerSeverity', 'location', 'evidence', 'counterevidence', 'suggestion', 'origin', 'shardId', 'originalId'];
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
  // A level the rating changed shows the one its reviewer gave next to it.
  const level = `${finding.severity || '—'}${finding.reviewerSeverity && finding.reviewerSeverity !== finding.severity ? `; ${w.reviewer}: ${finding.reviewerSeverity}` : ''}`;
  return `### ${finding.id || '—'} — ${finding.summary || w.none} (${level})\n\n**${w.location}:** ${displayLocation(finding.location) || '—'}\n\n**${w.evidence}**\n\n${finding.evidence || w.none}\n\n**${w.counter}**\n\n${finding.counterevidence || w.none}\n\n**${w.suggestion}**\n\n${finding.suggestion || w.none}${extraOutput(finding, findingFields)}`;
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

/**
 * The report of a review: status, coverage and method stated separately at the
 * top, then the findings that are still reported, with the level in effect
 * (and the reviewer's own where the rating changed it).
 */
export function renderFinalReport(final, language) {
  const w = reportWords(language);
  const reported = final.dispositions.filter(d => d.status === 'REPORTED').map(d => ({ ...d.finding, id: d.id, reviewerSeverity: d.reviewerSeverity }));
  const pendingInfo = final.dispositions.filter(d => d.status === 'NEEDS_INFO' && d.partialFinding).map(d => ({ ...d.partialFinding, id: d.id }));
  const c = final.coverageSummary, gap = coverageNote(c, language);
  // Two numbers of the changed files Azure listed: reviewed at least once, and reviewed in every pass.
  const counts = c && Number.isInteger(c.files) ? ` — ${w.once(c.reviewedOnce, c.files)}${c.passes > 1 ? `, ${w.every(c.reviewedByAll, c.files, c.passes)}` : ''}` : '';
  const coverageLine = `**${w.coverage}:** ${c?.complete ? w.complete : `${w.incomplete}${gap ? ` (${gap})` : ''}`}${counts}`;
  // A review without a usable answer has no checked findings to speak of: it says only that, and its coverage.
  const usable = final.status === 'COMPLETE' || final.status === 'STALE';
  const banner = `${final.status === 'STALE' ? `**STALE: ${w.stale}**\n\n` : !usable ? `**${final.status}: ${w.partial}**\n\n` : ''}${usable ? `**${w.banner}**\n\n` : ''}${coverageLine}\n\n`;
  const limitations = (final.reviewWarnings ?? []).map(message => `- ${message}`).join('\n');
  const reportedIds = reported.map(f => f.id);
  const decisions = [...(reportedIds.length ? [`- **${reportedIds.join(', ')} — REPORTED:** ${w.reported}`] : []),
    ...final.dispositions.filter(d => d.status !== 'REPORTED').map(d => `- **${d.id || '—'} — ${d.status}${d.mergedInto ? ' → ' + d.mergedInto : ''}:** ${d.reason || w.none}`)].join('\n');
  const reference = [...(final.initialObservations ?? []).map(f => renderFinding(f, w)), ...(final.unstructuredInitials ?? [])].join('\n\n');
  const referenceTitle = pick(language, 'Review observations (reference only, not final conclusions)', '審查觀察（參考資料，非最終結論）', '审查观察（参考资料，非最终结论）');
  return `${banner}${final.status === 'COMPLETE' ? renderReviewSummary(reported, language, '', { verification: 'none' }) + '\n\n' : ''}## ${w.overview}\n\n${final.report || w.none}${limitations ? '\n\n' + limitations : ''}${renderCoverage(final, w)}\n\n## ${w.findings}\n\n${reported.map(f => renderFinding(f, w)).join('\n\n') || w.none}${pendingInfo.length && final.status === 'COMPLETE' ? `\n\n## ${w.needsInfo}\n\n${pendingInfo.map(f => renderFinding(f, w)).join('\n\n')}` : ''}\n\n## ${w.scope}\n\n${renderSnapshot(final)}\n\n## ${w.decisions}\n\n${decisions || w.none}${reference ? '\n\n## ' + referenceTitle + '\n\n' + reference : ''}`;
}

/** What the reviewers that answered wrote is kept when the review did not complete. */
export function renderIncompleteDraft(stages, failure, language) {
  const initials = stages.filter(s => ROLES[s.role]?.format === 'initial' && s.result);
  if (!initials.length) return '';
  const w = reportWords(language);
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

/**
 * Text for the `<azpr_NAME_data>` block of a notice (`report` or `comment`). The block ends at its closing
 * tag, so that tag must not occur in the text: it is written as `&lt;/azpr_NAME_data&gt;`. Text that already
 * holds that entity form, or one escaped further, gets one more level of `&amp;`, so that nothing is
 * ambiguous: a reader takes exactly one level off again and has the text as it was (the terminal panel does,
 * see `disclose` in tui-model.mjs). Everything else is left as it is.
 */
export function enclose(name, text) {
  const tag = `/azpr_${name}_data`;
  return String(text ?? '').replace(new RegExp(`<${tag}>|&((?:amp;)*)lt;${tag}&((?:amp;)*)gt;`, 'g'),
    (found, left, right) => (left === undefined ? `&lt;${tag}&gt;` : `&amp;${left}lt;${tag}&amp;${right}gt;`));
}

/** Publication ledger rows for receipts. */
export function renderPublication(review, result) {
  const rows = [...(review.publication ?? new Map()).values()].map(entry =>
    `- ${entry.kind === 'summary' ? 'PR summary' : `${(entry.findingIds ?? [entry.findingId]).join(', ')} (${entry.path}:${entry.startLine})`}: ${entry.state}${entry.threadId ? `; thread=${entry.threadId}` : ''}${entry.error ? `; error=${entry.error}` : ''}${entry.contentMismatch ? '; returned text differs' : ''}${entry.earlierText ? '; the PR keeps its earlier text' : ''}`).join('\n');
  const counts = result?.counts ? Object.entries(result.counts).map(([state, count]) => `${state}=${count}`).join(', ') : '';
  // A PR that is not active takes comments all the same; its status is named, so a wrong PR shows.
  return `Publication${counts ? ` (${counts})` : ''}${result?.readBack && result.readBack !== 'complete' ? `; read-back ${result.readBack}` : ''}${result?.prStatus ? `; the PR is ${result.prStatus}` : ''}:\n${rows || '- Nothing recorded.'}\n\nPOSTED/VERIFIED entries were created by AZPR and VERIFIED ones were read back from Azure DevOps. ALREADY_PRESENT entries existed before this run. DELETED entries were created by AZPR and later deleted on the PR; AZPR does not post them again. FAILED entries are safe to retry with /pr-comment ${review.id} --publish; existing comments are skipped by their markers. UNVERIFIED entries were created but not found when read back; a re-run checks them again and never posts them twice. UNCERTAIN entries may still appear from an earlier attempt and are retried only after their marker check settles.`;
}

function renderStageReceipt(stage) {
  const fields = [`${stage.role}${stage.label ? ` [${stage.label}]` : ''}: ${stage.status}`, `session=${stage.sessionID}`, `model=${stage.model}`];
  const counters = [
    ['attempt', stage.attempt > 1 ? stage.attempt : 0],
    ['repair-turns', stage.repairs?.length],
    ['stream-continuations', stage.hostContinuations],
    ['continuation-restarts', stage.continuationRestarts],
    ['step-retries', stage.hostStepRetries],
    ['blocked-native-tools', stage.blockedNativeToolCalls],
    ['observed-tool-errors', stage.toolFailures],
    ['tool-timeouts', stage.toolTimeouts],
    ['truncated-tool-results', stage.toolObservations?.truncated],
    ['review-limitations', stage.reviewWarnings?.length],
  ];
  for (const [label, count] of counters) if (count) fields.push(`${label}=${count}`);
  if (stage.followUp) fields.push(`follow-up=${stage.followUp.outcome}${stage.followUp.failureClass ? `:${stage.followUp.failureClass}` : ''}`);
  // A correction turn that failed: the answer before it stands, with the items it would have repaired degraded.
  if (stage.repairFailure) fields.push(`repair=failed:${stage.repairFailure.failureClass}`);
  if (stage.failureClass) fields.push(`failure=${stage.failureClass}`);
  if (stage.error) fields.push(`error=${stage.error}`);
  return '- ' + fields.join('; ');
}

export function renderReceipt(run, report, status, error, settings) {
  const rows = run.stages.map(renderStageReceipt).join('\n');
  // A review states coverage and verification next to its status: whether every changed file was reviewed,
  // with several passes how many files every pass reviewed, and that nothing verified the findings separately.
  const reviewing = ['review', 'deep', 'quick'].includes(run.mode), summary = run.reviewSummary?.coverage;
  // Of the changed files: how many were reviewed at all, where that is not every one, and with several passes how many every pass reviewed.
  const counted = Number.isInteger(summary?.files);
  const once = counted && summary.reviewedOnce < summary.files ? `, ${summary.reviewedOnce}/${summary.files} file(s) reviewed` : '';
  const every = counted && summary.passes > 1 ? `, ${summary.reviewedByAll}/${summary.files}${once ? '' : ' file(s)'} in every pass` : '';
  const method = reviewing ? `${summary ? `; coverage ${summary.complete ? 'complete' : 'incomplete'}${once}${every}` : ''}; verification none` : '';
  let body = `[AZPR ${run.id}] ${status}${method}\n${error ? `Reason (${run.phase ?? 'workflow'}): ${error}\n` : ''}${rows}${rows ? '\n' : ''}`;
  if (run.stages.some(s => s.repairs?.length)) body += '\nRepair notice: some answers did not meet the output contract and the same session was asked to correct them. Remaining problems were downgraded per item (NEEDS_INFO, a merge or rating left out, or skipped comments) instead of discarding the review.\n';
  if (run.stages.some(s => s.attempt > 1)) body += '\nRetry notice: a stage failed for a transient reason and ran again in a new session.\n';
  if (run.stages.some(s => s.followUp)) body += '\nFollow-up notice: a session answered PARTIAL and named unfinished work, so the same session was asked once to continue (follow-up=completed, still-partial, unusable or failed). A follow-up that failed or gave no usable answer kept the answer it followed.\n';
  if (run.draft) body += '\nIncomplete draft notice: the review did not complete; its observations are unconfirmed and not input for PR comments.\n';
  if (run.sessionsRemoved) body += `\nSession notice: ${run.sessionsRemoved} reviewer session(s) of this run were deleted when it ended; only a session that holds the report or draft is kept (deletePrivateSessions). debug.enabled keeps them all.\n`;
  body += renderDiagnosticNotices(run, settings);
  body += run.mode === 'check'
    ? '\nStatus: READY means AZPR can read the PR through the Azure DevOps REST API; it does not review or approve the PR.\n'
    : run.mode === 'comment'
      ? ''
      : '\nStatus: COMPLETE means at least one review session produced a usable result and no source-commit change was detected. Each finding was checked by its reviewer against the source and by the runtime for form and source only; nothing verified it separately, and findings that failed the runtime\'s checks are NEEDS_INFO. Coverage says whether every changed file was reviewed, and with several passes how many files every pass reviewed. STALE means the PR source commit changed during the review. PARTIAL means no session produced a usable result. None of these approves the PR.\n';
  if (run.userContext) body += '\nSupplementary context applies to this command only.\n';
  if (report) {
    const last = run.reportStage;
    if (last?.reportQueued) body += `\nReport delivery: report queued to session=${last.sessionID}.\n`;
    else if (run.stages.length) body += '\nReport delivery: the report could not be queued to a review session; it is enclosed below.\n';
    if (settings.returnReport === 'full' || run.draft || ['PARTIAL', 'INCOMPLETE', 'STALE'].includes(status) || !last?.reportQueued) {
      body += `\nReport data:\n<azpr_report_data>\n${enclose('report', report)}\n</azpr_report_data>\n`;
    }
  }
  if (['review', 'deep', 'quick'].includes(run.mode) && status === 'COMPLETE' && settings.returnReport !== 'full') body += '\n' + renderCommentActions(run.id, settings.outputLanguage, run.afterReview) + '\n';
  body += `\nThis command has ended and all reviewer grants have been revoked. outputLanguage=${settings.outputLanguage}.`;
  return body;
}

/**
 * Content search that could not run limits the whole review, and the tool told
 * only the models. The runtime states it in the report and the receipt, so it
 * does not depend on a model mentioning it. Empty when every search ran.
 */
export function searchLimitation(run, settings) {
  const refused = run?.searchUnavailable;
  if (!refused?.size) return '';
  const megabytes = settings?.azure?.archiveMegabytes;
  // Only an archive over the limit is something the setting changes.
  const setting = ![...refused.values()].some(Boolean) || !megabytes ? ''
    : megabytes < MAX_ARCHIVE_MEGABYTES ? ` azure.archiveMegabytes is ${megabytes}; it accepts up to ${MAX_ARCHIVE_MEGABYTES}.`
      : ` azure.archiveMegabytes is at its maximum of ${MAX_ARCHIVE_MEGABYTES}.`;
  return `Content search (azpr_search_code) was unavailable: ${[...refused.keys()].join('; ')}. Sessions could find and read files but not search file contents, so callers and other uses of the changed code may not have been checked.${setting}`;
}

export function renderDiagnosticNotices(run, settings) {
  const notices = [];
  const sum = key => run.stages.reduce((n, s) => n + (s[key] ?? 0), 0);
  const blocked = sum('blockedNativeToolCalls'), failures = sum('toolFailures'), timeouts = sum('toolTimeouts');
  if (blocked) notices.push(`\nTool notice: ${blocked} attempt(s) to use a tool this role may not use were blocked before execution.\n`);
  if (failures) notices.push(`\nTool error notice: ${failures} tool call(s) failed. A completed review does not erase these; inspect the original tool results.\n`);
  if (timeouts) notices.push(`\nTool timeout notice: ${timeouts} Azure DevOps read(s) exceeded the per-call timeout after retries and were abandoned.\n`);
  const idle = run.stages.filter(stage => stage.failureClass === 'idle');
  if (idle.length) notices.push(`\nInactivity notice: the stage inactivity watchdog stopped ${idle.length} stage(s) (failure=idle) after ${idle[0].idleStop?.idleSeconds ?? 'workflow.stageIdleSeconds'} s without activity: ${idle.map(stage => `${stage.role}${stage.label ? ` [${stage.label}]` : ''} after ${stage.idleStop?.lastActivity ?? 'an unknown activity'}`).join('; ')}. The model stream, a tool or OpenCode stopped responding; a stopped stage runs again in a new session while workflow.stageRetries allows.\n`);
  const search = searchLimitation(run, settings);
  if (search) notices.push(`\nContent search notice: ${search}\n`);
  if (run.abortUnconfirmed) notices.push('\nCancellation warning: OpenCode did not confirm session settlement. Requests already sent may still be running or billed.\n');
  if (run.debug?.directory) notices.push(`\nPrivate debug directory: ${run.debug.directory}\n`);
  for (const warning of run.debug?.warnings ?? []) notices.push(`Debug warning: ${warning}\n`);
  return notices.join('');
}
