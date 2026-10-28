import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {hasCommand} from './commands.mjs';

describe('Harness command matching for Trusted Acceptance',()=>{
  describe('given only the architecture variants of check and test',()=>{
    const commands=[['pnpm','run','check:architecture'],['pnpm','run','test:architecture']];
    it('when check is required then the command is not found',()=>assert.equal(hasCommand(commands,['pnpm','run','check']),false));
    it('when test is required then the command is not found',()=>assert.equal(hasCommand(commands,['pnpm','run','test']),false));
  });
  describe('given build-storybook without build',()=>{
    it('when build is required then the command is not found',()=>assert.equal(hasCommand([['pnpm','run','build-storybook']],['pnpm','run','build']),false));
  });
  describe('given the script joined into one argument',()=>{
    it('when the same words are required as separate arguments then the command is not found',()=>assert.equal(hasCommand([['pnpm run check']],['pnpm','run','check']),false));
  });
  describe('given a registered command followed by its own arguments',()=>{
    it('when the script is required then the command is found',()=>assert.equal(hasCommand([['pnpm','run','build','--outDir','node_modules/.harness/dist']],['pnpm','run','build']),true));
  });
});
