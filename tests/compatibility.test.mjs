import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseReviewRequest } from '../src/output.mjs';
import { validateSettings } from '../src/config.mjs';

test('request parser preserves Unicode, multiline text, quotes, and literal metacharacters',()=>{
  const url='https://dev.azure.com/org/project/_git/repo/pullrequest/12';
  const context='\u91cd\u9ede\u6aa2\u67e5 API "compatibility"\n@../doc !`literal` ${value} \'single quotes\'\n';
  assert.deepEqual(parseReviewRequest(`${url} ${context}`),{request:`${url} ${context}`,prUrl:url,userContext:context,urlIdentity:{organization:'org',project:'project',repository:'repo'}});
  assert.equal(parseReviewRequest(url).userContext,'');
  for(const raw of ['', 'not-a-url instructions',url.replace('https:','http:'),url.replace('https://','https://user:password@'),url+'\0',url+' '+'x'.repeat(16000)]) assert.throws(()=>parseReviewRequest(raw));
});
test('URL identity separates organization, project and repository without guessing unknown layouts',()=>{
  const cases=[
    ['https://dev.azure.com/team/Project%20A/_git/Repo%2BOne/pullrequest/12/',{organization:'team',project:'Project A',repository:'Repo+One'}],
    ['https://team.visualstudio.com/Project%20A/_git/Repo%2520One/pullrequest/12',{organization:'team',project:'Project A',repository:'Repo%20One'}],
  ];
  for(const [url,expected] of cases) {
    const raw=url+' Treat the organization as the project.';
    const parsed=parseReviewRequest(raw);
    assert.deepEqual(parsed.urlIdentity,expected);
    assert.equal(parsed.request,raw);assert.equal(parsed.prUrl,url);
  }
  for(const url of [
    'https://server.example/tfs/collection/project/_git/repo/pullrequest/12',
    'https://dev.azure.com/org/_git/repo/pullrequest/12',
    'https://dev.azure.com/org/%ZZ/_git/repo/pullrequest/12',
    'https://dev.azure.com/org/project/_git/repo%0Aname/pullrequest/12',
  ]) {
    const parsed=parseReviewRequest(url);
    assert.equal(parsed.urlIdentity,undefined);assert.equal(parsed.prUrl,url);
  }
});
test('removed settings cannot configure a V1 transport or an MCP mapping',async()=>{
  const s=JSON.parse(await readFile(new URL('../config/settings.example.json',import.meta.url),'utf8'));
  s.models={review:{functional:'fixture/a',risk:'fixture/b',verifier:'fixture/c'}};
  for(const key of ['azure','structuredOutput','steps','maxStageCharacters']) {
    assert.throws(()=>validateSettings({...s,[key]:false}),/Unknown setting/);
  }
});
test('production source contains no fixed MCP tool names or dispatcher whitelist',async()=>{
  for(const file of ['runtime.mjs','comments.mjs','config.mjs','output.mjs']){
    const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/SUPPORTED_READ_TOOLS|READ_ACTIONS|repo_get_pull_request|repo_pull_request_thread|commentTools|CommentGate/);
  }
});
