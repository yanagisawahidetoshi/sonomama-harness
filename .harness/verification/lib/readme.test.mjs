import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {assertAuthSection,markdownSection} from './readme.mjs';

const readme=auth=>['# App','','## 前提','','未決定のこと、Amazon Cognito、ADR-0007の話は別の節に書いてある。','',...(auth===undefined?[]:['## 認証','',auth,'']),'## Harness','','Harnessの説明。',''].join('\n');
const decided='認証ProviderはAmazon Cognito（User Pool）を使う（[ADR-0007](../../docs/adr/0007-aws-and-cognito.md)）。\nProvider固有のSDK・gemと、アプリケーション層をCognito固有実装に結びつける変更は、承認なしに導入しない。';

describe('Auth section of an app README for Trusted Acceptance',()=>{
  describe('given a README with sections',()=>{
    it('when the 認証 section is read then only its body up to the next heading is returned',()=>assert.equal(markdownSection(readme('本文'),'認証'),'本文'));
    it('when the section is missing then nothing is returned',()=>assert.equal(markdownSection(readme(),'認証'),undefined));
  });
  describe('given the 認証 section states the ADR-0007 decision',()=>{
    it('when checked then it passes',()=>assert.doesNotThrow(()=>assertAuthSection(readme(decided))));
  });
  describe('given the 認証 section does not state the decision even though other sections mention its words',()=>{
    for(const [name,auth] of [
      ['the section is missing',undefined],
      ['the provider is still undecided','認証Provider（Cognito / Firebase Auth等）は未決定。\nProvider固有のSDKは承認なしに導入しない。'],
      ['Amazon Cognito is not named',decided.replace('Amazon Cognito（User Pool）','外部の認証基盤')],
      ['ADR-0007 is not linked',decided.replace('（[ADR-0007](../../docs/adr/0007-aws-and-cognito.md)）','')],
      ['undecided remains next to the decision',`${decided}\n細部は未決定。`],
      ['the policy against provider specific code without approval is missing','認証ProviderはAmazon Cognito（User Pool）を使う（[ADR-0007](../../docs/adr/0007-aws-and-cognito.md)）。'],
    ]){
      it(`when ${name} then it fails`,()=>assert.throws(()=>assertAuthSection(readme(auth))));
    }
  });
});
