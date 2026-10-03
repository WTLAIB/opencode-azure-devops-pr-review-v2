import { ROLES } from './config.mjs';
// Deterministic attribution from invoked reviewer stages, not model-authored claims.
const vocabulary = {
  en: { title: 'AI review provenance', disclaimer: 'AI-generated review, not human approval. Posting through a user account does not imply that person verified these conclusions.', method: 'Independent initial reviews, followed by source-based verification, duplicate merging, and rejection of unsupported findings; not majority voting.', roles: ['Source check', 'Functional review', 'Risk review', 'Final verification'], stage: 'Stage', model: 'Selected provider/model ID', count: 'Initial findings', dispositions: 'Finding dispositions', finding: 'Finding', result: 'Result', merged: 'Merged into', extra: 'New verifier findings', note: 'IDs identify the models selected in OpenCode, not independently verified provider backend identities. Host auxiliary models and the original chat model are not part of this ledger.', ai: 'AI-assisted review', posted: 'Posted via a user account; not human approval.', comments: 'Comment preparation/publication' },
  tw: { title: 'AI 審查來源', disclaimer: '本報告由 AI 產生，不代表人工核准。使用個人帳號發佈，不表示該使用者已驗證這些結論。', method: '各模型獨立初審，再由最終模型回查原始碼、交叉驗證、合併重複問題並排除缺乏證據的結論；不是多數決。', roles: ['來源檢查', '功能初審', '風險初審', '最終驗證'], stage: '階段', model: '實際選用的 provider/model ID', count: '初審問題數', dispositions: '問題處置', finding: '問題', result: '結果', merged: '合併至', extra: '最終驗證新增問題', note: '此處記錄 OpenCode 實際選用的模型 ID，不是對供應商後端模型身分的獨立驗證；不包含主對話及宿主的輔助模型。', ai: 'AI 輔助審查', posted: '透過使用者帳號發佈，不代表人工核准。', comments: '留言整理／發佈' },
  cn: { title: 'AI 审查来源', disclaimer: '本报告由 AI 产生，不代表人工批准。使用个人账号发布，不表示该用户已验证这些结论。', method: '各模型独立初审，再由最终模型回查源码、交叉验证、合并重复问题并排除缺乏证据的结论；不是多数决。', roles: ['来源检查', '功能初审', '风险初审', '最终验证'], stage: '阶段', model: '实际选用的 provider/model ID', count: '初审问题数', dispositions: '问题处置', finding: '问题', result: '结果', merged: '合并至', extra: '最终验证新增问题', note: '此处记录 OpenCode 实际选用的模型 ID，不是对供应商后端模型身份的独立验证；不包含主对话及宿主的辅助模型。', ai: 'AI 辅助审查', posted: '通过用户账号发布，不代表人工批准。', comments: '留言整理／发布' },
};
function words(language) {
  if (!/^zh(?:-|$)/i.test(language)) return vocabulary.en;
  return new Intl.Locale(language).maximize().script === 'Hant' ? vocabulary.tw : vocabulary.cn;
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
  const stages = provenance.stages.map(s => `${w.roles[ROLES[s.role]?.order]}: \`${s.model}\``).join('; ');
  return `${w.ai} (${provenance.mode}) — ${stages}; ${w.comments}: \`${commentModel}\`.\n${w.method}\n${w.posted}`;
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
function renderFinding(finding, w) {
  return `### ${finding.id} — ${finding.summary} (${finding.severity})\n\n**${w.location}:** ${finding.location ?? '—'}\n\n**${w.evidence}**\n\n${finding.evidence}\n\n**${w.counter}**\n\n${finding.counterevidence}\n\n**${w.suggestion}**\n\n${finding.suggestion}`;
}
function renderSnapshot(snapshot) {
  return `${snapshot.repository} · PR #${snapshot.prId} · ${snapshot.scope}\n\n- base: \`${snapshot.base}\`\n- head: \`${snapshot.head}\`\n- files: ${snapshot.files.join(', ')}`;
}
export function renderFinalReport(final, language) {
  const w = reportWords(language);
  const findings = [...final.dispositions.filter(d => d.status === 'CONFIRMED').map(d => d.verifiedFinding), ...(final.newFindings ?? [])];
  const decisions = final.dispositions.map(d => `- **${d.id} — ${d.status}${d.mergedInto ? ' → ' + d.mergedInto : ''}:** ${d.reason}`).join('\n');
  return `${final.status !== 'COMPLETE' ? '**' + final.status + ': ' + w.partial + '**\n\n' : ''}## ${w.scope}\n\n${renderSnapshot(final.snapshot)}\n\n- currentHead: \`${final.currentHead ?? ''}\`\n- currentBase: \`${final.currentBase ?? ''}\`\n\n## ${w.overview}\n\n${final.report}\n\n## ${w.findings}\n\n${findings.map(f => renderFinding(f, w)).join('\n\n') || w.none}\n\n## ${w.decisions}\n\n${decisions || w.none}`;
}

/** Only already validated initial results are shown. Failed final claims never
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
  if (stage.retryOf) fields.push('output-retry=1/1', `retry-of=${stage.retryOf}`, `retry-kind=${stage.retryKind}`);
  const counters = [
    ['blocked-native-tools', stage.blockedNativeToolCalls],
    ['observed-tool-errors', stage.toolFailures],
    ['reported-tool-errors', stage.toolObservations?.reportedErrors],
    ['truncated-tool-results', stage.toolObservations?.truncated],
    ['output-format-corrections', stage.outputFormatCorrections?.length],
    ['pending-locations', stage.pendingLocations?.length],
  ];
  for (const [label, count] of counters) if (count) fields.push(`${label}=${count}`);
  if (stage.error) fields.push(`error=${stage.error}`);
  return '- ' + fields.join('; ');
}

export function renderReceipt(run, report, status, error, settings) {
  const rows = run.stages.map(renderStageReceipt).join('\n');
  let body = `[AZPR ${run.id}] ${status}\n${error ? `Reason (${run.phase ?? 'workflow'}): ${error}\n` : ''}${rows}\n`;
  if (run.stages.some(s => s.outputFormatCorrections?.length)) body += '\nOutput format notice: narrowly allowed trailing commas, finding-key whitespace, empty/null unknown finding fields, or identical new-finding disposition duplicates were normalized locally before full validation. Required values were unchanged; no model request was added. Inspect outputFormatCorrections and the original JSON response.\n';
  if (run.stages.some(s => s.pendingLocations?.length)) body += '\nPending location notice: initial candidates omitted locations and went unchanged to the verifier. No location was guessed. Final confirmations still require locations; unresolved candidates must remain NEEDS_INFO and cannot be published. This notice does not claim they were resolved.\n';
  if (run.stages.some(s => s.retryKind === 'location')) body += '\nLocation amendment notice: the same reviewer received one request for missing locations from retained source context, with tools denied and existing fields immutable. Full revalidation is required. This is model-authored recovery, not independent location proof; inspect both submissions and their statuses.\n';
  if (run.stages.some(s => s.retryKind === 'disposition')) body += '\nDisposition amendment notice: the same verifier was asked only for missing MERGED rows pointing to already confirmed findings, with tools denied and existing fields immutable. Full revalidation and the one shared amendment allowance apply. The original failure remains recorded; this is model-authored bookkeeping, not independent source proof.\n';
  if (run.stages.some(s => s.retryKind === 'final')) body += '\nFinal resubmission notice: the same verifier received at most one additional request to replace invalid final content from retained context, with tools denied and the original deadline unchanged. Evidence and decisions may change; snapshot and current versions stay frozen. Full validation is required. Inspect both submissions; the original failure remains recorded. This is model-authored content recovery, not independent source proof.\n';
  if (run.draft) body += '\nIncomplete draft notice: validated initial observations remain unconfirmed because final adjudication did not complete. This draft is not a completed review or input for PR comments. Failed final claims are not accepted findings.\n';
  if (run.stages.length) body += '\nTool completion does not prove source validity. Error/truncation counters neither audit content nor establish recovered reads; inspect the original tool results and evidence.\n';
  body += renderDiagnosticNotices(run);
  body += run.mode === 'check'
    ? '\nStage status: READY means source access is ready; it does not approve the PR.\n'
    : '\nStage status: initial/verifier COMPLETE means the stage passed its contracts; it does not approve the PR.\n';
  if (error && run.stages.some(s => s.status === 'FAILED')) body += '\nInspect the failed child session by its session ID through the host UI or private diagnostics. Preserve the original JSON and failure; sending another prompt is a new model request, not read-only inspection.\n';
  if (run.userContext) body += '\nSupplementary context applies to this command only; it is not a repository-wide rule.\n';
  if (report) {
    const last = run.stages.at(-1);
    body += last?.reportQueued
      ? `\nReport delivery: synthetic report queued to session=${last.sessionID}, with no presentation model request. Queue acknowledgement does not certify UI display.\n`
      : '\nReport delivery: no appended synthetic report was confirmed. Inspect the original JSON in the review session or private report/draft diagnostics when available.\n';
    if (settings.returnReport === 'full') {
      body += `\nReport data:\n<azpr_report_data>\n${report.replaceAll('</azpr_report_data>', '&lt;/azpr_report_data&gt;')}\n</azpr_report_data>\n`;
    } else {
      body += '\nNo report body is enclosed in this receipt. Inspect the queued report or saved diagnostic Markdown; original model JSON is separate from the rendered report. Do not resume a reviewer session to retrieve it.\n';
    }
  } else body += '\nNo report body is enclosed in this receipt.\n';
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
