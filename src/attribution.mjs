import { ROLES } from './config.mjs';
// Deterministic attribution from invoked reviewer stages, not model-authored claims.
const vocabulary = {
  en: { title: 'AI review provenance', disclaimer: 'AI-generated review, not human approval. Posting through a user account does not imply that person verified these conclusions.', method: 'Independent initial reviews, followed by source-based verification, duplicate merging, and rejection of unsupported findings; not majority voting.', roles: ['Source check', 'Functional review', 'Risk review', 'Final verification'], stage: 'Stage', model: 'Selected provider/model ID', count: 'Initial findings', dispositions: 'Finding dispositions', finding: 'Finding', result: 'Result', merged: 'Merged into', extra: 'New verifier findings', note: 'IDs identify the models selected in OpenCode, not independently verified provider backend identities. Host auxiliary models and the original chat model are not part of this ledger.', comment: 'AI-generated review; not human review or approval. Models:' },
  tw: { title: 'AI 審查來源', disclaimer: '本報告由 AI 產生，不代表人工核准。使用個人帳號發佈，不表示該使用者已驗證這些結論。', method: '各模型獨立初審，再由最終模型回查原始碼、交叉驗證、合併重複問題並排除缺乏證據的結論；不是多數決。', roles: ['來源檢查', '功能初審', '風險初審', '最終驗證'], stage: '階段', model: '實際選用的 provider/model ID', count: '初審問題數', dispositions: '問題處置', finding: '問題', result: '結果', merged: '合併至', extra: '最終驗證新增問題', note: '此處記錄 OpenCode 實際選用的模型 ID，不是對供應商後端模型身分的獨立驗證；不包含主對話及宿主的輔助模型。', comment: 'AI 審查，非人工審查或核准。模型：' },
  cn: { title: 'AI 审查来源', disclaimer: '本报告由 AI 产生，不代表人工批准。使用个人账号发布，不表示该用户已验证这些结论。', method: '各模型独立初审，再由最终模型回查源码、交叉验证、合并重复问题并排除缺乏证据的结论；不是多数决。', roles: ['来源检查', '功能初审', '风险初审', '最终验证'], stage: '阶段', model: '实际选用的 provider/model ID', count: '初审问题数', dispositions: '问题处置', finding: '问题', result: '结果', merged: '合并至', extra: '最终验证新增问题', note: '此处记录 OpenCode 实际选用的模型 ID，不是对供应商后端模型身份的独立验证；不包含主对话及宿主的辅助模型。', comment: 'AI 审查，非人工审查或批准。模型：' },
};
function words(language) {
  if (!/^zh(?:-|$)/i.test(language)) return vocabulary.en;
  return new Intl.Locale(language).maximize().script === 'Hant' ? vocabulary.tw : vocabulary.cn;
}
export function renderCommentActions(id, language) {
  const locale = words(language);
  const labels = locale === vocabulary.tw
    ? ['PR 留言', '直接準備並發布留言', '只看留言預覽', '也可省略 ID：`/pr-comment --publish`。原對話會選最近完成的 review；本報告對話會選本份報告。僅預覽請用 `/pr-comment`。', 'Review 與預覽保存在目前程序記憶體（最近 20 份）；重啟後清除，歷史報告不會還原發布資料。']
    : locale === vocabulary.cn
      ? ['PR 留言', '直接准备并发布留言', '只看留言预览', '也可省略 ID：`/pr-comment --publish`。原对话会选最近完成的 review；本报告对话会选本份报告。仅预览请用 `/pr-comment`。', 'Review 与预览保存在当前进程内存（最近 20 份）；重启后清除，历史报告不会还原发布数据。']
      : ['PR comments', 'Prepare and publish comments', 'Preview comments only', 'You can omit the ID: `/pr-comment --publish` selects the latest completed review in the original conversation, or this review in its report session. Use `/pr-comment` for preview only.', 'Reviews and previews stay in this process memory (latest 20 reviews); restarting clears them. Historical reports do not restore publication data.'];
  return `## ${labels[0]}\n\n${labels[1]}:\n\n\`\`\`text\n/pr-comment ${id} --publish\n\`\`\`\n\n${labels[2]}: \`/pr-comment ${id}\`\n\n${labels[3]}\n\n${labels[4]}`;
}
export function reviewProvenance(run) {
  return { mode: run.profile, stages: run.stages.filter(s => s.status !== 'FAILED' && ROLES[s.role]?.order !== undefined).sort((a, b) => ROLES[a.role].order - ROLES[b.role].order).map(s => ({ role: s.role, model: s.model, findings: s.result?.findings?.length })) };
}
export function provenanceReport(provenance, final, language) {
  const w = words(language);
  const rows = provenance.stages.map(s => `| ${w.roles[ROLES[s.role]?.order]} | \`${s.model}\` | ${s.findings ?? '—'} |`).join('\n');
  const dispositions = final.dispositions.map(d => `| ${d.id} | ${d.status} | ${d.mergedInto ?? '—'} |`).join('\n');
  return `## ${w.title} (${provenance.mode})\n\n${w.disclaimer}\n\n${w.method}\n\n| ${w.stage} | ${w.model} | ${w.count} |\n| --- | --- | --- |\n${rows}\n\n${w.note}\n\n### ${w.dispositions}\n\n| ${w.finding} | ${w.result} | ${w.merged} |\n| --- | --- | --- |\n${dispositions}\n\n${w.extra}: ${(final.newFindings ?? []).map(f => f.id).join(', ') || '0'}`;
}
export function commentAttribution(provenance, language, commentModel) {
  if (!provenance) return ''; // Never synthesize identities without a review ledger.
  const w = words(language);
  const models = [...new Set([...provenance.stages.map(s => s.model), commentModel])].map(model => `\`${model}\``).join(', ');
  return `${w.comment} ${models}`;
}


// Presentation uses validated fields; it neither translates nor invents claims.
const reportVocabulary = {
  en: { scope:'Scope and versions', overview:'Checks and limitations', findings:'Confirmed findings', decisions:'Finding decisions', evidence:'Evidence and impact', counter:'Counterevidence', suggestion:'Correction and verification', location:'Location', none:'None reported.', draft:'Incomplete review draft', warning:'AI-generated, unconfirmed initial observations. Final adjudication did not complete. This is not an approved review or input for PR comments. Source text is retained in its original language; no model was called to format this draft.', failure:'Failure', missing:'Missing disposition IDs', candidates:'Unconfirmed initial observations', gaps:'Coverage gaps', stage:'Stage', model:'Selected model', partial:'Verification is incomplete. These claims are provisional and cannot be used for PR comments.' },
  tw: { scope:'範圍與版本', overview:'查證與限制', findings:'已確認問題', decisions:'問題裁決理由', evidence:'證據與影響', counter:'反證檢查', suggestion:'修正與驗證建議', location:'位置', none:'未列出。', draft:'未完成審查草稿', warning:'AI 產生的初審觀察，尚未完成最終裁決，不能視為已確認結論或用於 PR 留言。原始內容保留原語言；草稿排版未呼叫模型。', failure:'失敗原因', missing:'缺少裁決的 ID', candidates:'尚未確認的初審觀察', gaps:'覆蓋缺口', stage:'階段', model:'實際選用模型', partial:'驗證尚未完成，下列結論僅供檢視，不能用於 PR 留言。' },
  cn: { scope:'范围与版本', overview:'查证与限制', findings:'已确认问题', decisions:'问题裁决理由', evidence:'证据与影响', counter:'反证检查', suggestion:'修正与验证建议', location:'位置', none:'未列出。', draft:'未完成审查草稿', warning:'AI 产生的初审观察，尚未完成最终裁决，不能视为已确认结论或用于 PR 留言。原始内容保留原语言；草稿排版未调用模型。', failure:'失败原因', missing:'缺少裁决的 ID', candidates:'尚未确认的初审观察', gaps:'覆盖缺口', stage:'阶段', model:'实际选用模型', partial:'验证尚未完成，下列结论仅供查看，不能用于 PR 留言。' },
};
function reportWords(language) {
  return reportVocabulary[words(language) === vocabulary.tw ? 'tw' : words(language) === vocabulary.cn ? 'cn' : 'en'];
}
// Display a preserved structured location when its explicit coordinates are
// unambiguous. This changes no finding, saved anchor or publication eligibility.
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
// A compact index of existing claims, not another model-authored assessment.
export function renderReviewSummary(findings, language) {
  const w = reportWords(language);
  const cell = value => String(value ?? '—').replace(/[\r\n]+/g, ' ').replace(/[&<>|`*_[\]\\]/g, c => `&#${c.charCodeAt(0)};`);
  const counts = ['high', 'medium', 'low'].map(level => `${level}: ${findings.filter(f => f.severity === level).length}`).join(' · ');
  const empty = words(language) === vocabulary.tw ? '未發現可確認缺陷；這不保證程式沒有問題。'
    : words(language) === vocabulary.cn ? '未发现可确认缺陷；这不保证程序没有问题。' : 'No confirmed defects found; this does not establish that the code is bug-free.';
  const rows = [...findings].sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity)).map(f => `| ${cell(f.severity)} | ${cell(f.id)} — ${cell(f.summary)} | ${cell(displayLocation(f.location))} |`).join('\n');
  return `## PR Review Summary\n\n${counts}\n\n${rows ? `| Severity | Summary | ${w.location} |\n| --- | --- | --- |\n${rows}` : empty}`;
}
const findingFields = ['id', 'summary', 'severity', 'location', 'evidence', 'counterevidence', 'suggestion'];
function extraOutput(value, known) {
  const entries = Object.entries(value ?? {}).filter(([key, content]) => !known.includes(key) && content !== '' && content !== null);
  if (!entries.length) return '';
  const text = JSON.stringify(Object.fromEntries(entries), null, 2);
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `\n\n${fence}json\n${text}\n${fence}`;
}
function renderFinding(finding = {}, w) {
  finding ??= {};
  return `### ${finding.id || '—'} — ${finding.summary || w.none} (${finding.severity || '—'})\n\n**${w.location}:** ${displayLocation(finding.location) || '—'}\n\n**${w.evidence}**\n\n${finding.evidence || w.none}\n\n**${w.counter}**\n\n${finding.counterevidence || w.none}\n\n**${w.suggestion}**\n\n${finding.suggestion || w.none}${extraOutput(finding, findingFields)}`;
}
function renderSnapshot(snapshot) {
  if (!snapshot) return 'Snapshot not established.';
  return `${snapshot.repository || '—'} · PR #${snapshot.prId || '—'} · ${snapshot.scope || '—'}\n\n- base: \`${snapshot.base || ''}\`\n- head: \`${snapshot.head || ''}\`\n- files: ${Array.isArray(snapshot.files) ? snapshot.files.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(', ') : '—'}${extraOutput(snapshot, ['repository', 'prId', 'scope', 'base', 'head', 'files'])}`;
}
export function renderFinalReport(final, language) {
  const w = reportWords(language);
  const findingTitle = final.status === 'COMPLETE' ? w.findings : words(language) === vocabulary.tw
    ? '模型提出的問題（驗證有限）' : words(language) === vocabulary.cn ? '模型提出的问题（验证有限）' : 'Model-reported findings (verification limited)';
  const findings = [...final.dispositions.filter(d => d.status === 'CONFIRMED').map(d => d.verifiedFinding), ...(final.newFindings ?? [])];
  const decisions = final.dispositions.map(d => `- **${d.id || '—'} — ${d.status}${d.mergedInto ? ' → ' + d.mergedInto : ''}:** ${d.reason || w.none}${extraOutput(d, ['id', 'status', 'mergedInto', 'reason', 'verifiedFinding'])}`).join('\n');
  const limitations = (final.reviewWarnings ?? []).map(message => `- ${message}`).join('\n');
  const pending = [...(final.initialObservations ?? final.unreviewedFindings ?? []).map(f => renderFinding(f, w)), ...(final.unstructuredInitials ?? [])].join('\n\n');
  const referenceTitle = words(language) === vocabulary.tw ? '初審觀察（參考資料，非最終結論）' : words(language) === vocabulary.cn
    ? '初审观察（参考资料，非最终结论）' : 'Initial observations (reference only, not final conclusions)';
  const extras = extraOutput(final, ['status', 'modelStatus', 'snapshot', 'currentHead', 'currentBase', 'report', 'confirmed', 'merged', 'rejected', 'needsInfo', 'dispositions', 'newFindings', 'unreviewedFindings', 'reviewWarnings', 'contractComplete', 'unstructured', 'unstructuredInitials', 'initialObservations']);
  return `${final.status !== 'COMPLETE' ? '**' + final.status + ': ' + w.partial + '**\n\n' : renderReviewSummary(findings, language) + '\n\n'}## ${w.overview}\n\n${final.report || w.none}${limitations ? '\n\n' + limitations : ''}${extras}\n\n## ${findingTitle}\n\n${findings.map(f => renderFinding(f, w)).join('\n\n') || w.none}\n\n## ${w.scope}\n\n${renderSnapshot(final.snapshot)}\n\n- currentHead: \`${final.currentHead ?? ''}\`\n- currentBase: \`${final.currentBase ?? ''}\`\n\n## ${w.decisions}\n\n${decisions || w.none}${pending ? '\n\n## ' + referenceTitle + '\n\n' + pending : ''}`;
}

/** Completed initial responses are retained, with their limitations. Failed final claims never
 * become accepted findings, and no draft enters the completed-review cache. */
export function renderIncompleteDraft(stages, failure, language) {
  const initials = stages.filter(s => ROLES[s.role]?.format === 'initial' && s.result);
  if (!initials.length) return '';
  const w = reportWords(language);
  const missing = [...new Set(stages.flatMap(s => s.missingDispositionIds ?? []))];
  const ledger = stages.map(s => `- ${s.role}: ${s.status}; session=${s.sessionID}; model=${s.model}`).join('\n');
  const observations = initials.map(s => `### ${s.role}\n\n${s.result.snapshot ? renderSnapshot(s.result.snapshot) + '\n\n' : ''}${s.result.report}\n\n**${w.gaps}:** ${s.result.coverage.gaps.join('; ') || w.none}\n\n${s.result.findings.map(f => renderFinding(f, w)).join('\n\n') || w.none}`).join('\n\n');
  return `## ${w.draft}\n\n**${w.warning}**\n\n**${w.failure}:** ${failure}\n\n${missing.length ? '**' + w.missing + ':** ' + missing.join(', ') + '\n\n' : ''}${ledger}\n\n## ${w.candidates}\n\n${observations}`;
}

// Native commands queue deterministic receipts; no presentation model is used.
function renderStageReceipt(stage) {
  const fields = [`${stage.role}: ${stage.status}`, `session=${stage.sessionID}`, `model=${stage.model}`];
  const counters = [
    ['blocked-native-tools', stage.blockedNativeToolCalls],
    ['observed-tool-errors', stage.toolFailures],
    ['reported-tool-errors', stage.toolObservations?.reportedErrors],
    ['truncated-tool-results', stage.toolObservations?.truncated],
    ['output-format-corrections', stage.outputFormatCorrections?.length],
    ['pending-locations', stage.pendingLocations?.length],
    ['review-limitations', stage.reviewWarnings?.length],
  ];
  for (const [label, count] of counters) if (count) fields.push(`${label}=${count}`);
  if (stage.error) fields.push(`error=${stage.error}`);
  return '- ' + fields.join('; ');
}

export function renderReceipt(run, report, status, error, settings) {
  const rows = run.stages.map(renderStageReceipt).join('\n');
  let body = `[AZPR ${run.id}] ${status}\n${error ? `Reason (${run.phase ?? 'workflow'}): ${error}\n` : ''}${rows}\n`;
  if (run.stages.some(s => s.outputFormatCorrections?.length)) body += '\nOutput format notice: a review envelope was extracted, syntax was normalized locally, or unstructured review text was retained. No model request was added for formatting. Inspect outputFormatCorrections, review limitations and the original response. Recovery does not establish source accuracy.\n';
  if (run.publicationUnavailable) body += '\nThis review retains useful results with limitations. Automatic PR comment preparation is unavailable because the complete publication evidence contract was not established.\n';
  if (run.stages.some(s => s.pendingLocations?.length)) body += '\nPending location notice: initial candidates omitted locations and were passed to the verifier. No location was guessed. Missing locations do not discard the review; findings without complete publication evidence cannot be posted. This notice does not claim they were resolved.\n';
  if (run.draft) body += '\nIncomplete draft notice: available initial observations remain unconfirmed because final adjudication did not complete. This draft is not a completed review or input for PR comments. Failed final claims are not accepted findings.\n';
  if (run.stages.length) body += '\nTool completion does not prove source validity. Error/truncation counters neither audit content nor establish recovered reads; inspect the original tool results and evidence.\n';
  body += renderDiagnosticNotices(run);
  body += run.mode === 'check'
    ? '\nStage status: READY means source access is ready; it does not approve the PR.\n'
    : '\nReview status: COMPLETE means the final verifier result passed its evidence and version checks and can enter comment preview in this session/process. Initial gaps and formatting warnings remain visible. PARTIAL retains results whose final checks are incomplete. Neither status proves factual completeness or approves the PR.\n';
  if (error && run.stages.some(s => s.status === 'FAILED')) body += '\nInspect the failed child session by its session ID through the host UI or private diagnostics. Preserve the original JSON and failure; sending another prompt is a new model request, not read-only inspection.\n';
  if (run.userContext) body += '\nSupplementary context applies to this command only; it is not a repository-wide rule.\n';
  if (report) {
    const last = run.stages.at(-1);
    body += last?.reportQueued
      ? `\nReport delivery: synthetic report queued to session=${last.sessionID}, with no presentation model request. Queue acknowledgement does not certify UI display.\n`
      : '\nReport delivery: no appended synthetic report was confirmed. Inspect the original JSON in the review session or private report/draft diagnostics when available.\n';
    if (settings.returnReport === 'full' || run.draft || ['PARTIAL', 'INCOMPLETE', 'STALE'].includes(status)) {
      body += `\nReport data:\n<azpr_report_data>\n${report.replaceAll('</azpr_report_data>', '&lt;/azpr_report_data&gt;')}\n</azpr_report_data>\n`;
    } else {
      body += '\nNo report body is enclosed in this receipt. Inspect the queued report or saved diagnostic Markdown; original model JSON is separate from the rendered report. Do not resume a reviewer session to retrieve it.\n';
    }
  } else body += '\nNo report body is enclosed in this receipt.\n';
  if (['review', 'deep'].includes(run.mode) && status === 'COMPLETE' && settings.returnReport !== 'full') body += '\n' + renderCommentActions(run.id, settings.outputLanguage) + '\n';
  body += `\nThis command has ended and all reviewer grants have been revoked. outputLanguage=${settings.outputLanguage}.`;
  return body;
}

export function renderDiagnosticNotices(run) {
  const notices = [];
  const blocked = run.stages.reduce((n, s) => n + (s.blockedNativeToolCalls ?? 0), 0);
  const failures = run.stages.reduce((n, s) => n + (s.toolFailures ?? 0), 0);
  const reported = run.stages.reduce((n, s) => n + (s.toolObservations?.reportedErrors ?? 0), 0);
  const truncated = run.stages.reduce((n, s) => n + (s.toolObservations?.truncated ?? 0), 0);
  if (blocked) notices.push(`\nNative tool notice: ${blocked} prohibited native attempt(s) were blocked before execution. Two distinct attempts in one stage stop the run. MCP read-only behavior still depends on prompt policy and host/server permissions.\n`);
  if (failures) notices.push(`\nTool error notice: ${failures} failure(s) were observed through V2 terminal execution hooks. The plugin did not retry those calls or infer their causes. A completed review does not erase recovered errors; inspect the original tool results.\n`);
  if (reported || truncated) notices.push(`\nTool result notice: ${reported} result(s) explicitly signalled an error; ${truncated} result(s) signalled truncation. These counts can overlap execution errors and each other; they are not additional unique failures or inferred causes.\n`);
  if (run.abortUnconfirmed) notices.push('\nCancellation warning: OpenCode did not confirm session settlement. Requests already sent may still be running or billed.\n');
  if (run.debug?.directory) notices.push(`\nPrivate debug directory: ${run.debug.directory}\n`);
  for (const warning of run.debug?.warnings ?? []) notices.push(`Debug warning: ${warning}\n`);
  return notices.join('');
}
