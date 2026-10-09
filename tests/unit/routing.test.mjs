import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/core/routing.js';
import { settings } from './helpers.mjs';

const cand = (over = {}) => ({ grader: 'psa', graderOptions: ['psa'], number: '01234567', confidence: 0.89, source: 'ocr', evidence: [], ...over });

test('no candidates -> none', () => {
  assert.equal(decide([], settings(), []), 'none');
  assert.equal(decide(undefined, settings(), undefined), 'none');
});

test('single confident candidate with a grader -> auto-open', () => {
  assert.equal(decide([cand()], settings(), []), 'auto-open');
  assert.equal(decide([cand({ confidence: 0.8 })], settings(), []), 'auto-open');
});

test('never auto-open below .80', () => {
  assert.equal(decide([cand({ confidence: 0.79 })], settings(), []), 'confirm');
  assert.equal(decide([cand({ confidence: 0.3 })], settings(), []), 'confirm');
});

test('never auto-open with grader:null, even at high confidence', () => {
  assert.equal(decide([cand({ grader: null, graderOptions: ['cgc-comics', 'cgc-cards', 'psa'], number: '5012345678', confidence: 0.99 })], settings(), []), 'confirm');
});

test('autoOpen setting off (Always ask) -> confirm', () => {
  assert.equal(decide([cand()], settings({ autoOpen: false }), []), 'confirm');
  assert.equal(decide([cand()], null, []), 'confirm');
});

test('a competing different number >= .50 blocks auto-open; below .50 does not', () => {
  assert.equal(decide([cand(), cand({ number: '87654321', confidence: 0.5 })], settings(), []), 'confirm');
  assert.equal(decide([cand(), cand({ number: '87654321', confidence: 0.49 })], settings(), []), 'auto-open');
});

test('qr-untrusted-host warning blocks auto-open; other warnings do not', () => {
  assert.equal(decide([cand()], settings(), [{ code: 'qr-untrusted-host', detail: 'evil.example' }]), 'confirm');
  assert.equal(decide([cand()], settings(), [{ code: 'low-resolution' }]), 'auto-open');
  assert.equal(decide([cand()], settings(), [{ code: 'ocr-unavailable' }]), 'auto-open');
});

test('manual source never auto-opens', () => {
  assert.equal(decide([cand({ source: 'manual', confidence: 1 })], settings(), []), 'confirm');
});

test('a top candidate whose number does not fit its grader never auto-opens', () => {
  assert.equal(decide([cand({ number: '1401036622258' })], settings(), []), 'confirm');
});

test('decide uses the highest-confidence candidate even if the array is unsorted', () => {
  assert.equal(decide([cand({ number: '87654321', confidence: 0.4 }), cand()], settings(), []), 'auto-open');
});
